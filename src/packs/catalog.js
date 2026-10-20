// The real pack machines. These are Collector Crypt's machines, the same ones
// pump.fun's pack feature sells. Loaded live from their public machine list so
// prices and odds stay current, with a bundled copy as a fallback.

const LIVE_URL = 'https://gacha.collectorcrypt.com/api/gachas/all';

// Copy of every live machine (taken 20 Oct 2026). Used only if the live list can't load.
// tiers: [minUsd, maxUsd, chance]
const FALLBACK = [
  { code: 'pokemon_25', name: 'Starter Pokémon Gacha Pack', category: 'Pokemon', priceUsd: 25, buybackPct: 85, tiers: { common: [13, 30, .75], uncommon: [30, 55, .20], rare: [55, 125, .04], epic: [125, 500, .01] } , imageUrl: 'https://degwuxynwtb2zaso.public.blob.vercel-storage.com/machines/pokemon_25/imageNobg-hXc299AMhcvlcvBfPRk5dnueUYcZTG.png' },
  { code: 'pokemon_50', name: 'Elite Pokémon Gacha Pack', category: 'Pokemon', priceUsd: 50, buybackPct: 85, tiers: { common: [30, 60, .80], uncommon: [60, 110, .15], rare: [110, 250, .04], epic: [250, 5001, .01] } , imageUrl: 'https://degwuxynwtb2zaso.public.blob.vercel-storage.com/machines/pokemon_50/imageNobg-XvuRTLlLQdHWJc8wG7EIYmOITBIjQC.png' },
  { code: 'sealed_80', name: 'Sealed Gacha Pack', category: 'Pokemon', priceUsd: 80, buybackPct: 90, tiers: { common: [40, 80, .80], uncommon: [80, 160, .15], rare: [160, 400, .04], epic: [400, 5001, .01] } , imageUrl: 'https://degwuxynwtb2zaso.public.blob.vercel-storage.com/machines/sealed_80/imageNobg-0mxGfbwxgREZHyv9NlAAXJhakS4Vnt.png' },
  { code: 'pokemon_100', name: 'Bronze Pokémon Gacha Pack', category: 'Pokemon', priceUsd: 100, buybackPct: 90, tiers: { common: [50, 100, .80], uncommon: [100, 200, .15], rare: [200, 500, .04], epic: [500, 10001, .01] } , imageUrl: 'https://degwuxynwtb2zaso.public.blob.vercel-storage.com/machines/pokemon_100/imageNobg-o8nCQD50o0yg7rc4r6iYSrJuJMDnZ2.png' },
  { code: 'pokemon_250', name: 'Legendary Pokémon Gacha Pack', category: 'Pokemon', priceUsd: 250, buybackPct: 90, tiers: { common: [150, 250, .75], uncommon: [250, 400, .20], rare: [400, 2000, .04], epic: [2000, 50000, .01] } , imageUrl: 'https://degwuxynwtb2zaso.public.blob.vercel-storage.com/machines/pokemon_250/imageNobg-UmbYRxNV47XgNSLrhFmdG1OjTA7l26.png' },
  { code: 'pokemon_500', name: 'Hyper Pokémon Gacha', category: 'Pokemon', priceUsd: 500, buybackPct: 90, tiers: { common: [250, 500, .75], uncommon: [500, 1000, .20], rare: [1000, 2500, .04], epic: [2500, 50001, .01] } , imageUrl: 'https://degwuxynwtb2zaso.public.blob.vercel-storage.com/machines/pokemon_500/imageNobg-cnJnyq388yGZiEgFCGT6mw10wLT1Is.png' },
  { code: 'e10_10', name: "PSA 10's ONLY 10/10 Day", category: 'Pokemon', priceUsd: 500, buybackPct: 93, tiers: { common: [250, 500, .75], uncommon: [500, 1000, .20], rare: [1000, 2500, .04], epic: [2500, 50001, .01] } , imageUrl: 'https://degwuxynwtb2zaso.public.blob.vercel-storage.com/machines/e10_10/thumb-aA4JMDtSxVJuOeFJ6BapMpQpYXl1z4.jpg' },
  { code: 'pokemon_1000', name: 'Grail Pokémon Gacha Pack', category: 'Pokemon', priceUsd: 1000, buybackPct: 93, tiers: { common: [600, 1000, .75], uncommon: [1000, 1600, .20], rare: [1600, 8000, .04], epic: [8000, 50000, .01] } , imageUrl: 'https://degwuxynwtb2zaso.public.blob.vercel-storage.com/machines/pokemon_1000/imageNobg-5PfiPmxBdVMCOJxbQIkdFFZWid5A5t.png' },
  { code: 'pokemon_2500', name: 'Mythic Pokémon Gacha Pack', category: 'Pokemon', priceUsd: 2500, buybackPct: 93, tiers: { common: [1250, 2500, .75], uncommon: [2500, 5000, .20], rare: [5000, 10000, .04], epic: [10000, 150000, .01] } , imageUrl: 'https://degwuxynwtb2zaso.public.blob.vercel-storage.com/machines/pokemon_2500/imageNobg-bqUqTUDRrQUnZYsH48deXC5mg4P65m.png' },
  { code: 'pokemon_5000', name: 'Celestial Pokémon Gacha Pack', category: 'Pokemon', priceUsd: 5000, buybackPct: 93, tiers: { common: [2500, 5000, .75], uncommon: [5000, 10000, .20], rare: [10000, 20000, .04], epic: [20000, 280001, .01] } , imageUrl: 'https://degwuxynwtb2zaso.public.blob.vercel-storage.com/machines/pokemon_5000/imageNobg-hOKS7rlAYVfsRuFiza7BOrgxA10yLu.png' },
  { code: 'onepiece_50', name: 'One Piece Ocean Blue Pack', category: 'One Piece', priceUsd: 50, buybackPct: 85, tiers: { common: [30, 60, .80], uncommon: [60, 110, .15], rare: [110, 250, .04], epic: [250, 5001, .01] } , imageUrl: 'https://degwuxynwtb2zaso.public.blob.vercel-storage.com/machines/onepiece_50/imageNobg-WqpFbuPIsLeAiOwTB3ozezhVgNgSrq.png' },
  { code: 'onepiece_250', name: 'One Piece Crew Pack', category: 'One Piece', priceUsd: 250, buybackPct: 90, tiers: { common: [150, 250, .75], uncommon: [250, 400, .20], rare: [400, 2000, .04], epic: [2000, 50000, .01] } , imageUrl: 'https://degwuxynwtb2zaso.public.blob.vercel-storage.com/machines/onepiece_250/imageNobg-QPWTjWwto5HGY6oDm7dWgJuxac1HsI.png' },
  { code: 'onepiece_1000', name: 'One Piece Emperor Pack', category: 'One Piece', priceUsd: 1000, buybackPct: 93, tiers: { common: [600, 1000, .75], uncommon: [1000, 1600, .20], rare: [1600, 8000, .04], epic: [8000, 50000, .01] } , imageUrl: 'https://degwuxynwtb2zaso.public.blob.vercel-storage.com/machines/onepiece_1000/imageNobg-FWUMCQYn73l1Q387kCYjHxGyE5VMJL.png' },
  { code: 'soccer_50', name: 'Soccer $50 Pack', category: 'Sports', priceUsd: 50, buybackPct: 90, tiers: { common: [25, 50, .75], uncommon: [50, 100, .20], rare: [100, 250, .04], epic: [250, 5001, .01] } , imageUrl: 'https://degwuxynwtb2zaso.public.blob.vercel-storage.com/machines/soccer_50/imageNobg-VgQXetx0Q4JmBBV7sjATrMkEAW8CUt.png' },
  { code: 'sports_100', name: 'Sports Gacha Pack', category: 'Sports', priceUsd: 100, buybackPct: 90, tiers: { common: [50, 100, .75], uncommon: [100, 200, .20], rare: [200, 500, .04], epic: [500, 10001, .01] } , imageUrl: 'https://degwuxynwtb2zaso.public.blob.vercel-storage.com/machines/sports_100/imageNobg-VYfE61IKI0DrRno2xsIUrSYawDqkn2.png' },
  { code: 'soccer_100', name: 'Soccer $100 Pack', category: 'Sports', priceUsd: 100, buybackPct: 90, tiers: { common: [50, 100, .75], uncommon: [100, 200, .20], rare: [200, 500, .04], epic: [500, 10001, .01] } , imageUrl: 'https://degwuxynwtb2zaso.public.blob.vercel-storage.com/machines/soccer_100/imageNobg-AGTxpY7UUoF6ylV3oVp5051wOnctFK.png' },
  { code: 'basketball_100', name: 'Basketball 100 Gacha Pack', category: 'Sports', priceUsd: 100, buybackPct: 90, tiers: { common: [50, 100, .75], uncommon: [100, 200, .20], rare: [200, 500, .04], epic: [500, 5001, .01] } , imageUrl: 'https://degwuxynwtb2zaso.public.blob.vercel-storage.com/machines/basketball_100/imageNobg-y2tmaNtjPcOq3UDe67obpwPJG0NWKN.png' },
  { code: 'baseball_100', name: 'Baseball 100 Gacha Pack', category: 'Sports', priceUsd: 100, buybackPct: 90, tiers: { common: [50, 100, .75], uncommon: [100, 200, .20], rare: [200, 500, .04], epic: [500, 5001, .01] } , imageUrl: 'https://degwuxynwtb2zaso.public.blob.vercel-storage.com/machines/baseball_100/imageNobg-vm5AyoCAwe8MOuDNpdqPtYfNi2nwgw.png' },
  { code: 'football_100', name: 'Football 100 Gacha Pack', category: 'Sports', priceUsd: 100, buybackPct: 90, tiers: { common: [50, 100, .75], uncommon: [100, 200, .20], rare: [200, 500, .04], epic: [500, 5001, .01] } , imageUrl: 'https://degwuxynwtb2zaso.public.blob.vercel-storage.com/machines/football_100/imageNobg-HujIaHfiBJ2UOJpjZlj749Xb9t8yuA.png' },
  { code: 'soccer_250', name: 'Soccer $250 Pack', category: 'Sports', priceUsd: 250, buybackPct: 90, tiers: { common: [125, 250, .75], uncommon: [250, 500, .20], rare: [500, 1250, .04], epic: [1250, 25001, .01] } , imageUrl: 'https://degwuxynwtb2zaso.public.blob.vercel-storage.com/machines/soccer_250/imageNobg-rAVSPPkUXm5VlBgkLJ9lsRaMGWSgOT.png' },
  { code: 'basketball_250', name: 'Basketball 250 Pack', category: 'Sports', priceUsd: 250, buybackPct: 90, tiers: { common: [150, 250, .75], uncommon: [250, 400, .20], rare: [400, 2000, .04], epic: [2000, 50000, .01] } , imageUrl: 'https://degwuxynwtb2zaso.public.blob.vercel-storage.com/machines/basketball_250/imageNobg-BTlLRoiUguoAarLgHbQz4rvJCRIHq6.png' },
  { code: 'baseball_250', name: 'Baseball 250 Gacha Pack', category: 'Sports', priceUsd: 250, buybackPct: 90, tiers: { common: [150, 250, .75], uncommon: [250, 400, .20], rare: [400, 2000, .04], epic: [2000, 50000, .01] } , imageUrl: 'https://degwuxynwtb2zaso.public.blob.vercel-storage.com/machines/baseball_250/imageNobg-5khp6YGs0lGy8s5XOpL9hjgD6mwGwf.png' },
  { code: 'football_250', name: 'Football 250 Pack', category: 'Sports', priceUsd: 250, buybackPct: 90, tiers: { common: [150, 250, .75], uncommon: [250, 400, .20], rare: [400, 2000, .04], epic: [2000, 50000, .01] } , imageUrl: 'https://degwuxynwtb2zaso.public.blob.vercel-storage.com/machines/football_250/imageNobg-jmD1m3YF1gpo5yfW7mWXxdceMjqMTy.png' },
  { code: 'sports_500', name: 'All-Star Sports Gacha Pack 500', category: 'Sports', priceUsd: 500, buybackPct: 93, tiers: { common: [250, 500, .75], uncommon: [500, 1000, .20], rare: [1000, 2500, .04], epic: [2500, 50001, .01] } , imageUrl: 'https://degwuxynwtb2zaso.public.blob.vercel-storage.com/machines/sports_500/imageNobg-cnjCwF8nn1ARvpk19VBVsjdSGyvGG6.png' },
  { code: 'ewatch_250', name: 'WATCH 250', category: 'Watch', priceUsd: 250, buybackPct: 90, tiers: { common: [125, 250, .75], uncommon: [250, 500, .20], rare: [500, 1250, .04], epic: [1250, 25001, .01] } , imageUrl: 'https://degwuxynwtb2zaso.public.blob.vercel-storage.com/machines/ewatch_250/imageNobg-zMqM3YA9JYQl4T0TIUuc1v1DyRpX0o.png' },
  { code: 'ewatch_500', name: 'WATCH 500', category: 'Watch', priceUsd: 500, buybackPct: 93, tiers: { common: [250, 500, .75], uncommon: [500, 1000, .20], rare: [1000, 2500, .04], epic: [2500, 50001, .01] } , imageUrl: 'https://degwuxynwtb2zaso.public.blob.vercel-storage.com/machines/ewatch_500/imageNobg-MZQ83lYmSJBkIko0Xd1Hpj8VADBnQy.png' },
  { code: 'dragonball_50', name: 'Dragonball 50', category: 'Others', priceUsd: 50, buybackPct: 93, tiers: { common: [25, 50, .75], uncommon: [50, 100, .20], rare: [100, 250, .04], epic: [250, 5001, .01] } , imageUrl: 'https://degwuxynwtb2zaso.public.blob.vercel-storage.com/machines/dragonball_50/imageNobg-JfEttqWaHQSEi7PSoi7L80QQSaBQlp.png' },
  { code: 'riftbound_50', name: 'Riftbound 50', category: 'Others', priceUsd: 50, buybackPct: 93, tiers: { common: [25, 50, .75], uncommon: [50, 100, .20], rare: [100, 250, .04], epic: [250, 5001, .01] } , imageUrl: 'https://degwuxynwtb2zaso.public.blob.vercel-storage.com/machines/riftbound_50/imageNobg-IC9UY5cqAaVBAMg2LqCNICwBsTuWOg.png' },
  { code: 'anime_75', name: 'Anime Pop Culture Gacha', category: 'Others', priceUsd: 75, buybackPct: 85, tiers: { common: [40, 80, .80], uncommon: [80, 150, .15], rare: [150, 375, .04], epic: [375, 7001, .01] } , imageUrl: 'https://degwuxynwtb2zaso.public.blob.vercel-storage.com/machines/anime_75/imageNobg-SSFMM5xnjcbIMIqfPa42R2iGRCiMIT.png' },
  { code: 'dragonball_100', name: 'Dragonball 100', category: 'Others', priceUsd: 100, buybackPct: 93, tiers: { common: [50, 100, .75], uncommon: [100, 200, .20], rare: [200, 500, .04], epic: [500, 10001, .01] } , imageUrl: 'https://degwuxynwtb2zaso.public.blob.vercel-storage.com/machines/dragonball_100/imageNobg-l4V1pRfZl1ejJMP7OA7mlr1vWsxp6N.png' },
  { code: 'riftbound_100', name: 'Riftbound 100', category: 'Others', priceUsd: 100, buybackPct: 93, tiers: { common: [50, 100, .75], uncommon: [100, 200, .20], rare: [200, 500, .04], epic: [500, 10001, .01] } , imageUrl: 'https://degwuxynwtb2zaso.public.blob.vercel-storage.com/machines/riftbound_100/imageNobg-m1DbTuoj8AE6jHryiHzHWlP2t1GSKq.png' },
  { code: 'dragonball_250', name: 'Dragonball 250', category: 'Others', priceUsd: 250, buybackPct: 93, tiers: { common: [125, 250, .75], uncommon: [250, 500, .20], rare: [500, 1250, .04], epic: [1250, 25001, .01] } , imageUrl: 'https://degwuxynwtb2zaso.public.blob.vercel-storage.com/machines/dragonball_250/imageNobg-Vx5wpU0Eu9KiCQKGBnDdTTkyLhNewm.png' },
  { code: 'riftbound_250', name: 'Riftbound 250', category: 'Others', priceUsd: 250, buybackPct: 93, tiers: { common: [125, 250, .75], uncommon: [250, 500, .20], rare: [500, 1250, .04], epic: [1250, 25001, .01] } , imageUrl: 'https://degwuxynwtb2zaso.public.blob.vercel-storage.com/machines/riftbound_250/imageNobg-GDqmhuNn43uNjoIPV0M1rzP4sjw8JN.png' },
];

