// Tops up the bot's USDC (packs are paid in USDC) by swapping SOL through Jupiter.
// Uses "ExactOut" so it buys exactly the USDC short, never more.

import { signWire, simulate, sendAndConfirm } from '../solana/tx.js';
import { USDC_MINT, SOL_MINT } from './balances.js';

const JUP = 'https://lite-api.jup.ag/swap/v1';

export async function quoteSolForUsdc(usdcAmount, slippageBps = 50) {
  const units = Math.ceil(usdcAmount * 1e6);
  const url = `${JUP}/quote?inputMint=${SOL_MINT}&outputMint=${USDC_MINT}&amount=${units}&swapMode=ExactOut&slippageBps=${slippageBps}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`Jupiter quote failed: HTTP ${res.status} ${(await res.text()).slice(0, 160)}`);
  const quote = await res.json();
  // otherAmountThreshold = most SOL it could take with slippage
  return { quote, maxLamports: Number(quote.otherAmountThreshold ?? quote.inAmount), lamports: Number(quote.inAmount) };
}

export async function swapSolForUsdc({ rpc, wallet, usdcAmount, dryRun, log = console.log }) {
  const { quote, maxLamports } = await quoteSolForUsdc(usdcAmount);
  const res = await fetch(`${JUP}/swap`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey: wallet.publicKey,
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: 'auto',
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Jupiter swap build failed: HTTP ${res.status} ${(await res.text()).slice(0, 160)}`);
  const { swapTransaction } = await res.json();
  const signed = signWire(swapTransaction, wallet);
  const sim = await simulate(rpc, signed);
  if (!sim.ok) throw new Error(`Swap simulation failed: ${JSON.stringify(sim.err)}\n${sim.logs.slice(-5).join('\n')}`);
  if (dryRun) { log(`  [dry run] swap of up to ${(maxLamports / 1e9).toFixed(4)} SOL -> ${usdcAmount} USDC simulated OK`); return { dryRun: true, maxLamports }; }
  const signature = await sendAndConfirm(rpc, signed, { log });
  return { signature, maxLamports };
}
