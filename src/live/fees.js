// Claims pump.fun creator fees into the bot wallet.
//
// Uses PumpPortal's "local" mode: it builds the claim transaction, the bot
// signs it here (the key never leaves the server) and sends it through your RPC.
// This works when the bot wallet is the coin's creator, or the wallet pump.fun
// pays creator fees to. If fees reach the bot another way (fee sharing paid out
// by pump.fun, or you send them yourself), set "fees": { "claim": false } and
// the engine just watches the balance.

import { signWire, simulate, sendAndConfirm } from '../solana/tx.js';

const PUMPPORTAL = 'https://pumpportal.fun/api/trade-local';

export async function buildClaimTx({ wallet, pool = 'pump', mint, priorityFee = 0.00001 }) {
  const body = { publicKey: wallet.publicKey, action: 'collectCreatorFee', priorityFee, pool };
  if (mint && pool !== 'pump') body.mint = mint;
  const res = await fetch(PUMPPORTAL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  if (res.status !== 200) {
    const text = await res.text().catch(() => '');
    // PumpPortal answers 400 when there is nothing to claim.
    return { nothing: true, reason: `${res.status} ${text.slice(0, 160)}` };
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  return { tx: signWire(bytes, wallet) };
}

/** Claims fees. Returns { claimed, signature?, skipped? }. dryRun simulates instead of sending. */
export async function claimFees({ rpc, wallet, cfg, dryRun, log = console.log }) {
  const built = await buildClaimTx({ wallet, pool: cfg.fees?.pool ?? 'pump', mint: cfg.mint, priorityFee: cfg.fees?.priorityFee });
  if (built.nothing) return { claimed: false, skipped: built.reason };
  const sim = await simulate(rpc, built.tx);
  if (!sim.ok) return { claimed: false, skipped: `simulation failed: ${JSON.stringify(sim.err)}`, logs: sim.logs.slice(-6) };
  if (dryRun) { log('  [dry run] fee claim simulated OK, not sent'); return { claimed: false, dryRun: true }; }
  const signature = await sendAndConfirm(rpc, built.tx, { log });
  return { claimed: true, signature };
}
