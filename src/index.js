// PACKWARS engine. Runs two kinds of duel side by side and hosts the website:
//   - holder duels: creator fees buy two packs, two 1%+ holders are drawn
//   - deposit duels (the arena): players buy the same pack, get matched, winner takes both

import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Arena, ArenaError } from './arena/arena.js';
import { JsonState } from './arena/state.js';
import { findUsdcAccount, isWalletAddress } from './arena/payments.js';
import { Rpc } from './rpc.js';
import { Store } from './store.js';
import { runDuel } from './duel.js';
import { MockPackOpener } from './packs/mock.js';
import { LivePackOpener } from './packs/live.js';
import { makeAnnouncer } from './announce.js';
import { getMachine, loadCatalog } from './packs/catalog.js';
import { loadMachineCards } from './packs/cards.js';
import { loadBotWallet } from './solana/keypair.js';
import { claimFees } from './live/fees.js';
import { quoteSolForUsdc, swapSolForUsdc } from './live/swap.js';
import { getUsdcBalance } from './live/balances.js';
import { refreshLedger, totals } from './live/ledger.js';

const cfgPath = process.argv[2] ?? 'config.json';
if (!existsSync(cfgPath)) {
  console.error(`No ${cfgPath}. Copy config.example.json to config.json and fill it in.`);
  process.exit(1);
}
const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
if (process.env.PULLDUEL_MODE) cfg.mode = process.env.PULLDUEL_MODE; // START-LIVE / Railway set this

// Hosting (Railway etc.): DATA_DIR is a persistent folder (a Railway Volume). Duels, deposits and the
// settings saved from /admin live there, so they survive restarts and redeploys.
const DATA_DIR = process.env.DATA_DIR || null;
const SETTINGS_FILE = DATA_DIR ? `${DATA_DIR.replace(/[\\/]$/, '')}/settings.json` : null;
if (DATA_DIR) {
  mkdirSync(DATA_DIR, { recursive: true });
  cfg.dataFile = `${DATA_DIR}/state.json`;
  cfg.arena = { ...(cfg.arena ?? {}), dataFile: `${DATA_DIR}/arena.json` };
  if (existsSync(SETTINGS_FILE)) Object.assign(cfg, JSON.parse(readFileSync(SETTINGS_FILE, 'utf8')));
}
if (process.env.ADMIN_PASSWORD) cfg.adminPassword = process.env.ADMIN_PASSWORD;
const rpc = new Rpc(process.env.RPC_URL ?? cfg.rpcUrl);
const store = new Store(cfg.dataFile ?? 'data/state.json');
const machine = await getMachine(cfg.pack ?? 'pokemon_50');
cfg.packTier = machine.code;
const packArt = (m) => (cfg.officialPackArt ? m.imageUrl ?? null : null);
const packInfo = { code: machine.code, name: machine.name, priceUsd: machine.priceUsd, buybackPct: machine.buybackPct, tiers: machine.tiers, imageUrl: packArt(machine) };
cfg.packInfo = { code: machine.code, name: machine.name, priceUsd: machine.priceUsd, imageUrl: packArt(machine) };
const live = cfg.mode === 'live';

let opener, wallet = null;
if (live) {
  wallet = loadBotWallet();
  cfg.feeWallet = wallet.publicKey;
  opener = new LivePackOpener({ rpc, wallet, machine, network: cfg.gachaNetwork ?? 'mainnet' });
  console.log(`LIVE MODE. Bot wallet ${wallet.publicKey}. Real packs will be bought and real cards sent.`);
} else {
  const pool = await loadMachineCards(machine.code);
  console.log(pool
    ? `Test mode: drawing real cards from the ${machine.name} pool (${pool.cards.length} cards)`
    : 'Test mode: card pool unavailable, using made-up cards (no photos)');
  opener = new MockPackOpener({ machine, pool });
}
const announce = makeAnnouncer();
// Holder duels run only once a real coin is set (from SETUP or the /admin page).
const holderOn = () => cfg.holderDuels?.enabled !== false && isWalletAddress(cfg.mint);

