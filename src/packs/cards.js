// Real card data: the photo, name, grade and insured value of graded cards.
//
// - loadMachineCards(code): every card currently sitting in a pack machine.
//   Mock mode draws from this pool, so test duels show real cards and photos.
// - readCard(rpc, mint): the card behind an NFT mint, via the DAS getAsset call
//   (Helius, Triton and most paid RPCs support it). Live mode uses this right
//   after a pull so the page shows the exact slab the holder won.

const BASE = 'https://gacha.collectorcrypt.com/api/getNfts';

const attr = (list, name) => list?.find((a) => a.trait_type === name)?.value;

function gradeOf(attrs) {
  const company = attr(attrs, 'Grading Company');
  const grade = attr(attrs, 'The Grade') ?? attr(attrs, 'Grade');
  const num = grade?.match(/\d+(\.\d+)?/)?.[0];
  return company ? `${company}${num ? ` ${num}` : ''}` : grade ?? 'Graded';
}

const RARITY = { common: 'Common', uncommon: 'Uncommon', rare: 'Rare', epic: 'Epic' };

function fromMachine(n) {
  return {
    name: n.description || n.name,
    rarity: RARITY[n.rarity] ?? n.rarity,
    tier: n.rarity,
    grade: gradeOf(n.attributes),
    insuredValueUsd: Number(n.insured_value ?? attr(n.attributes, 'Insured Value')),
    image: n.image ?? n.content?.links?.image ?? null,
    nftMint: n.nft_address ?? n.id,
  };
}

/** Every card in a machine's pool, grouped by tier. Returns null if it can't load. */
export async function loadMachineCards(code, { maxPages = 60 } = {}) {
  try {
    const cards = [];
    let cursor = null, pages = 0;
    do {
      const url = `${BASE}?code=${encodeURIComponent(code)}&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      cards.push(...(body.nfts ?? []).map(fromMachine));
      cursor = body.hasMore ? body.nextCursor : null;
      pages++;
    } while (cursor && pages < maxPages);

    const byTier = {};
    for (const c of cards) if (c.insuredValueUsd > 0) (byTier[c.tier] ??= []).push(c);
    return cards.length ? { cards, byTier } : null;
  } catch (err) {
    if (process.env.DEBUG) console.warn(`card pool for ${code} failed: ${err.message}`);
    return null;
  }
}

/** Reads a pulled card from the chain by its NFT mint (DAS getAsset). */
export async function readCard(rpc, mint) {
  const a = await rpc.call('getAsset', [{ id: mint }]);
  const attrs = a.content?.metadata?.attributes ?? [];
  const files = a.content?.files ?? [];
  return {
    name: a.content?.metadata?.json_name ?? a.content?.metadata?.name,
    grade: gradeOf(attrs),
    insuredValueUsd: Number(attr(attrs, 'Insured Value')),
    image: files[0]?.cc_cdn ?? a.content?.links?.image ?? files[0]?.uri ?? null,
    imageBack: files[1]?.cc_cdn ?? files[1]?.uri ?? null,
    nftMint: mint,
  };
}
