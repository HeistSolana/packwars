// Lists every pack machine you can duel with. Run: npm run packs
import { loadCatalog } from './packs/catalog.js';

const { source, machines } = await loadCatalog();
console.log(`Pack machines (${source} list). Put the code in config.json as "pack".\n`);
const rows = [...machines].sort((a, b) => a.category.localeCompare(b.category) || a.priceUsd - b.priceUsd);
let cat = null;
for (const m of rows) {
  if (m.category !== cat) { cat = m.category; console.log(`\n${cat}`); }
  const epic = m.tiers.epic;
  console.log(
    `  ${m.code.padEnd(16)} $${String(m.priceUsd).padEnd(5)} ${m.name.padEnd(32)}` +
    ` buyback ${m.buybackPct}%  top tier ${Math.round(epic[2] * 100)}% for $${epic[0]}+`,
  );
}
