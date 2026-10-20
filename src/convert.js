// Converts some of the bot wallet's SOL into USDC (through Jupiter).
// Run: node src/convert.js   (or double-click CONVERT-TO-USDC.bat)

import { readFileSync, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { Rpc } from './rpc.js';
import { loadBotWallet } from './solana/keypair.js';
import { quoteSolForUsdc, swapSolForUsdc } from './live/swap.js';
import { getUsdcBalance } from './live/balances.js';

const cfg = JSON.parse(readFileSync(existsSync('config.json') ? 'config.json' : 'config.example.json', 'utf8'));
const rpc = new Rpc(process.env.RPC_URL ?? cfg.rpcUrl);
const KEEP_SOL = Math.max(0.05, cfg.reserveSol ?? 0.05); // always left for network fees

const rl = createInterface({ input: process.stdin, terminal: false });
const queue = []; const waiters = [];
rl.on('line', (l) => (waiters.length ? waiters.shift()(l) : queue.push(l)));
rl.on('close', () => { while (waiters.length) waiters.shift()(''); });
const ask = (q) => { process.stdout.write(q); return queue.length ? Promise.resolve(queue.shift()) : new Promise((r) => waiters.push(r)); };

const wallet = loadBotWallet();
let sol, usdc;
try {
  sol = (await rpc.getBalance(wallet.publicKey)) / 1e9;
  usdc = await getUsdcBalance(rpc, wallet.publicKey);
} catch (e) {
  console.log(`\n  Can't reach Solana (${e.cause?.code ?? e.message}). Run SETUP and paste your Helius link.\n`); process.exit(1);
}
const { lamports: per1 } = await quoteSolForUsdc(1);
const solUsd = 1e9 / per1;
const spendable = Math.max(0, sol - KEEP_SOL);
const maxUsd = Math.floor(spendable * solUsd * 0.98);

console.log(`\n  Bot wallet ${wallet.publicKey}`);
console.log(`  Now: ${sol.toFixed(4)} SOL (about $${(sol * solUsd).toFixed(2)}) and $${usdc.toFixed(2)} USDC`);
console.log(`  SOL price: about $${solUsd.toFixed(2)}`);
console.log(`  ${KEEP_SOL} SOL is always kept for network fees, so you can convert up to about $${maxUsd}.\n`);
if (maxUsd < 1) { console.log('  Not enough SOL to convert. Send more SOL to the bot wallet first.\n'); process.exit(0); }

const raw = (await ask(`  How many dollars of USDC do you want? (e.g. 25, max ${maxUsd}): $`)).trim().replace(/^\$/, '');
const amount = Math.round(Number(raw) * 100) / 100;
if (!(amount > 0)) { console.log('\n  Cancelled.\n'); process.exit(0); }
if (amount > maxUsd) { console.log(`\n  That's more than the bot can convert while keeping ${KEEP_SOL} SOL for fees (max $${maxUsd}). Send more SOL first.\n`); process.exit(0); }

const { maxLamports } = await quoteSolForUsdc(amount);
console.log(`\n  This swaps up to ${(maxLamports / 1e9).toFixed(4)} SOL for $${amount} USDC.`);
const ok = (await ask('  Type YES to do it: ')).trim();
if (ok.toUpperCase() !== 'YES') { console.log('\n  Cancelled. Nothing was sent.\n'); process.exit(0); }

try {
  const r = await swapSolForUsdc({ rpc, wallet, usdcAmount: amount, log: (m) => console.log('  ' + m.trim()) });
  const after = await getUsdcBalance(rpc, wallet.publicKey);
  console.log(`\n  Done. The bot wallet now holds $${after.toFixed(2)} USDC.`);
  console.log(`  Proof: https://solscan.io/tx/${r.signature}\n`);
} catch (e) {
  console.log(`\n  The swap didn't go through: ${e.message.split('\n')[0]}`);
  console.log('  Nothing was lost. Try again in a minute, or with a slightly smaller amount.\n');
}
rl.close();