function fromLive(g) {
  return {
    code: g.code,
    name: g.name,
    category: g.menuCategory,
    priceUsd: g.price?.amount,
    buybackPct: g.instantBuyback?.percentageOfValue,
    tiers: Object.fromEntries(Object.entries(g.tierRanges ?? {}).map(([k, v]) => [k, [v.start, v.end, g.weightMultipliers?.[k] ?? 0]])),
    // Collector Crypt's official pack picture (shown only if "officialPackArt" is on)
    imageUrl: g.imageNobgUrl ?? g.thumbnailUrl ?? null,
  };
}

export async function loadCatalog({ live = true } = {}) {
  if (live) {
    try {
      const res = await fetch(LIVE_URL, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const all = await res.json();
      const machines = all.filter((g) => g.public && !g.archived).map(fromLive);
      if (machines.length) return { source: 'live', machines };
    } catch (err) {
      // fall through to the bundled copy
      if (process.env.DEBUG) console.warn(`live pack list failed: ${err.message}`);
    }
  }
  return { source: 'bundled', machines: FALLBACK };
}

export async function getMachine(code, opts) {
  const { machines, source } = await loadCatalog(opts);
  const m = machines.find((x) => x.code === code);
  if (!m) {
    const codes = machines.map((x) => x.code).join(', ');
    throw new Error(`Unknown pack "${code}". Available (${source}): ${codes}`);
  }
  return { ...m, source };
}
