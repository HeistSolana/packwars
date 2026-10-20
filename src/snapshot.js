// Takes a holder snapshot and works out who is eligible to duel.

const SYSTEM_PROGRAM = '11111111111111111111111111111111';

/**
 * @param {import('./rpc.js').Rpc} rpc
 * @param {object} cfg  see config.example.json
 * @returns {Promise<{slot:number, supply:number, holders:Array, eligible:Array, excluded:Array}>}
 */
export async function takeSnapshot(rpc, cfg) {
  const slot = await rpc.getSlot();
  const supplyInfo = await rpc.getTokenSupply(cfg.mint);
  const supply = Number(supplyInfo.uiAmountString ?? supplyInfo.uiAmount);

  // 1. Collect token accounts. Fast path = top 20; full scan if configured.
  let accounts;
  if (cfg.snapshot?.fullScan) {
    const raw = await rpc.getAllTokenAccounts(cfg.mint);
    accounts = raw.map((a) => ({
      address: a.pubkey,
      owner: a.account.data.parsed.info.owner,
      amount: Number(a.account.data.parsed.info.tokenAmount.uiAmountString),
    }));
  } else {
    const largest = await rpc.getTokenLargestAccounts(cfg.mint);
    const infos = await rpc.getMultipleAccounts(largest.map((l) => l.address));
    accounts = largest.map((l, i) => ({
      address: l.address,
      owner: infos[i]?.data?.parsed?.info?.owner ?? null,
      amount: Number(l.uiAmountString ?? l.uiAmount),
    }));
  }

  // 2. Merge by wallet (one wallet can own several token accounts).
  const byOwner = new Map();
  for (const a of accounts) {
    if (!a.owner || a.amount <= 0) continue;
    byOwner.set(a.owner, (byOwner.get(a.owner) ?? 0) + a.amount);
  }

  const holders = [...byOwner.entries()]
    .map(([wallet, amount]) => ({ wallet, amount, pct: (amount / supply) * 100 }))
    .sort((a, b) => b.amount - a.amount);

  // 3. Exclusions: manual list + anything that isn't a normal wallet.
  //    The pump.fun bonding curve, the AMM pool after graduation, lockers etc.
  //    are all program-owned accounts, so they get caught automatically.
  const manual = new Set(cfg.exclude ?? []);
  const owners = await rpc.getMultipleAccounts(holders.map((h) => h.wallet), 'base64');

  const excluded = [];
  const candidates = [];
  holders.forEach((h, i) => {
    const info = owners[i];
    let reason = null;
    if (manual.has(h.wallet)) reason = 'manual exclude';
    else if (cfg.snapshot?.excludeProgramOwned !== false) {
      if (info && info.owner !== SYSTEM_PROGRAM) reason = `program-owned (${short(info.owner)})`;
      else if (info?.executable) reason = 'executable';
    }
    if (reason) excluded.push({ ...h, reason });
    else candidates.push(h);
  });

  // 4. Threshold. Percent is measured against total supply.
  const minPct = cfg.minHoldingPct ?? 1;
  const eligible = candidates.filter((h) => h.pct >= minPct);

  return { slot, supply, holders, eligible, excluded, takenAt: new Date().toISOString() };
}

export const short = (s) => (s ? `${s.slice(0, 4)}…${s.slice(-4)}` : '?');