// Admin password for the /admin page. Made once and saved in config.json.
const SAVED_KEYS = ['mint', 'name', 'exclude', 'holderDuels', 'buyUrl'];
function saveConfig() {
  if (SETTINGS_FILE) {
    const out = {}; for (const k of SAVED_KEYS) out[k] = cfg[k];
    if (!process.env.ADMIN_PASSWORD) out.adminPassword = cfg.adminPassword;
    writeFileSync(SETTINGS_FILE, JSON.stringify(out, null, 2) + '\n');
    return;
  }
  const onDisk = JSON.parse(readFileSync(cfgPath, 'utf8'));
  for (const k of [...SAVED_KEYS, 'adminPassword']) onDisk[k] = cfg[k];
  writeFileSync(cfgPath, JSON.stringify(onDisk, null, 2) + '\n');
}
if (!cfg.adminPassword) {
  cfg.adminPassword = randomBytes(9).toString('base64url');
  try { saveConfig(); } catch {}
}

// ---------- deposit duels ----------
let arena = null;
if (cfg.arena?.enabled !== false) {
  // "packs": "all" offers every live pack machine; or list codes to offer only some.
  const allMode = !cfg.arena.packs || cfg.arena.packs === 'all';
  const catalog = await loadCatalog();
  const machines = new Map();
  const codes = allMode ? catalog.machines.map((m) => m.code) : cfg.arena.packs;
  for (const code of codes) machines.set(code, catalog.machines.find((m) => m.code === code) ?? await getMachine(code));
  cfg.arena.packs = codes;
  if (allMode) {
    // New packs appear and old ones retire: refresh the list every hour.
    setInterval(async () => {
      const fresh = await loadCatalog();
      if (fresh.source !== 'live') return;
      for (const m of fresh.machines) machines.set(m.code, m);
      cfg.arena.packs = fresh.machines.map((m) => m.code);
    }, 60 * 60_000);
  }
  let arenaOpener = opener;
  if (!live) {
    // Test mode: real cards drawn from each pack's pool, loaded the first time that pack opens.
    const mocks = new Map();
    const mockFor = async (pack) => {
      if (!mocks.has(pack)) mocks.set(pack, new MockPackOpener({ machine: machines.get(pack), pool: await loadMachineCards(pack) }));
      return mocks.get(pack);
    };
    arenaOpener = { openPack: async ({ forWallet, pack }) => (await mockFor(pack)).openPack({ forWallet }), transferCard: (c, to) => opener.transferCard(c, to) };
  }
  // Deposits land in the duel wallet's USDC account. Make sure it exists.
  let botUsdc = null;
  if (live) {
    let acct = await findUsdcAccount(rpc, wallet.publicKey);
    if (!acct) {
      console.log('[arena] setting up the bot wallet USDC account (tiny SOL->USDC swap)');
      try {
        await swapSolForUsdc({ rpc, wallet, usdcAmount: 0.1 });
        acct = await findUsdcAccount(rpc, wallet.publicKey);
      } catch (err) {
        console.error(`\nCould not set up the bot wallet's USDC account: ${err.message.split('\n')[0]}`);
        console.error(`Most likely the bot wallet has no SOL yet. Send about 0.1 SOL to ${wallet.publicKey} and start again.\n`);
        process.exit(1);
      }
    }
    if (!acct) { console.error('Could not find or create the bot wallet USDC account. Try again in a minute.'); process.exit(1); }
    botUsdc = acct.address;
  }
  arena = new Arena({
    cfg, rpc, wallet, botUsdc, opener: arenaOpener, machines, announce, mock: !live,
    botWalletAddress: 'TestBot1111111111111111111111111111111111111',
    state: new JsonState(cfg.arena.dataFile ?? 'data/arena.json'),
  });
  console.log(`Deposit duels on ${machines.size} packs (${catalog.source} list)`);
  const arenaLoop = () => arena.tick().catch((e) => console.error(`[arena] ${e.message}`));
  arenaLoop();
  setInterval(arenaLoop, (cfg.arena.tickSeconds ?? 3) * 1000);
}

const LAMPORTS = 1_000_000_000;
let busy = false;
let status = 'starting';
let lastClaimAt = 0;

// SOL price, for showing the fund and sizing swaps. Falls back to the last good
// price, then to cfg.solUsdFallback.
let lastSolUsd = null;
async function getSolUsd() {
  try {
    const res = await fetch('https://lite-api.jup.ag/price/v3?ids=So11111111111111111111111111111111111111112', { signal: AbortSignal.timeout(5000) });
    const body = await res.json();
    const p = Number(body?.So11111111111111111111111111111111111111112?.usdPrice);
    if (p > 0) return (lastSolUsd = p);
  } catch { /* use fallback */ }
  if (lastSolUsd) return lastSolUsd;
  if (cfg.solUsdFallback) return cfg.solUsdFallback;
  throw new Error('Could not get SOL price. Set "solUsdFallback" in config.');
}

