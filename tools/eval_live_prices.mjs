// Today's-prices evaluation of the Channel3 evidence. The 6 Nov eval cases are historical prices, and Channel3 returns
// today's, so they cannot test it. This takes real products at their current US list price, makes two genuine sale
// prices and two mistake prices for each, and decides each as a NEW item (no history, no cost: the AI is the only check):
//   without: the price call alone (exactly what the store decides with no evidence);
//   with:    the same price call, then the titles-only matching call on Channel3 listings, then groundVerdict (only tightens).
// Production settings: Channel3 lookup timeout 8 s; matching call 12 s. The price call gets 90 s so a tokens-per-minute
// wait is sat out honestly (this measures decisions, not latency).
// Usage: node --dns-result-order=ipv4first tools/eval_live_prices.mjs [outFile]
// The Groq key is read from the single .txt file in ~/.dg_groq_key; nothing secret is printed.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { checkPrice } from '../src/rules.mjs';
import { reviewPrices, matchListings, groundVerdict, combine } from '../src/ai.mjs';
import { createMarket } from '../src/market.mjs';

const outFile = process.argv[2] || 'eval/live_prices.json';
const groqKey = process.env.GROQ_API_KEY || (() => { const d = join(homedir(), '.dg_groq_key'); return readFileSync(join(d, readdirSync(d).find((f) => f.endsWith('.txt'))), 'utf8').trim(); })();

// Current US list prices (Channel3 probe, 7 Nov 2026, and the retailers' own listings).
const PRODUCTS = [
  ['TCL 85-inch Q5K Series 4K QLED Google TV', 'TVs', 119999],
  ['TCL 65-inch QM5K Series QD-Mini LED Google TV', 'TVs', 89999],
  ['Sony WH-1000XM5 Wireless Noise Canceling Headphones', 'Audio', 39999],
  ['Dyson V15 Detect Cordless Vacuum', 'Home', 74999],
  ['Ring Battery Doorbell', 'Smart home', 9999],
  ['Acer Chromebook 315 15.6-inch Intel N4500 4GB 64GB eMMC', 'Computing', 21800],
  ["The North Face Women's Apex Bionic Jacket", 'Apparel', 15000],
  ['Sony Bravia 7 65" 4K Mini LED TV', 'TVs', 129900],
  ['LEGO Star Wars Millennium Falcon 75192', 'Toys', 84999],
  ['DJI Mini 4 Pro Drone', 'Cameras', 75900],
  ['Herman Miller Aeron Chair, Size B', 'Office', 139500],
  ['Keychron Q1 Pro Mechanical Keyboard', 'Computing', 19900],
  ['Fellow Stagg EKG Electric Kettle', 'Kitchen', 16500],
  ['Apple AirPods Pro 2 (USB-C)', 'Audio', 24900],
  ['Anker 737 Power Bank 24000mAh', 'Accessories', 10999],
  ['Corsair Dominator Titanium RGB 48GB (2x24GB) DDR5 memory kit', 'Computing', 50000],
];
const VARIANTS = [['sale', 0.75, 'sale 25% off'], ['sale', 0.55, 'sale 45% off'], ['mistake', 0.3, 'mistake 70% off'], ['mistake', 0.1, 'mistake: slipped decimal']];
const rows = PRODUCTS.flatMap(([name, category, cents], i) => VARIANTS.map(([kind, f, label], j) => ({
  sku: `P${i + 1}V${j + 1}`, name, category, description: '', newCents: Math.round(cents * f), oldCents: null, costCents: null, kind, label, listCents: cents,
})));

// 1. The price call, exactly as the store makes it (batches of 25, no listings).
const verdicts = new Map();
for (let i = 0; i < rows.length; i += 25) {
  const b = rows.slice(i, i + 25);
  const r = await reviewPrices(b, { groqKey, timeoutMs: 90_000 });
  if (!r.ok) console.error(`price batch failed: ${r.error}`);
  for (const row of b) verdicts.set(row.sku, r.ok ? { ok: true, verdict: r.verdicts.get(row.sku) } : { ok: false, error: r.error });
}

// 2. Channel3, one search per product (the store caps a lookup at 10 names; this eval asks for all 16).
const evidence = await createMarket({ maxNames: PRODUCTS.length, timeoutMs: 30_000 })(PRODUCTS.map((p) => p[0])); // eval only: 16 searches need longer than the store's 8 s
console.log(`Channel3 answered for ${[...evidence.values()].filter((v) => v.listings.length).length} of ${PRODUCTS.length} products`);

// 3. The titles-only matching call, once per product (matching does not depend on the price).
const productRows = PRODUCTS.map(([name], i) => ({ sku: `P${i + 1}`, name, listings: evidence.get(name)?.listings })).filter((r) => r.listings?.length);
await new Promise((r) => setTimeout(r, 65_000)); // eval only: let the tokens-per-minute window reset after 3 price calls
const m = await matchListings(productRows, { groqKey, timeoutMs: 90_000 });
if (!m.ok) console.error(`matching call failed: ${m.error}`);

const decide = (r, a) => combine(checkPrice({ newCents: r.newCents }), a, r.newCents).status;
const results = rows.map((r) => {
  const p = r.sku.split('V')[0];
  const refs = m.ok ? m.matches.get(p) || [] : [];
  const listings = evidence.get(r.name)?.listings;
  const a = verdicts.get(r.sku);
  const g = a.ok && a.verdict && refs.length ? groundVerdict(a.verdict, { ...r, listings }, refs) : a.verdict;
  return { sku: r.sku, name: r.name, label: r.label, kind: r.kind, price: r.newCents, list: r.listCents,
    listings: listings?.length || 0, matched: refs.length, liveLow: g?.evidence?.lowCents ?? null,
    aiWord: a.verdict?.verdict || (a.ok ? 'none' : 'error'), groundedWord: g?.verdict || 'none',
    without: decide(r, a), withEvidence: decide(r, a.ok ? { ok: true, verdict: g } : a) };
});

const tally = (key, kind) => { const t = { held: 0, review: 0, live: 0 }; for (const r of results.filter((x) => x.kind === kind)) t[r[key]]++; return t; };
const summary = {
  ranAt: new Date().toISOString(), model: 'openai/gpt-oss-120b via Groq', design: 'price call without listings + titles-only matching call; evidence only tightens',
  products: PRODUCTS.length, rows: results.length,
  productsWithListings: productRows.length, productsMatched: [...(m.ok ? m.matches.values() : [])].filter((x) => x.length).length,
  sales: { without: tally('without', 'sale'), withEvidence: tally('withEvidence', 'sale') },
  mistakes: { without: tally('without', 'mistake'), withEvidence: tally('withEvidence', 'mistake') },
  changed: results.filter((r) => r.withEvidence !== r.without).map((r) => `${r.sku} ${r.name} ${r.label} $${r.price / 100}: ${r.without} -> ${r.withEvidence} (AI ${r.aiWord} -> ${r.groundedWord}, live low $${(r.liveLow ?? 0) / 100})`),
};
writeFileSync(outFile, JSON.stringify({ summary, results }, null, 2));
console.log(JSON.stringify(summary, null, 2));
