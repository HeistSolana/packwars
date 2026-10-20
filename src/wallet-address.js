// Prints the bot wallet address and saves it to BOT-WALLET-ADDRESS.txt (the address is safe to share).
import { writeFileSync } from 'node:fs';
import { loadBotWallet } from './solana/keypair.js';
const w = loadBotWallet();
writeFileSync('BOT-WALLET-ADDRESS.txt', `Bot wallet address (safe to share, send SOL here):\r\n${w.publicKey}\r\n`);
console.log(`\n  Bot wallet address: ${w.publicKey}\n  (saved in BOT-WALLET-ADDRESS.txt)`);