// Test mode: no wallet, duel on the timer.
async function mockFund() {
  if (!cfg.feeWallet) return { ready: true, balanceSol: null };
  const balanceSol = (await rpc.getBalance(cfg.feeWallet)) / LAMPORTS;
  const solUsd = await getSolUsd();
  const need = (machine.priceUsd * 2) / solUsd + (cfg.reserveSol ?? 0.05);
  return { ready: balanceSol >= need, balanceSol, needSol: need, solUsd };
}

// Live mode: claim fees, then make sure the bot holds enough USDC for two packs.
async function liveFund() {
  const everyMs = (cfg.fees?.claimEveryMinutes ?? 10) * 60_000;
  if (cfg.fees?.claim !== false && Date.now() - lastClaimAt > everyMs) {
    lastClaimAt = Date.now();
    try {
      const c = await claimFees({ rpc, wallet, cfg });
      if (c.claimed) console.log(`[fees] claimed creator fees ${c.signature}`);
      else if (c.skipped && process.env.DEBUG) console.log(`[fees] nothing claimed: ${c.skipped}`);
    } catch (err) { console.warn(`[fees] claim failed: ${err.message}`); }
  }

  const reserve = cfg.reserveSol ?? 0.05;
  const needUsdc = machine.priceUsd * 2;
  const [lamports, usdc, solUsd] = await Promise.all([rpc.getBalance(wallet.publicKey), getUsdcBalance(rpc, wallet.publicKey), getSolUsd()]);
  const spendableSol = Math.max(0, lamports / LAMPORTS - reserve);
  const fund = { balanceSol: spendableSol + usdc / solUsd, needSol: needUsdc / solUsd, usdc, sol: lamports / LAMPORTS, solUsd };
  if (usdc >= needUsdc) return { ready: true, ...fund };

  // Not enough USDC yet: swap SOL for the shortfall if the SOL covers it.
  const short = Math.ceil((needUsdc - usdc) * 100) / 100;
  if (spendableSol * solUsd < short * 1.01) return { ready: false, ...fund };
  const { maxLamports } = await quoteSolForUsdc(short);
  if (maxLamports / LAMPORTS > spendableSol) return { ready: false, ...fund };
  console.log(`[swap] buying ${short} USDC with up to ${(maxLamports / LAMPORTS).toFixed(4)} SOL`);
  const sw = await swapSolForUsdc({ rpc, wallet, usdcAmount: short });
  console.log(`[swap] done ${sw.signature}`);
  const after = await getUsdcBalance(rpc, wallet.publicKey);
  return { ready: after >= needUsdc, ...fund, usdc: after };
}

function duelsToday() {
  const today = new Date().toISOString().slice(0, 10);
  return store.state.rounds.filter((r) => r.at?.startsWith(today)).length;
}

// What the engine knows it did, so the ledger can tell its own moves from anyone else's.
function knownActions() {
  const packPays = new Set(), winners = [];
  const sides = (r) => [r.a, r.b].filter(Boolean);
  for (const r of store.state.rounds) {
    for (const s of sides(r)) if (s.openTx) packPays.add(s.openTx);
    for (const p of r.payouts ?? []) winners.push(`${p.nftMint}:${p.to}`);
  }
  const f = store.state.inflight;
  if (f) for (const s of sides(f)) if (s.pack?.paySig) packPays.add(s.pack.paySig);
  for (const p of f?.payouts ?? []) winners.push(`${p.card.nftMint}:${p.to}`);
  let deposits = new Set(), refunds = new Set();
  if (arena) {
    const k = arena.knownActions();
    winners.push(...k.winners);
    for (const x of k.packPays) packPays.add(x);
    deposits = k.deposits; refunds = k.refunds;
  }
  return { packPays, winners, deposits, refunds };
}

let lastLedgerAt = 0;
async function updateLedger() {
  if (!live || Date.now() - lastLedgerAt < (cfg.ledgerEveryMinutes ?? 5) * 60_000) return;
  lastLedgerAt = Date.now();
  try {
    store.state.ledger = await refreshLedger({ rpc, owner: wallet.publicKey, ledger: store.state.ledger, known: knownActions() });
  } catch (err) { console.warn(`[ledger] ${err.message}`); }
}

