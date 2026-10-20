// Simulated pack opener for testing and dry runs. Same interface as the live adapter.
// Picks the tier with the chosen pack's real odds, then draws a REAL card of that
// tier from the machine's current pool (name, grade, value and slab photo).
// If the pool can't be loaded (offline), it makes up a card inside the tier's range.

import { createHash, randomBytes } from 'node:crypto';

const NAMES = ['Charizard EX', 'Umbreon-Holo', 'Pikachu', 'Gengar', 'Rayquaza GX', 'Blastoise-Holo',
  'Mewtwo', 'Lucario EX', 'Espeon Vmax', 'Greninja EX', 'Jolteon EX', 'Dragonite EX'];
const GRADES = ['PSA 9', 'PSA 10', 'PSA 10', 'BGS 9.5', 'CGC 10'];
const LABEL = { common: 'Common', uncommon: 'Uncommon', rare: 'Rare', epic: 'Epic' };

export class MockPackOpener {
  /**
   * @param {{machine: object, pool?: {byTier: Record<string, object[]>} | null, seed?: string}} opts
   */
  constructor({ machine, pool = null, seed } = {}) {
    if (!machine) throw new Error('MockPackOpener needs a pack machine');
    this.machine = machine;
    this.pool = pool;
    this.seed = seed ?? randomBytes(8).toString('hex');
    this.n = 0;
  }

  #rand() {
    const h = createHash('sha256').update(`${this.seed}:${this.n++}`).digest();
    return h.readUInt32BE(0) / 0x100000000;
  }

  #pickTier() {
    const tiers = Object.entries(this.machine.tiers);
    const total = tiers.reduce((s, [, t]) => s + t[2], 0);
    let r = this.#rand() * total;
    return tiers.find(([, t]) => (r -= t[2]) < 0) ?? tiers[0];
  }

  async openPack({ forWallet }) {
    const [tierKey, [lo, hi]] = this.#pickTier();
    const txSig = `mock-${createHash('sha256').update(`${forWallet}${this.n}`).digest('hex').slice(0, 24)}`;

    const real = this.pool?.byTier?.[tierKey];
    if (real?.length) {
      const c = real[Math.floor(this.#rand() * real.length)];
      return { txSig, card: { ...c, rarity: LABEL[tierKey] ?? c.rarity } };
    }

    // Offline fallback: a made-up card inside the tier's real value range.
    const u = this.#rand();
    const value = Math.round((lo * Math.pow(hi / lo, u * u * u)) * 100) / 100;
    const name = NAMES[Math.floor(this.#rand() * NAMES.length)];
    const grade = GRADES[Math.floor(this.#rand() * GRADES.length)];
    const year = 1999 + Math.floor(this.#rand() * 27);
    return {
      txSig,
      card: { name: `${year} ${name}`, rarity: LABEL[tierKey] ?? tierKey, grade, insuredValueUsd: value, image: null, nftMint: `mockmint${this.n}` },
    };
  }

  async openPaid({ memo }) {
    return this.openPack({ forWallet: memo });
  }

  async transferCard(card, toWallet) {
    return `mock-transfer-${card.nftMint}-${toWallet.slice(0, 6)}`;
  }
}
