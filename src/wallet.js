// npm run wallet:new   -> creates the bot wallet and saves it to bot-wallet.json
// npm run wallet:show  -> shows the bot wallet's address and balances

import { writeFileSync, existsSync, chmodSync, readFileSync } from 'node:fs';
import { generateKeypair, loadBotWallet } from './solana/keypair.js';
import { Rpc } from './rpc.js';
import { getUsdcBalance } from './live/balances.js';

const cmd = process.argv[2];

if (cmd === 'new') {
  const file = process.argv[3] ?? 'bot-wallet.json';
  if (existsSync(file)) {
    console.error(`${file} already exists. Not overwriting it. Move it first if you really want a new wallet.`);
    process.exit(1);
  }
  const kp = generateKeypair();
  writeFileSync(file, kp.secretBase58() + '\n', { mode: 0o600 });
  try { chmodSync(file, 0o600); } catch {}
  console.log(`\nBot wallet created.\n`);
  console.log(`  Address:  ${kp.publicKey}`);
  console.log(`  Saved to: ${file}  (keep this private, never commit it)\n`);
  console.log('Next:');
  console.log(`  1. Run the engine with BOT_WALLET_FILE=${file}  (or put the key in BOT_WALLET_SECRET)`);
  console.log('  2. Send ~0.05 SOL to the address for network fees');
  console.log('  3. Point your coin\'s creator fees at this address (see README: "Fees")');
  console.log('  4. To watch it in Phantom: Add account > Import private key, paste the contents of the file\n');
} else if (cmd === 'show') {
  const kp = loadBotWallet();
  const cfg = existsSync('config.json') ? JSON.parse(readFileSync('config.json', 'utf8')) : {};
  const rpc = new Rpc(process.env.RPC_URL ?? cfg.rpcUrl ?? 'https://api.mainnet-beta.solana.com');
  const sol = (await rpc.getBalance(kp.publicKey)) / 1e9;
  const usdc = await getUsdcBalance(rpc, kp.publicKey);
  console.log(`Bot wallet ${kp.publicKey}\n  SOL  ${sol.toFixed(4)}\n  USDC ${usdc.toFixed(2)}`);
} else {
  console.log('Usage: npm run wallet:new | npm run wallet:show');
}