async function tick() {
  if (busy) return;
  if (!holderOn()) { if (live) { await updateLedger(); store.save(); } return; }
  busy = true;
  try {
    // Finish any duel that was interrupted before starting a new one.
    if (store.state.inflight) {
      status = 'finishing a duel';
      await runDuel({ rpc, cfg, opener, store, announce });
    }
    const f = live ? await liveFund() : await mockFund();
    store.state.fund = { ...f, checkedAt: new Date().toISOString() };
    if (!f.ready) {
      status = f.needSol ? `waiting for fees (${f.balanceSol?.toFixed(3)} / ${f.needSol?.toFixed(3)} SOL)` : 'waiting for fees';
      return;
    }
    const cap = cfg.maxDuelsPerDay ?? 48;
    if (live && duelsToday() >= cap) { status = `daily limit reached (${cap})`; return; }
    status = 'dueling';
    await runDuel({ rpc, cfg, opener, store, announce });
    status = 'idle';
  } catch (err) {
    status = store.state.inflight ? `retrying: ${err.message}` : `error: ${err.message}`;
    console.error(`[tick] ${err.message}`);
  } finally {
    await updateLedger();
    store.save();
    busy = false;
  }
}

function walletInfo() {
  if (!live) return null;
  const entries = store.state.ledger?.entries ?? [];
  return {
    address: wallet.publicKey,
    feeProofUrl: cfg.feeProofUrl ?? null,
    balance: { sol: store.state.fund?.sol ?? null, usdc: store.state.fund?.usdc ?? null },
    totals: totals(entries),
    recent: entries.slice(0, 40),
    updatedAt: store.state.ledger?.updatedAt ?? null,
  };
}

// ---------- website + API ----------
const SITE_DIR = resolve(fileURLToPath(new URL('../site/', import.meta.url)));
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json', '.txt': 'text/plain' };
const hits = new Map(); // simple per-IP rate limit for player actions
const adminTries = new Map();
const coinBuyUrl = () => cfg.buyUrl || (isWalletAddress(cfg.mint) ? `https://pump.fun/coin/${cfg.mint}` : null);

function holderState() {
  const { rounds, leaderboard, lastSnapshot, fund, round } = store.state;
  return {
    enabled: holderOn(), pack: packInfo, round, fund, lastSnapshot, leaderboard, rounds: rounds.slice(0, 50),
    status, minHoldingPct: cfg.minHoldingPct,
    inflight: store.state.inflight ? { round: store.state.inflight.round, stage: store.state.inflight.stage } : null,
  };
}

async function readBody(req) {
  let body = '';
  for await (const chunk of req) { body += chunk; if (body.length > 64_000) throw new ArenaError('Request too large.', 413); }
  try { return JSON.parse(body || '{}'); } catch { throw new ArenaError('Bad JSON.'); }
}

