// Public ledger of the bot wallet, built from the blockchain itself (not from the
// engine's own notes), so it also shows anything the engine did NOT do. Every
// transaction is sorted into one of:
//
//   fees-in      SOL arriving from pump.fun's fee programs
//   player-in    a player's USDC deposit for an open duel
//   refund       a deposit sent back to the player who cancelled
//   deposit      SOL/USDC arriving from anywhere else
//   swap         SOL -> USDC (Jupiter)
//   pack         USDC paid for a pack
//   card-in      a card NFT arriving from a pack
//   card-out     a card NFT sent to a duel winner
//   network      only network fees moved
//   other-out    money or cards leaving to anyone else  <- flagged on the site

import { USDC_MINT } from './balances.js';
import { MPL_CORE } from '../solana/core.js';

const PUMP_PROGRAMS = new Set([
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P', // pump.fun bonding curve
  'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA', // PumpSwap
  'pfeeUxB6jkeY1Hxd7CsFCAGcMTJk2odv3o2j1fE3WbN', // pump fees / fee sharing
]);
const JUPITER = new Set(['JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4']);

function programsIn(tx) {
  const keys = tx.transaction.message.accountKeys.map((k) => (typeof k === 'string' ? k : k.pubkey));
  const ids = new Set();
  const visit = (ix) => ix.programId && ids.add(ix.programId);
  tx.transaction.message.instructions.forEach(visit);
  (tx.meta.innerInstructions ?? []).forEach((g) => g.instructions.forEach(visit));
  return { ids, keys };
}

function usdcDelta(tx, owner) {
  const sum = (list) => (list ?? [])
    .filter((b) => b.mint === USDC_MINT && b.owner === owner)
    .reduce((s, b) => s + Number(b.uiTokenAmount.uiAmountString ?? 0), 0);
  return Math.round((sum(tx.meta.postTokenBalances) - sum(tx.meta.preTokenBalances)) * 1e6) / 1e6;
}

// Metaplex Core transfers out of the bot: find the new owner (5th account of TransferV1).
function coreTransfersOut(tx, owner) {
  const out = [];
  const all = [...tx.transaction.message.instructions, ...(tx.meta.innerInstructions ?? []).flatMap((g) => g.instructions)];
  for (const ix of all) {
    if (ix.programId !== MPL_CORE || !ix.accounts || !ix.data) continue;
        if (ix.accounts[2] === owner && ix.accounts.length >= 5 && ix.accounts[4] !== owner) {
      out.push({ asset: ix.accounts[0], to: ix.accounts[4] });
    }
  }
  return out;
}

export function classify(tx, owner, known = {}) {
  const { ids, keys } = programsIn(tx);
  const i = keys.indexOf(owner);
  const lamports = i >= 0 ? tx.meta.postBalances[i] - tx.meta.preBalances[i] : 0;
  const feePaidByBot = keys[0] === owner ? tx.meta.fee : 0;
  const sol = (lamports + feePaidByBot) / 1e9; // movement excluding the network fee
  const usdc = usdcDelta(tx, owner);
  const sig = tx.transaction.signatures[0];
  const cardsOut = coreTransfersOut(tx, owner);
  const touchesCore = ids.has(MPL_CORE);
  const base = { sig, time: tx.blockTime ? new Date(tx.blockTime * 1000).toISOString() : null, sol: Math.round(sol * 1e9) / 1e9, usdc, failed: !!tx.meta.err };

  if (tx.meta.err) return { ...base, type: 'network', note: 'failed transaction' };
  if (known.deposits?.has(sig)) return { ...base, type: 'player-in' };
  if (known.refunds?.has(sig)) return { ...base, type: 'refund' };
  if (cardsOut.length) {
    const winners = new Set(known.winners ?? []);
    const toWinner = cardsOut.every((c) => winners.has(`${c.asset}:${c.to}`));
    return { ...base, type: toWinner ? 'card-out' : 'other-out', cards: cardsOut, note: toWinner ? 'card sent to duel winner' : 'card sent outside a duel' };
  }
  if (usdc > 0 && sol < 0) return { ...base, type: 'swap', via: [...ids].some((p) => JUPITER.has(p)) ? 'Jupiter' : 'swap' };
  if (usdc < 0) return known.packPays?.has(sig)
    ? { ...base, type: 'pack' } : { ...base, type: 'other-out', note: 'USDC sent outside a pack purchase' };
  if (sol > 0 && [...ids].some((p) => PUMP_PROGRAMS.has(p))) return { ...base, type: 'fees-in' };
  if (sol > 0 || usdc > 0) return { ...base, type: 'deposit' };
  if (touchesCore) return { ...base, type: 'card-in' };
  if (sol < -0.000001) return { ...base, type: 'other-out', note: 'SOL sent out' };
  return { ...base, type: 'network' };
}

/**
 * Brings the ledger up to date. Only fetches transactions newer than the last one seen.
 * @param {{rpc, owner:string, ledger?:object, known?:object, maxNew?:number}} p
 */
export async function refreshLedger({ rpc, owner, ledger = { entries: [], newest: null }, known = {}, maxNew = 200 }) {
  const fresh = [];
  let before;
  outer: for (let page = 0; page < 5; page++) {
    const sigs = await rpc.call('getSignaturesForAddress', [owner, { limit: 100, before, until: ledger.newest ?? undefined, commitment: 'confirmed' }]);
    if (!sigs.length) break;
    for (const s of sigs) { fresh.push(s.signature); if (fresh.length >= maxNew) break outer; }
    before = sigs[sigs.length - 1].signature;
    if (sigs.length < 100) break;
  }
  const entries = [];
  for (const sig of fresh) {
    const tx = await rpc.call('getTransaction', [sig, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }]);
    if (tx) entries.push(classify(tx, owner, known));
  }
  const all = [...entries, ...ledger.entries].sort((a, b) => (b.time ?? '').localeCompare(a.time ?? ''));
  return { entries: all.slice(0, 2000), newest: fresh[0] ?? ledger.newest, updatedAt: new Date().toISOString() };
}

export function totals(entries) {
  const t = { playerDepositsUsdc: 0, playerDeposits: 0, refundsUsdc: 0, refunds: 0, feesInSol: 0, depositsSol: 0, depositsUsdc: 0, swappedSol: 0, packsBought: 0, packsUsdc: 0, cardsIn: 0, cardsSent: 0, otherOut: [] };
  for (const e of entries) {
    if (e.type === 'fees-in') t.feesInSol += e.sol;
    else if (e.type === 'deposit') { t.depositsSol += Math.max(0, e.sol); t.depositsUsdc += Math.max(0, e.usdc); }
    else if (e.type === 'swap') t.swappedSol += -e.sol;
    else if (e.type === 'pack') { t.packsBought++; t.packsUsdc += -e.usdc; }
    else if (e.type === 'card-in') t.cardsIn++;
    else if (e.type === 'card-out') t.cardsSent += e.cards?.length ?? 1;
    else if (e.type === 'player-in') { t.playerDepositsUsdc += Math.max(0, e.usdc); t.playerDeposits++; }
    else if (e.type === 'refund') { t.refundsUsdc += Math.max(0, -e.usdc); t.refunds++; }
    else if (e.type === 'other-out') t.otherOut.push(e);
  }
  for (const k of ['feesInSol', 'depositsSol', 'swappedSol']) t[k] = Math.round(t[k] * 1e4) / 1e4;
  for (const k of ['depositsUsdc', 'packsUsdc', 'playerDepositsUsdc', 'refundsUsdc']) t[k] = Math.round(t[k] * 100) / 100;
  return t;
}
