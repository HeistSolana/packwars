// Tiny JSON-file store for rounds, leaderboard and the last pairing.

import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';

const EMPTY = { round: 0, lastPair: null, rounds: [], leaderboard: {}, lastSnapshot: null };

export class Store {
  constructor(path) {
    this.path = path;
    mkdirSync(dirname(path), { recursive: true });
    this.state = existsSync(path) ? { ...EMPTY, ...JSON.parse(readFileSync(path, 'utf8')) } : structuredClone(EMPTY);
  }

  save() {
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    renameSync(tmp, this.path);
  }

  recordRound(r) {
    this.state.round = r.round;
    this.state.lastPair = [r.a.wallet, r.b.wallet];
    this.state.rounds.unshift(r);
    this.state.rounds = this.state.rounds.slice(0, 500);

    for (const side of [r.a, r.b]) {
      const row = (this.state.leaderboard[side.wallet] ??= { wins: 0, losses: 0, ties: 0, wonUsd: 0, pulledUsd: 0 });
      row.pulledUsd = round2(row.pulledUsd + side.card.insuredValueUsd);
      if (r.result === 'tie') row.ties++;
      else if (r.winner === side.wallet) { row.wins++; row.wonUsd = round2(row.wonUsd + r.potUsd); }
      else row.losses++;
    }
    this.save();
  }

  setSnapshot(s) {
    this.state.lastSnapshot = {
      slot: s.slot, takenAt: s.takenAt, supply: s.supply,
      eligible: s.eligible.map(({ wallet, pct }) => ({ wallet, pct: round2(pct) })),
      excluded: s.excluded.map(({ wallet, pct, reason }) => ({ wallet, pct: round2(pct), reason })),
    };
    this.save();
  }
}

export const round2 = (n) => Math.round(n * 100) / 100;
