// Solana transactions without dependencies:
//  - signWire: add the bot's signature to a transaction someone else built
//    (pump fee claim, Jupiter swap, Collector Crypt pack payment). Works for
//    legacy and versioned (v0) transactions, and keeps signatures already on it.
//  - buildTx: build and sign our own legacy transaction (card transfers).
//  - send / simulate: push to the network, wait for confirmation.

import * as bs58 from './base58.js';

// ---------- compact-u16 ("shortvec") ----------
export function encodeLen(n) {
  const out = [];
  for (;;) {
    let b = n & 0x7f; n >>= 7;
    if (n === 0) { out.push(b); return out; }
    out.push(b | 0x80);
  }
}
function decodeLen(buf, off) {
  let len = 0, shift = 0, i = off;
  for (;;) {
    const b = buf[i++];
    len |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) return [len, i];
    shift += 7;
  }
}

// ---------- reading a wire transaction ----------
export function parseWire(bytes) {
  bytes = Uint8Array.from(bytes);
  let [n, o] = decodeLen(bytes, 0);
  const signatures = [];
  for (let i = 0; i < n; i++, o += 64) signatures.push(bytes.slice(o, o + 64));
  const message = bytes.slice(o);
  let m = 0;
  const versioned = (message[0] & 0x80) !== 0;
  if (versioned) m = 1;
  const header = { numRequiredSignatures: message[m], numReadonlySigned: message[m + 1], numReadonlyUnsigned: message[m + 2] };
  m += 3;
  const [nk, m2] = decodeLen(message, m); m = m2;
  const accountKeys = [];
  for (let i = 0; i < nk; i++, m += 32) accountKeys.push(bs58.encode(message.slice(m, m + 32)));
  return { signatures, message, versioned, header, accountKeys };
}

export function serializeWire(signatures, message) {
  return Uint8Array.from([...encodeLen(signatures.length), ...signatures.flatMap((s) => [...s]), ...message]);
}

/** Signs a base64 transaction built by someone else, in the bot's signer slot. Returns base64. */
export function signWire(base64OrBytes, keypair) {
  const bytes = typeof base64OrBytes === 'string' ? Buffer.from(base64OrBytes, 'base64') : base64OrBytes;
  const tx = parseWire(bytes);
  const idx = tx.accountKeys.indexOf(keypair.publicKey);
  if (idx < 0 || idx >= tx.header.numRequiredSignatures) {
    throw new Error(`This transaction doesn't ask the bot wallet (${keypair.publicKey}) to sign it.`);
  }
  const sigs = tx.signatures.slice();
  while (sigs.length < tx.header.numRequiredSignatures) sigs.push(new Uint8Array(64));
  sigs[idx] = keypair.sign(tx.message);
  return Buffer.from(serializeWire(sigs, tx.message)).toString('base64');
}

export function firstSignature(base64) {
  return bs58.encode(parseWire(Buffer.from(base64, 'base64')).signatures[0]);
}

// ---------- building our own (legacy) transaction ----------
/** Compiles a single-signer legacy message where `feePayer` (base58) is the only signer. */
export function compileMessage({ feePayer, recentBlockhash, instructions }) {
  const metas = new Map();
  const touch = (pubkey, isSigner, isWritable) => {
    const m = metas.get(pubkey) ?? { pubkey, isSigner: false, isWritable: false };
    m.isSigner ||= isSigner; m.isWritable ||= isWritable;
    metas.set(pubkey, m);
  };
  touch(feePayer, true, true);
  for (const ix of instructions) {
    for (const k of ix.keys) touch(k.pubkey, k.isSigner, k.isWritable);
    touch(ix.programId, false, false);
  }
  const all = [...metas.values()];
  const rank = (m) => (m.pubkey === feePayer ? -1 : m.isSigner ? (m.isWritable ? 0 : 1) : (m.isWritable ? 2 : 3));
  all.sort((a, b) => rank(a) - rank(b));
  const keys = all.map((m) => m.pubkey);
  const signers = all.filter((m) => m.isSigner);
  if (signers.length !== 1) throw new Error('Only single-signer transactions are supported.');

  const header = [
    signers.length,
    all.filter((m) => m.isSigner && !m.isWritable).length,
    all.filter((m) => !m.isSigner && !m.isWritable).length,
  ];
  const ixBytes = instructions.flatMap((ix) => [
    keys.indexOf(ix.programId),
    ...encodeLen(ix.keys.length), ...ix.keys.map((k) => keys.indexOf(k.pubkey)),
    ...encodeLen(ix.data.length), ...ix.data,
  ]);
  return Uint8Array.from([
    ...header,
    ...encodeLen(keys.length), ...keys.flatMap((k) => [...bs58.decode(k)]),
    ...bs58.decode(recentBlockhash),
    ...encodeLen(instructions.length), ...ixBytes,
  ]);
}

/** Builds and signs a transaction where the bot wallet pays and signs. Returns base64. */
export function buildTx({ payer, recentBlockhash, instructions }) {
  const message = compileMessage({ feePayer: payer.publicKey, recentBlockhash, instructions });
  return Buffer.from(serializeWire([payer.sign(message)], message)).toString('base64');
}

/** Builds an UNSIGNED transaction for someone else (a player) to sign in their wallet. Returns base64. */
export function buildUnsignedTx({ feePayer, recentBlockhash, instructions }) {
  const message = compileMessage({ feePayer, recentBlockhash, instructions });
  return Buffer.from(serializeWire([new Uint8Array(64)], message)).toString('base64');
}

// ---------- System Program: plain SOL transfer ----------
export const SYSTEM_PROGRAM = '11111111111111111111111111111111';
export function solTransferIx({ from, to, lamports }) {
  const data = new Uint8Array(12);
  const v = new DataView(data.buffer);
  v.setUint32(0, 2, true);                    // Transfer
  v.setBigUint64(4, BigInt(lamports), true);
  return {
    programId: SYSTEM_PROGRAM,
    keys: [{ pubkey: from, isSigner: true, isWritable: true }, { pubkey: to, isSigner: false, isWritable: true }],
    data,
  };
}

// ---------- network ----------
export async function simulate(rpc, base64) {
  const r = await rpc.call('simulateTransaction', [base64, { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed' }]);
  return { ok: !r.value.err, err: r.value.err, logs: r.value.logs ?? [], unitsConsumed: r.value.unitsConsumed };
}

export async function sendAndConfirm(rpc, base64, { timeoutMs = 75_000, log = () => {} } = {}) {
  const sig = await rpc.call('sendTransaction', [base64, { encoding: 'base64', preflightCommitment: 'confirmed', maxRetries: 5 }]);
  log(`  sent ${sig}`);
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    await new Promise((r) => setTimeout(r, 1500));
    const st = (await rpc.call('getSignatureStatuses', [[sig]])).value[0];
    if (st?.err) throw new Error(`Transaction ${sig} failed: ${JSON.stringify(st.err)}`);
    if (st && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized')) return sig;
  }
  throw Object.assign(new Error(`Transaction ${sig} not confirmed in time`), { signature: sig, unconfirmed: true });
}
