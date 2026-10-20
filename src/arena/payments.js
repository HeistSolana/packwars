// USDC deposits and refunds for open duels.
//
// Deposit: the server builds a USDC transfer from the player's own USDC account
// to the duel wallet's USDC account. The player signs it in their wallet; the
// server checks it's exactly what we built, sends it, and checks it on-chain.
// Refund: the same amount back to the account it came from.

import { parseWire, compileMessage, serializeWire, buildTx, sendAndConfirm } from '../solana/tx.js';
import { verify } from '../solana/keypair.js';
import * as bs58 from '../solana/base58.js';
import { USDC_MINT } from '../live/balances.js';

export const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const USDC_DECIMALS = 6;

export function isWalletAddress(s) {
  try { return typeof s === 'string' && s.length >= 32 && s.length <= 44 && bs58.decode(s).length === 32; }
  catch { return false; }
}

export const toUnits = (usd) => Math.round(usd * 10 ** USDC_DECIMALS);

/** SPL Token TransferChecked: amount in USDC base units. */
export function usdcTransferIx({ source, dest, owner, units }) {
  const data = new Uint8Array(10);
  data[0] = 12; // TransferChecked
  new DataView(data.buffer).setBigUint64(1, BigInt(units), true);
  data[9] = USDC_DECIMALS;
  return {
    programId: TOKEN_PROGRAM,
    keys: [
      { pubkey: source, isSigner: false, isWritable: true },
      { pubkey: USDC_MINT, isSigner: false, isWritable: false },
      { pubkey: dest, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    data,
  };
}

/** The player's USDC account holding the most USDC. */
export async function findUsdcAccount(rpc, owner) {
  const r = await rpc.call('getTokenAccountsByOwner', [owner, { mint: USDC_MINT }, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
  const accounts = r.value.map((a) => ({ address: a.pubkey, units: Number(a.account.data.parsed.info.tokenAmount.amount) }));
  accounts.sort((x, y) => y.units - x.units);
  return accounts[0] ?? null;
}

export async function buildDepositTx({ rpc, player, source, dest, units }) {
  const { blockhash } = await rpc.getLatestBlockhash();
  const message = compileMessage({ feePayer: player, recentBlockhash: blockhash, instructions: [usdcTransferIx({ source, dest, owner: player, units })] });
  return Buffer.from(serializeWire([new Uint8Array(64)], message)).toString('base64');
}

/** @returns {string|null} a problem, or null if fine */
export function checkSigned({ signedB64, originalB64, player }) {
  let signed, original;
  try { signed = parseWire(Buffer.from(signedB64, 'base64')); } catch { return 'the signed transaction could not be read'; }
  try { original = parseWire(Buffer.from(originalB64, 'base64')); } catch { return 'the original transaction is missing'; }
  if (Buffer.compare(Buffer.from(signed.message), Buffer.from(original.message)) !== 0) return 'the transaction was changed after it was created';
  const i = signed.accountKeys.indexOf(player);
  if (i < 0 || i >= signed.header.numRequiredSignatures) return 'the deposit is not from this wallet';
  if (!verify(player, signed.message, signed.signatures[i])) return 'the wallet signature is not valid';
  if (signed.signatures.some((s) => s.every((b) => b === 0))) return 'a signature is missing';
  return null;
}

/** Confirms on-chain that the duel wallet received at least `units` USDC from this transaction. */
export async function checkDeposit({ rpc, signature, player, botWallet, units }) {
  const tx = await rpc.call('getTransaction', [signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }]);
  if (!tx) return { status: 'pending' };
  if (tx.meta?.err) return { status: 'bad', reason: 'the deposit failed on-chain' };
  const keys = tx.transaction.message.accountKeys.map((k) => (typeof k === 'string' ? { pubkey: k, signer: false } : k));
  if (!keys.some((k) => k.pubkey === player && k.signer)) return { status: 'bad', reason: 'not signed by the joining wallet' };
  const sum = (list) => (list ?? []).filter((b) => b.mint === USDC_MINT && b.owner === botWallet).reduce((t, b) => t + Number(b.uiTokenAmount.amount), 0);
  const got = sum(tx.meta.postTokenBalances) - sum(tx.meta.preTokenBalances);
  if (got < units) return { status: 'bad', reason: `received ${got / 1e6} USDC, expected ${units / 1e6}` };
  return { status: 'ok', units: got };
}

export async function sendSigned(rpc, signedB64, log) {
  return sendAndConfirm(rpc, signedB64, { log });
}

export async function sendUsdcRefund({ rpc, wallet, from, to, units, log }) {
  const { blockhash } = await rpc.getLatestBlockhash();
  const tx = buildTx({ payer: wallet, recentBlockhash: blockhash, instructions: [usdcTransferIx({ source: from, dest: to, owner: wallet.publicKey, units })] });
  return sendAndConfirm(rpc, tx, { log });
}
