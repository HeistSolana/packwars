// Provably fair pairing: the seed is a Solana blockhash produced AFTER the
// snapshot, so nobody (including you) can know the matchup in advance.
// Anyone can re-run pickPair() with the published seed + entrant list to verify.

import { createHash } from 'node:crypto';

export function makeSeed(blockhash, mint, round) {
  return createHash('sha256').update(`${blockhash}:${mint}:${round}`).digest('hex');
}

// Deterministic stream of 32-bit numbers from a hex seed.
function* randomStream(seedHex) {
  let counter = 0;
  for (;;) {
    const h = createHash('sha256').update(`${seedHex}:${counter++}`).digest();
    for (let i = 0; i + 4 <= h.length; i += 4) yield h.readUInt32BE(i);
  }
}

// Unbiased integer in [0, n)
function randInt(stream, n) {
  const limit = Math.floor(0x100000000 / n) * n;
  for (;;) {
    const v = stream.next().value;
    if (v < limit) return v % n;
  }
}

/**
 * Picks two different wallets from the eligible list.
 * Entrants are sorted by address first so order from the RPC never matters.
 * @param {string[]} wallets
 * @param {string} seedHex
 * @param {{avoidPair?: [string,string]}} opts  skip an immediate rematch when possible
 */
export function pickPair(wallets, seedHex, opts = {}) {
  const pool = [...new Set(wallets)].sort();
  if (pool.length < 2) return null;

  const stream = randomStream(seedHex);
  // Fisher-Yates shuffle
  for (let i = pool.length - 1; i > 0; i--) {
    const j = randInt(stream, i + 1);
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }

  let pair = [pool[0], pool[1]];
  const avoid = opts.avoidPair && new Set(opts.avoidPair);
  if (avoid && pool.length > 2 && avoid.has(pair[0]) && avoid.has(pair[1])) {
    pair = [pool[0], pool[2]];
  }
  return pair;
}
