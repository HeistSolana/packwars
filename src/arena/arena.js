// Open duels ("the arena").
//
// 1. A player picks a pack and deposits its price in USDC into the duel wallet,
//    approving it in their own wallet. Then they wait, for as long as they like.
// 2. Before anyone is matched they can cancel and get the full deposit back.
// 3. When a second player has deposited for the same pack, the bot buys both
//    packs from Collector Crypt at once, opens them together, and the higher
//    insured value takes both cards, sent to the winner's wallet.
//
//   seat:  awaiting-deposit -> confirming -> paid (waiting) -> matched -> done
//                     \-> expired / cancelled        \-> refunding -> refunded
//   duel:  opening -> paying -> done
//              \-> unwinding -> cancelled   (pack machine down: refunds / cards to owners)
//
// Every step is saved as it happens, so a restart continues where it stopped.

import { randomUUID } from 'node:crypto';
import * as payments from './payments.js';
import { firstSignature } from '../solana/tx.js';

const round2 = (n) => Math.round(n * 100) / 100;
const short = (w) => (w ? `${w.slice(0, 4)}…${w.slice(-4)}` : '?');
const OPEN = ['awaiting-deposit', 'confirming', 'paid', 'matched', 'refunding'];

export class ArenaError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

export class Arena {
  /**
   * @param {{cfg, rpc, wallet, botUsdc:string, opener, machines: Map, state, mock?, log?, now?, announce?, pay?}} o
   *   botUsdc: the duel wallet's USDC account (deposits land here)
   *   pay: payment helpers (defaults to ./payments.js; tests swap them)
   */
  constructor(o) {
    Object.assign(this, { log: console.log, now: () => Date.now(), mock: false, pay: payments }, o);
    const d = this.state.data;
    d.seats ??= {}; d.duels ??= {}; d.rounds ??= []; d.usedSigs ??= {};
    this.chain = Promise.resolve();
  }

  get a() { return this.cfg.arena ?? {}; }
  get seats() { return this.state.data.seats; }
  get duels() { return this.state.data.duels; }
  get botAddress() { return this.wallet?.publicKey ?? this.botWalletAddress; }
  save() { this.state.save(); }
  iso(t = this.now()) { return new Date(t).toISOString(); }