const port = Number(process.env.PORT ?? cfg.port ?? 8787);
createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const send = (code, obj) => { res.statusCode = code; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(obj)); };
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', 'content-type');
  if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
  try {
    if (url.pathname === '/api/state' && req.method === 'GET') {
      return send(200, { name: cfg.name, mint: isWalletAddress(cfg.mint) ? cfg.mint : null, buyUrl: coinBuyUrl(), mode: cfg.mode, wallet: walletInfo(), holder: holderState(), arena: arena?.publicState() ?? null });
    }
    if (url.pathname === '/api/me' && req.method === 'GET') {
      if (!arena) return send(404, { error: 'Deposit duels are off.' });
      return send(200, arena.forWallet(url.searchParams.get('wallet') ?? ''));
    }
    if (url.pathname.startsWith('/api/round/')) {
      const n = Number(url.pathname.split('/').pop());
      const r = store.state.rounds.find((x) => x.round === n);
      return send(r ? 200 : 404, r ?? { error: 'not found' });
    }
    if (req.method === 'POST' && ['/api/join', '/api/confirm', '/api/cancel'].includes(url.pathname)) {
      if (!arena) return send(404, { error: 'Deposit duels are off.' });
      const ip = req.headers['cf-connecting-ip'] ?? req.headers['x-forwarded-for']?.split(',')[0] ?? req.socket.remoteAddress;
      const now = Date.now(), list = (hits.get(ip) ?? []).filter((t) => now - t < 60_000);
      if (list.length >= 30) return send(429, { error: 'Too many requests, slow down a little.' });
      list.push(now); hits.set(ip, list);
      const body = await readBody(req);
      const country = req.headers[(cfg.arena.countryHeader ?? 'cf-ipcountry').toLowerCase()];
      if (url.pathname === '/api/join') return send(200, await arena.join({ wallet: body.wallet, pack: body.pack, ageConfirmed: body.ageConfirmed === true, country }));
      if (url.pathname === '/api/confirm') return send(200, await arena.confirm({ seatId: body.seatId, token: body.token, signedTransaction: body.signedTransaction }));
      return send(200, await arena.cancel({ seatId: body.seatId, token: body.token }));
    }
    if (url.pathname === '/admin' && req.method === 'GET') {
      const page = await readFile(resolve(SITE_DIR, 'admin.html')).catch(() => null);
      res.setHeader('content-type', 'text/html; charset=utf-8'); res.setHeader('cache-control', 'no-store');
      return res.end(page ?? 'admin page missing');
    }
    if (url.pathname === '/api/admin/coin' && req.method === 'POST') {
      const ip = req.headers['cf-connecting-ip'] ?? req.socket.remoteAddress;
      const now = Date.now(), tries = (adminTries.get(ip) ?? []).filter((t) => now - t < 15 * 60_000);
      if (tries.length >= 10) return send(429, { error: 'Too many attempts. Wait 15 minutes.' });
      const body = await readBody(req);
      const given = Buffer.from(String(body.password ?? '')), want = Buffer.from(String(cfg.adminPassword));
      if (given.length !== want.length || !timingSafeEqual(given, want)) { tries.push(now); adminTries.set(ip, tries); return send(401, { error: 'Wrong admin password.' }); }
      if (body.check) return send(200, { ok: true, mint: isWalletAddress(cfg.mint) ? cfg.mint : '', name: cfg.name, buyUrl: cfg.buyUrl ?? '', holderDuels: holderOn() });
      const mint = String(body.mint ?? '').trim();
      if (mint && !isWalletAddress(mint)) return send(400, { error: 'That CA is not a valid Solana address.' });
      if (mint) { cfg.mint = mint; cfg.holderDuels = { ...(cfg.holderDuels ?? {}), enabled: true }; store.state.lastSnapshot = null; }
      const name = String(body.name ?? '').trim().slice(0, 16);
      if (name) cfg.name = name.startsWith('$') ? name : `$${name}`;
      const dev = String(body.devWallet ?? '').trim();
      if (dev) {
        if (!isWalletAddress(dev)) return send(400, { error: 'The dev wallet is not a valid Solana address.' });
        cfg.exclude = [...new Set([...(cfg.exclude ?? []).filter(isWalletAddress), dev])];
      }
      if (typeof body.buyUrl === 'string') cfg.buyUrl = /^https:\/\/\S+$/.test(body.buyUrl.trim()) ? body.buyUrl.trim() : '';
      if (body.holderDuels === false) cfg.holderDuels = { ...(cfg.holderDuels ?? {}), enabled: false };
      saveConfig();
      console.log(`[admin] coin settings updated: ${cfg.name} ${cfg.mint}`);
      if (holderOn()) setTimeout(tick, 500);
      return send(200, { ok: true, mint: cfg.mint, name: cfg.name, buyUrl: coinBuyUrl(), holderDuels: holderOn() });
    }
    if (url.pathname.startsWith('/api/')) return send(404, { error: 'not found' });

    // static site
    let rel = decodeURIComponent(url.pathname);
    if (rel.endsWith('/')) rel += 'index.html';
    const file = resolve(SITE_DIR, '.' + rel);
    const inside = relative(SITE_DIR, file);
    if (!inside || inside.startsWith('..') || isAbsolute(inside)) return send(403, { error: 'forbidden' });
    const data = await readFile(file).catch(() => null);
    if (!data) { res.statusCode = 404; return res.end('Not found'); }
    res.setHeader('content-type', TYPES[extname(file)] ?? 'application/octet-stream');
    return res.end(data);
  } catch (err) {
    if (err instanceof ArenaError) return send(err.status, { error: err.message });
    console.error(`[api] ${err.message}`);
    return send(500, { error: err.retryable ? 'The pack machine is busy. Try again in a minute.' : 'Something went wrong on our side. Try again.' });
  }
}).listen(port, () => console.log(`Site + API on http://localhost:${port}`));

console.log(`PACKWARS | ${cfg.name} | mint ${cfg.mint} | mode ${cfg.mode} | min ${cfg.minHoldingPct}%`);
console.log(`Pack: ${machine.name} (${machine.code}) $${machine.priceUsd} each, ${machine.buybackPct}% buyback [${machine.source} list]`);
tick();
setInterval(tick, (cfg.pollSeconds ?? 60) * 1000);
console.log(process.env.ADMIN_PASSWORD ? `Admin page: /admin (password = your ADMIN_PASSWORD variable)` : `Admin page: http://localhost:${port}/admin   password: ${cfg.adminPassword}  (also in config.json as "adminPassword")`);
