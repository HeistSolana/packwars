export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const SOL_MINT = 'So11111111111111111111111111111111111111112';

export async function getUsdcBalance(rpc, owner) {
  const r = await rpc.call('getTokenAccountsByOwner', [owner, { mint: USDC_MINT }, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
  return r.value.reduce((s, a) => s + Number(a.account.data.parsed.info.tokenAmount.uiAmountString ?? 0), 0);
}