  // One state change at a time: API calls and the background loop share the state.
  lock(fn) {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => {});
    return run;
  }

  #seat(seatId, token) {
    const seat = this.seats[seatId];
    if (!seat || !token || seat.token !== token) throw new ArenaError('Seat not found.', 404);
    return seat;
  }

  // ---------- player actions ----------

  /** Step 1: pick a pack. Returns the USDC deposit to approve. */
  async join({ wallet, pack, ageConfirmed, country }) {
    return this.lock(async () => {
      const a = this.a;
      if (!payments.isWalletAddress(wallet)) throw new ArenaError('That is not a valid Solana wallet address.');
      if (!this.machines.has(pack) || !(a.packs ?? []).includes(pack)) throw new ArenaError('That pack is not available here.');
      if (a.requireAgeConfirm && !ageConfirmed) throw new ArenaError('Please confirm you are 18 or older and allowed to play where you live.');
      if (country && (a.blockedCountries ?? []).map((x) => x.toUpperCase()).includes(country.toUpperCase())) {
        throw new ArenaError('Duels are not available in your country.', 451);
      }
      const mine = Object.values(this.seats).filter((s) => s.wallet === wallet);
      if (mine.some((s) => s.pack === pack && OPEN.includes(s.status))) throw new ArenaError('You already have a seat for this pack.');
      const today = this.iso().slice(0, 10);
      const limit = a.maxSeatsPerWalletPerDay ?? 20;
      if (mine.filter((s) => s.paidAt?.startsWith(today)).length >= limit) throw new ArenaError(`Daily limit reached (${limit} duels).`, 429);

      const m = this.machines.get(pack);
      const units = payments.toUnits(m.priceUsd);
      const seat = {
        id: randomUUID(), token: randomUUID(), wallet, pack, priceUsd: m.priceUsd, units, status: 'awaiting-deposit',
        createdAt: this.iso(), expiresAt: this.iso(this.now() + (a.payWindowMinutes ?? 10) * 60_000),
      };

      if (this.mock) {
        Object.assign(seat, { status: 'paid', paidAt: seat.createdAt, depositSig: `mock-deposit-${seat.id.slice(0, 8)}`, source: 'mock' });
        this.seats[seat.id] = seat; this.save(); this.#match();
        return { seat: this.view(seat), token: seat.token };
      }

      const src = await this.pay.findUsdcAccount(this.rpc, wallet);
      if (!src || src.units < units) {
        throw new ArenaError(`You need $${m.priceUsd} USDC in this wallet to play this pack (you have $${((src?.units ?? 0) / 1e6).toFixed(2)}).`);
      }
      seat.source = src.address;
      seat.tx = await this.pay.buildDepositTx({ rpc: this.rpc, player: wallet, source: src.address, dest: this.botUsdc, units });
      this.seats[seat.id] = seat;
      this.save();
      return { seat: this.view(seat), token: seat.token, tx: seat.tx };
    });
  }

  /** Step 2: the player approved the deposit. We check it, send it, and confirm it on-chain. */
  async confirm({ seatId, token, signedTransaction }) {
    return this.lock(async () => {
      const seat = this.#seat(seatId, token);
      if (seat.status !== 'awaiting-deposit') return { seat: this.view(seat) };
      if (this.now() > Date.parse(seat.expiresAt)) { seat.status = 'expired'; delete seat.tx; this.save(); throw new ArenaError('This seat expired. Pick the pack again for a fresh one.'); }
      const problem = this.pay.checkSigned({ signedB64: signedTransaction, originalB64: seat.tx, player: seat.wallet });
      if (problem) throw new ArenaError(`Deposit not accepted: ${problem}.`);
      seat.depositSig = firstSignature(signedTransaction);
      if (this.state.data.usedSigs[seat.depositSig]) throw new ArenaError('This deposit was already used.');
      seat.status = 'confirming'; delete seat.tx;
      this.save();
      try { await this.pay.sendSigned(this.rpc, signedTransaction, this.log); }
      catch (err) { this.log(`[deposit] ${short(seat.wallet)} send: ${err.message} (will keep checking)`); }
      await this.#checkDeposit(seat);
      return { seat: this.view(seat) };
    });
  }

  /** Cancel. Before depositing: just dropped. After depositing, before a match: full refund. */
  async cancel({ seatId, token }) {
    return this.lock(async () => {
      const seat = this.#seat(seatId, token);
      if (seat.status === 'awaiting-deposit') { seat.status = 'cancelled'; delete seat.tx; this.save(); return { seat: this.view(seat) }; }
      if (seat.status === 'confirming') throw new ArenaError('Your deposit is still confirming. Try again in a few seconds.');
      if (seat.status !== 'paid') throw new ArenaError(seat.status === 'matched' ? 'Too late: you have been matched and the packs are being bought.' : 'This seat is already closed.');
      seat.status = 'refunding'; seat.refundReason = 'cancelled';
      this.save();
      await this.#refund(seat);
      return { seat: this.view(seat) };
    });
  }

  // ---------- background loop ----------

  async tick() {
    return this.lock(async () => {
      const now = this.now();
      for (const s of Object.values(this.seats)) {
        try {
          if (s.status === 'awaiting-deposit' && now > Date.parse(s.expiresAt) + 60_000) { s.status = 'expired'; delete s.tx; this.save(); }
          if (s.status === 'confirming') await this.#checkDeposit(s);
          if (s.status === 'refunding') await this.#refund(s);
        } catch (err) { this.log(`[seat ${s.id.slice(0, 8)}] ${err.message} (will retry)`); }
      }
      // Test mode only: a pretend opponent joins anyone who has waited a few seconds.
      if (this.mock && this.a.testOpponent) {
        const after = (this.a.testOpponentSeconds ?? 6) * 1000;
        const bot = 'TestOpponent1111111111111111111111111111111';
        for (const s of Object.values(this.seats)) {
          if (s.status !== 'paid' || s.wallet === bot || now - Date.parse(s.paidAt) < after) continue;
          if (Object.values(this.seats).some((x) => x.wallet === bot && x.pack === s.pack && x.status === 'paid')) continue;
          const m = this.machines.get(s.pack);
          const t = { id: randomUUID(), token: randomUUID(), wallet: bot, pack: s.pack, priceUsd: m.priceUsd, units: payments.toUnits(m.priceUsd),
            status: 'paid', createdAt: this.iso(), paidAt: this.iso(), depositSig: `mock-deposit-opponent-${randomUUID().slice(0, 8)}`, source: 'mock' };
          this.seats[t.id] = t;
          this.log(`[test] pretend opponent joined ${s.pack}`);
        }
      }
      this.#match();
      for (const d of Object.values(this.duels)) {
        if (['done', 'cancelled'].includes(d.stage)) continue;
        try { await this.#playDuel(d); }
        catch (err) { d.lastError = err.message; d.tries = (d.tries ?? 0) + 1; this.save(); this.log(`[duel ${d.id.slice(0, 8)}] ${err.message} (will retry)`); }
      }
    });
  }

  // ---------- internals ----------

  async #checkDeposit(seat) {
    const r = await this.pay.checkDeposit({ rpc: this.rpc, signature: seat.depositSig, player: seat.wallet, botWallet: this.botAddress, units: seat.units });
    if (r.status === 'pending') {
      if (this.now() - Date.parse(seat.expiresAt) > 30 * 60_000) { seat.status = 'expired'; seat.note = 'deposit never confirmed'; this.save(); }
      return;
    }
    if (r.status === 'bad') { seat.status = 'expired'; seat.note = r.reason; this.save(); throw new ArenaError(`Deposit not accepted: ${r.reason}.`); }
    this.state.data.usedSigs[seat.depositSig] = seat.id;
    Object.assign(seat, { status: 'paid', paidAt: this.iso(), depositUnits: r.units });
    this.save();
    this.log(`[deposit] ${short(seat.wallet)} deposited $${seat.priceUsd} for ${seat.pack}`);
    this.#match();
  }

  async #refund(seat) {
    const units = seat.depositUnits ?? seat.units;
    seat.refundSig = this.mock ? `mock-refund-${seat.id.slice(0, 8)}`
      : await this.pay.sendUsdcRefund({ rpc: this.rpc, wallet: this.wallet, from: this.botUsdc, to: seat.source, units, log: this.log });
    Object.assign(seat, { status: 'refunded', refundedAt: this.iso() });
    this.save();
    this.log(`[refund] $${units / 1e6} USDC back to ${short(seat.wallet)} (${seat.refundReason})`);
  }

  // First two paid seats on the same pack, from different wallets, become a duel.
  #match() {
    const waiting = Object.values(this.seats).filter((s) => s.status === 'paid').sort((x, y) => x.paidAt.localeCompare(y.paidAt));
    const byPack = new Map();
    for (const s of waiting) { if (!byPack.has(s.pack)) byPack.set(s.pack, []); byPack.get(s.pack).push(s); }
    for (const [pack, list] of byPack) {
      while (list.length >= 2) {
        const x = list.shift();
        const yi = list.findIndex((s) => s.wallet !== x.wallet);
        if (yi < 0) break;
        const y = list.splice(yi, 1)[0];
        const m = this.machines.get(pack);
        const d = {
          id: randomUUID(), pack, packInfo: { code: m.code, name: m.name, priceUsd: m.priceUsd, category: m.category, imageUrl: this.cfg.officialPackArt ? m.imageUrl ?? null : null },
          stage: 'opening', createdAt: this.iso(),
          a: { seatId: x.id, wallet: x.wallet, pack: {} }, b: { seatId: y.id, wallet: y.wallet, pack: {} },
        };
        x.status = y.status = 'matched'; x.duelId = y.duelId = d.id;
        this.duels[d.id] = d;
        this.log(`[match] ${short(x.wallet)} vs ${short(y.wallet)} on ${pack}`);
      }
    }
    this.save();
  }

  async #playDuel(d) {
    const save = () => this.save();

    if (d.stage === 'opening') {
      // The bot buys both packs with the two deposits and opens them together.
      const open = (side) => side.card ? Promise.resolve() : this.opener.openPack({
        forWallet: side.wallet, tier: d.pack, pack: d.pack, state: side.pack, save: (st) => { side.pack = st; save(); },
      }).then((r) => { side.card = r.card; side.packSig = r.txSig; save(); });
      try { await Promise.all([open(d.a), open(d.b)]); }
      catch (err) {
        if (this.now() - Date.parse(d.createdAt) > (this.a.openGiveUpMinutes ?? 30) * 60_000) { d.stage = 'unwinding'; d.unwindReason = err.message; save(); }
        else throw err;
      }
      if (d.stage === 'opening') {
        const va = d.a.card.insuredValueUsd, vb = d.b.card.insuredValueUsd;
        if (va === vb) { d.result = 'tie'; d.winner = null; d.loser = null; }
        else { d.result = 'win'; [d.winner, d.loser] = va > vb ? [d.a.wallet, d.b.wallet] : [d.b.wallet, d.a.wallet]; }
        d.potUsd = round2(va + vb);
        d.payouts = [
          { card: d.a.card, to: d.result === 'tie' ? d.a.wallet : d.winner, status: 'pending' },
          { card: d.b.card, to: d.result === 'tie' ? d.b.wallet : d.winner, status: 'pending' },
        ];
        d.stage = 'paying'; save();
      }
    }

    if (d.stage === 'unwinding') {
      // Packs couldn't be bought: a card already pulled goes to its owner, otherwise the deposit is refunded.
      for (const side of [d.a, d.b]) {
        const seat = this.seats[side.seatId];
        if (!side.card && side.pack?.paid) {
          const r = await this.opener.openPack({ forWallet: side.wallet, tier: d.pack, pack: d.pack, state: side.pack, save: (st) => { side.pack = st; save(); } });
          side.card = r.card; save();
        }
        if (side.card && !side.cardSig) { side.cardSig = await this.opener.transferCard(side.card, side.wallet); save(); }
        if (!side.card && seat.status === 'matched') { seat.status = 'refunding'; seat.refundReason = 'pack machine unavailable'; save(); await this.#refund(seat); }
      }
      d.stage = 'cancelled';
      for (const side of [d.a, d.b]) { const s = this.seats[side.seatId]; if (s.status === 'matched') s.status = 'done'; }
      save();
      this.log(`[duel ${d.id.slice(0, 8)}] cancelled: ${d.unwindReason}`);
      return;
    }

    if (d.stage === 'paying') {
      for (const p of d.payouts) {
        if (p.status === 'sent') continue;
        p.signature = await this.opener.transferCard(p.card, p.to);
        p.status = 'sent'; save();
      }
      d.stage = 'done'; d.finishedAt = this.iso();
      for (const side of [d.a, d.b]) this.seats[side.seatId].status = 'done';
      const record = {
        id: d.id, kind: 'deposit', round: this.state.data.rounds.length + 1, at: d.finishedAt, pack: d.packInfo,
        a: { wallet: d.a.wallet, card: d.a.card, openTx: d.a.packSig },
        b: { wallet: d.b.wallet, card: d.b.card, openTx: d.b.packSig },
        result: d.result, winner: d.winner, loser: d.loser, potUsd: d.potUsd,
        payouts: d.payouts.map(({ card, to, signature }) => ({ nftMint: card.nftMint, to, signature })),
      };
      this.state.data.rounds.unshift(record);
      this.state.data.rounds = this.state.data.rounds.slice(0, 1000);
      save();
      const line = d.result === 'tie'
        ? `⚔️ Duel #${record.round}: TIE at $${d.a.card.insuredValueUsd}. Both keep their cards.`
        : `⚔️ Duel #${record.round}: ${short(d.winner)} wins! ${d.a.card.name} ($${d.a.card.insuredValueUsd}) vs ${d.b.card.name} ($${d.b.card.insuredValueUsd}). Pot $${d.potUsd}`;
      this.log(line);
      if (this.announce) await this.announce(line, record).catch(() => {});
    }
  }

  // ---------- views for the website ----------

  view(seat) {
    const { id, wallet, pack, priceUsd, status, createdAt, expiresAt, paidAt, depositSig, duelId, refundSig, refundReason, note } = seat;
    return { id, wallet, pack, priceUsd, status, createdAt, expiresAt, paidAt, depositSig, duelId, refundSig, refundReason, note };
  }

  duelView(d) {
    const shown = ['paying', 'done'].includes(d.stage);
    return {
      id: d.id, pack: d.packInfo, stage: d.stage, createdAt: d.createdAt,
      a: { wallet: d.a.wallet, card: shown ? d.a.card : undefined },
      b: { wallet: d.b.wallet, card: shown ? d.b.card : undefined },
      result: d.result, winner: d.winner, potUsd: d.potUsd,
      payouts: d.payouts?.map(({ card, to, signature, status }) => ({ nftMint: card.nftMint, to, signature, status })),
    };
  }

  publicState() {
    const packs = (this.a.packs ?? []).filter((c) => this.machines.has(c)).map((code) => {
      const m = this.machines.get(code);
      const waiting = Object.values(this.seats).filter((s) => s.pack === code && s.status === 'paid');
      return { code, name: m.name, category: m.category ?? 'Other', priceUsd: m.priceUsd, buybackPct: m.buybackPct, tiers: m.tiers, waiting: waiting.length, imageUrl: this.cfg.officialPackArt ? m.imageUrl ?? null : null };
    }).sort((x, y) => x.category.localeCompare(y.category) || x.priceUsd - y.priceUsd);
    const live = Object.values(this.duels).filter((d) => !['done', 'cancelled'].includes(d.stage)).map((d) => this.duelView(d));
    const escrow = Object.values(this.seats).filter((s) => ['paid', 'matched', 'refunding'].includes(s.status)).reduce((t, s) => t + s.priceUsd, 0);
    return { packs, live, escrowUsd: escrow, rounds: this.state.data.rounds.slice(0, 50) };
  }

  forWallet(wallet) {
    const seats = Object.values(this.seats).filter((s) => s.wallet === wallet).sort((x, y) => y.createdAt.localeCompare(x.createdAt)).slice(0, 20);
    const duels = [...new Set(seats.map((s) => s.duelId).filter(Boolean))].map((id) => this.duelView(this.duels[id]));
    return { seats: seats.map((s) => this.view(s)), duels };
  }

  /** For the public ledger: what the duel wallet is allowed to do. */
  knownActions() {
    const winners = [], deposits = new Set(), refunds = new Set(), packPays = new Set();
    for (const d of Object.values(this.duels)) {
      for (const p of d.payouts ?? []) winners.push(`${p.card.nftMint}:${p.to}`);
      for (const side of [d.a, d.b]) { if (side.pack?.paySig) packPays.add(side.pack.paySig); if (side.cardSig) winners.push(`${side.card.nftMint}:${side.wallet}`); }
    }
    for (const s of Object.values(this.seats)) { if (s.paidAt && s.depositSig) deposits.add(s.depositSig); if (s.refundSig) refunds.add(s.refundSig); }
    return { winners, deposits, refunds, packPays };
  }
}
