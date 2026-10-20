// npm run preflight  -> dry run of the whole live flow. Builds and SIMULATES every
// transaction against the real network but sends nothing and spends nothing.
//
//   1. bot wallet + balances
//   2. holder snapshot (who is eligible right now)
//   3. creator fee claim
//   4. SOL -> USDC swap for two packs
//   5. paying for a pack (Collector Crypt builds the payment, we simulate it)
//   6. card transfer (only if you pass a card the bot owns: npm run preflight -- <cardMint>)

import { readFileSync, existsSync } from 'node:fs';
import { Rpc } from './rpc.js';
import { loadBotWallet } from './solana/keypair.js';
import { takeSnapshot, short } from './snapshot.js';
import { getMachine } from './packs/catalog.js';
import { claimFees } from './live/fees.js';
import { swapSolForUsdc } from './live/swap.js';
import { getUsdcBalance } from './live/balances.js';
import { LivePackOpener } from './packs/live.js';

const cfg = JSON.parse(readFileSync(existsSync('config.json') ? 'config.json' : 'config.example.json', 'utf8'));
const rpc = new Rpc(process.env.RPC_URL ?? cfg.rpcUrl);
const ok = (m) => console.log(`  ✓ ${m}`);
const warn = (m) => console.log(`  ! ${m}`);
const step = (n, m) => console.log(`\n${n}. ${m}`);
let problems = 0;
const bad = (m) => { problems++; console.log(`  ✗ ${m}`); };

step(1, 'Bot wallet');
let wallet;
try { wallet = loadBotWallet(); ok(`address ${wallet.publicKey}`); }
catch (e) { bad(e.message); process.exit(1); }
const machine = await getMachine(cfg.pack ?? 'pokemon_50');
let sol, usdc;
try {
  sol = (await rpc.getBalance(wallet.publicKey)) / 1e9;
  usdc = await getUsdcBalance(rpc, wallet.publicKey);
} catch (e) {
  bad(`can't reach Solana with your RPC link (${e.cause?.code ?? e.message}).`);
  console.log('    Double-click SETUP and paste your Helius RPC URL, then run the dry run again.');
  process.exit(1);
}
ok(`SOL ${sol.toFixed(4)}, USDC ${usdc.toFixed(2)}`);
ok(`pack ${machine.name} ($${machine.priceUsd}); a duel needs $${machine.priceUsd * 2} USDC`);
if (sol < 0.01) warn('send ~0.05 SOL to the bot wallet for network fees');

step(2, 'Holder snapshot');
const holderOn = cfg.holderDuels?.enabled !== false && !String(cfg.mint).startsWith('PASTE');
if (!holderOn) ok('skipped (holder duels are off until your coin is set up)');
else try {
  const snap = await takeSnapshot(rpc, cfg);
  ok(`${snap.eligible.length} wallets at ${cfg.minHoldingPct ?? 1}%+, ${snap.excluded.length} excluded`);
  for (const h of snap.eligible.slice(0, 8)) console.log(`     ${short(h.wallet)}  ${h.pct.toFixed(2)}%`);
  for (const h of snap.excluded) console.log(`     excluded ${short(h.wallet)}  ${h.pct.toFixed(2)}%  (${h.reason})`);
  if (snap.eligible.length < 2) warn('fewer than 2 eligible holders, duels will wait');
} catch (e) { bad(`snapshot failed: ${e.message}`); }

step(3, 'Creator fee claim');
if (!holderOn) ok('skipped (holder duels are off)');
else if (cfg.fees?.claim === false) ok('claiming is off in config (engine just watches the balance)');
else {
  try {
    const r = await claimFees({ rpc, wallet, cfg, dryRun: true, log: (m) => console.log('  ' + m.trim()) });
    if (r.dryRun) ok('claim transaction simulated OK');
    else warn(`nothing to claim right now (${r.skipped})`);
  } catch (e) { bad(`claim: ${e.message}`); }
}

step(4, 'SOL -> USDC swap');
try {
  // A small test swap proves the route works; the real swaps are sized per duel.
  await swapSolForUsdc({ rpc, wallet, usdcAmount: 1, dryRun: true, log: (m) => console.log('  ' + m.trim()) });
  ok('swap route works (tested with $1)');
} catch (e) { (sol < 0.02 ? warn : bad)(`swap: ${e.message.split('\n')[0]}`); }

step(5, 'Pack payment');
const cheapest = 'pokemon_25';
const testMachine = await getMachine(cheapest).catch(() => machine);
const opener = new LivePackOpener({ rpc, wallet, machine: testMachine, network: cfg.gachaNetwork ?? 'mainnet', dryRun: true, log: (m) => console.log('  ' + m.trim()) });
if (usdc < testMachine.priceUsd) {
  warn(`skipped: the bot wallet holds $${usdc.toFixed(2)} USDC, and Collector Crypt only builds a purchase`);
  console.log(`    for a wallet that can pay. This is expected. In open duels the players' deposits give`);
  console.log(`    the bot the USDC, so this step gets tested for real in your first duel.`);
  console.log(`    To test it now instead: send $${testMachine.priceUsd} USDC to the bot wallet and run DRY-RUN again.`);
} else {
  try { await opener.openPack({ forWallet: wallet.publicKey, pack: cheapest }); }
  catch (e) {
    if (e.dryRun && e.simOk) ok(`pack payment simulated OK (${testMachine.name}); an unpaid pack was reserved and expires on its own`);
    else if (e.dryRun) bad('pack payment would fail');
    else bad(`pack API: ${e.message}`);
  }
}

step(6, 'Card transfer');
const [cardMint, testTo] = process.argv.slice(2);
if (!cardMint || !testTo) ok('skipped (to test: npm run preflight -- <cardMintTheBotOwns> <anyWallet>)');
else {
  try { await opener.transferCard({ nftMint: cardMint }, testTo); }
  catch (e) { bad(`transfer: ${e.message}`); }
}

console.log(problems ? `\n${problems} problem(s) above. Nothing was sent.` : '\nAll checks passed. Nothing was sent.');
