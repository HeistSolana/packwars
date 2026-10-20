// One duel round: snapshot -> fair pairing -> open both packs at once -> score -> pay winner.
//
// The round in progress is saved in store.state.inflight after every step, so if
// the engine stops halfway (crash, restart, network error) the next run resumes:
// it never takes a new snapshot, never re-pays for a paid pack, and keeps trying
// to deliver cards until both have landed.

import { takeSnapshot, short } from './snapshot.js';
import { makeSeed, pickPair } from './pairing.js';
import { round2 } from './store.js';

export async function runDuel({ rpc, cfg, opener, store, log = console.log, announce }) {
  let f = store.state.inflight;

  // 1-2. Snapshot + pairing (only for a brand new round)
  if (!f) {
    const round = store.state.round + 1;
    const snap = await takeSnapshot(rpc, cfg);
    store.setSnapshot(snap);
    log(`[round ${round}] snapshot slot ${snap.slot}: ${snap.eligible.length} eligible, ${snap.excluded.length} excluded`);
    if (snap.eligible.length < 2) {
      log(`[round ${round}] not enough eligible holders (need 2). Fund rolls over.`);
      return { skipped: true, reason: 'not_enough_holders', eligible: snap.eligible.length };
    }
    // Seed from a blockhash fetched AFTER the snapshot.
    const { blockhash } = await rpc.getLatestBlockhash();
    const seed = makeSeed(blockhash, cfg.mint, round);
    const [wa, wb] = pickPair(snap.eligible.map((h) => h.wallet), seed, { avoidPair: store.state.lastPair });
    const pct = (w) => round2(snap.eligible.find((h) => h.wallet === w).pct);
    f = {
      round, stage: 'opening', startedAt: new Date().toISOString(),
      pack: cfg.packInfo ?? { code: cfg.packTier },
      snapshotSlot: snap.slot, blockhash, seed,
      entrants: snap.eligible.map((h) => h.wallet).sort(),
      a: { wallet: wa, pct: pct(wa), pack: {} },
      b: { wallet: wb, pct: pct(wb), pack: {} },
    };
    store.state.inflight = f; store.save();
    log(`[round ${round}] ${short(wa)} vs ${short(wb)}  (seed ${seed.slice(0, 12)}…)`);
  } else {
    log(`[round ${f.round}] resuming at "${f.stage}"`);
  }
  const save = () => { store.state.inflight = f; store.save(); };

  // 3. Open both packs at the same time.
  if (f.stage === 'opening') {
    const open = (side) => side.card ? Promise.resolve() : opener.openPack({
      forWallet: side.wallet, tier: f.pack.code, state: side.pack,
      save: (st) => { side.pack = st; save(); },
    }).then((r) => { side.card = r.card; side.openTx = r.txSig; save(); });
    await Promise.all([open(f.a), open(f.b)]);

    // 4. Score. Higher insured value takes both cards. Exact tie = each keeps their own.
    const va = f.a.card.insuredValueUsd, vb = f.b.card.insuredValueUsd;
    if (va === vb) { f.result = 'tie'; f.winner = null; f.loser = null; }
    else { f.result = 'win'; [f.winner, f.loser] = va > vb ? [f.a.wallet, f.b.wallet] : [f.b.wallet, f.a.wallet]; }
    f.potUsd = round2(va + vb);
    f.payouts = [
      { card: f.a.card, to: f.result === 'tie' ? f.a.wallet : f.winner, status: 'pending' },
      { card: f.b.card, to: f.result === 'tie' ? f.b.wallet : f.winner, status: 'pending' },
    ];
    f.stage = 'paying'; save();
  }

  // 5. Pay out: send each card NFT to its new owner.
  if (f.stage === 'paying') {
    for (const p of f.payouts) {
      if (p.status === 'sent') continue;
      try {
        p.signature = await opener.transferCard(p.card, p.to);
        p.status = 'sent';
      } catch (err) {
        p.status = 'pending'; p.lastError = err.message; p.tries = (p.tries ?? 0) + 1;
        save();
        throw new Error(`[round ${f.round}] card ${p.card.nftMint} not delivered yet (${err.message}). Will retry.`);
      }
      save();
    }
    f.stage = 'done';
  }

  const record = {
    round: f.round,
    at: new Date().toISOString(),
    pack: f.pack,
    snapshotSlot: f.snapshotSlot,
    blockhash: f.blockhash,
    seed: f.seed,
    entrants: f.entrants,
    a: { wallet: f.a.wallet, pct: f.a.pct, card: f.a.card, openTx: f.a.openTx },
    b: { wallet: f.b.wallet, pct: f.b.pct, card: f.b.card, openTx: f.b.openTx },
    result: f.result,
    winner: f.winner,
    loser: f.loser,
    potUsd: f.potUsd,
    payouts: f.payouts.map(({ card, to, signature }) => ({ nftMint: card.nftMint, to, signature })),
    transfers: f.payouts.map((p) => p.signature),
  };
  store.state.inflight = null;
  store.recordRound(record);

  const va = record.a.card.insuredValueUsd, vb = record.b.card.insuredValueUsd;
  const line = record.result === 'tie'
    ? `⚔️ Round ${record.round}: TIE at $${va}. Both keep their cards.`
    : `⚔️ Round ${record.round}: ${short(record.winner)} wins! ${record.a.card.name} ($${va}) vs ${record.b.card.name} ($${vb}). Pot $${record.potUsd}`;
  log(`[round ${record.round}] ${line}`);
  if (announce) await announce(line, record).catch((e) => log(`announce failed: ${e.message}`));
  return record;
}
