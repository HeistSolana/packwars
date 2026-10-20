// The bot's wallet. Same kind of key Phantom uses; the bot just signs in code.
//
// Loaded from BOT_WALLET_SECRET (a base58 secret key, the format Phantom's
// "Export private key" gives, or a JSON byte array like Solana CLI keyfiles),
// or from the file named in BOT_WALLET_FILE.

import { createPrivateKey, createPublicKey, generateKeyPairSync, sign as edSign, verify as edVerify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as bs58 from './base58.js';

const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

function fromSeed(seed) {
  const key = createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, Buffer.from(seed)]), format: 'der', type: 'pkcs8' });
  const pub = createPublicKey(key).export({ format: 'der', type: 'spki' }).subarray(-32);
  return {
    publicKey: bs58.encode(pub),
    publicKeyBytes: Uint8Array.from(pub),
    sign: (message) => Uint8Array.from(edSign(null, Buffer.from(message), key)),
    secretBase58: () => bs58.encode(Buffer.concat([Buffer.from(seed), pub])),
  };
}

export function keypairFromSecret(secret) {
  const s = String(secret).trim();
  const bytes = s.startsWith('[') ? Uint8Array.from(JSON.parse(s)) : bs58.decode(s);
  if (bytes.length !== 64 && bytes.length !== 32) throw new Error(`Secret key must be 64 bytes (got ${bytes.length}).`);
  const kp = fromSeed(bytes.subarray(0, 32));
  if (bytes.length === 64 && bs58.encode(bytes.subarray(32)) !== kp.publicKey) {
    throw new Error('Secret key is corrupted: its public half does not match.');
  }
  return kp;
}

export function generateKeypair() {
  const { privateKey } = generateKeyPairSync('ed25519');
  const der = privateKey.export({ format: 'der', type: 'pkcs8' });
  return fromSeed(der.subarray(-32));
}

export function loadBotWallet() {
  const secret = process.env.BOT_WALLET_SECRET ?? process.env.FEE_WALLET_SECRET;
  if (secret) return keypairFromSecret(secret);
  if (process.env.BOT_WALLET_FILE) return keypairFromSecret(readFileSync(process.env.BOT_WALLET_FILE, 'utf8'));
  throw new Error('No bot wallet. Set BOT_WALLET_SECRET (or BOT_WALLET_FILE). Create one with: npm run wallet:new');
}

export function verify(pubkeyBase58, message, signature) {
  const der = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(bs58.decode(pubkeyBase58))]);
  return edVerify(null, Buffer.from(message), createPublicKey({ key: der, format: 'der', type: 'spki' }), Buffer.from(signature));
}
