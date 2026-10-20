// Asks for the settings that need your accounts and saves them into config.json.
// Run: node src/setup.js   (or double-click SETUP.bat on Windows)

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { stdin, stdout } from 'node:process';
import { isWalletAddress } from './arena/payments.js';

const file = 'config.json';
const cfg = JSON.parse(readFileSync(existsSync(file) ? file : 'config.example.json', 'utf8'));
// Read answers line by line (works the same typed or pasted).
const rl = createInterface({ input: stdin, terminal: false });
const lines = [], waiting = [];
let closed = false;
rl.on('line', (l) => (waiting.length ? waiting.shift()(l) : lines.push(l)));
rl.on('close', () => { closed = true; while (waiting.length) waiting.shift()(''); });
const nextLine = () => (lines.length ? Promise.resolve(lines.shift()) : closed ? Promise.resolve('') : new Promise((r) => waiting.push(r)));
const ask = async (q, current) => {
  stdout.write(`${q}${current ? `\n  (now: ${current}, press Enter to keep)` : ''}\n> `);
  const v = (await nextLine()).trim();
  if (!stdin.isTTY) stdout.write(`${v}\n`);
  return v;
};

console.log('\nPACKWARS setup. Press Enter to skip anything you don\'t have yet.\n');

// 1. Helius RPC
for (;;) {
  const v = await ask('1. Paste your Helius RPC URL (from helius.dev, starts with https://mainnet.helius-rpc.com/?api-key=...)', cfg.rpcUrl?.includes('helius') ? cfg.rpcUrl.replace(/api-key=.*/, 'api-key=…') : '');
  if (!v) break;
  if (!/^https:\/\/\S+$/.test(v)) { console.log('  That does not look like a link. It should start with https://\n'); continue; }
  cfg.rpcUrl = v;
  process.stdout.write('  Checking it works… ');
  try {
    const r = await fetch(v, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getSlot' }), signal: AbortSignal.timeout(10000) });
    const j = await r.json();
    console.log(j.result ? 'works ✓\n' : `got an error: ${j.error?.message ?? r.status}\n`);
  } catch (e) { console.log(`could not connect (${e.message}). Saved anyway, check the link.\n`); }
  break;
}

// 2. Coin (only needed for holder duels)
const mint = await ask('2. Your coin\'s address (mint). Only needed for free holder duels. Skip if the coin isn\'t live yet.', isWalletAddress(cfg.mint) ? cfg.mint : '');
if (mint) {
  if (isWalletAddress(mint)) { cfg.mint = mint; cfg.holderDuels = { ...(cfg.holderDuels ?? {}), enabled: true }; console.log('  Saved. Holder duels switched on.\n'); }
  else console.log('  That is not a valid Solana address. Skipped.\n');
}
const dev = await ask('3. Your dev wallet address, so it is never drawn in holder duels. Skip if not needed yet.', '');
if (dev) {
  if (isWalletAddress(dev)) { cfg.exclude = [...new Set([...(cfg.exclude ?? []).filter((x) => isWalletAddress(x)), dev])]; console.log('  Saved.\n'); }
  else console.log('  That is not a valid Solana address. Skipped.\n');
}
const name = await ask('4. Your coin\'s ticker for the site, e.g. $PULL', cfg.name);
if (name) cfg.name = name.startsWith('$') ? name : `$${name}`;

writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n');
rl.close();
console.log('\nSaved to config.json. You can run SETUP again any time to change these.\n');
