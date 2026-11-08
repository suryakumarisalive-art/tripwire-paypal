// Evaluation: Tripwire's price check on REAL cases (documented pricing mistakes and documented genuine sales).
// Usage: node tools/eval.mjs <eval_cases.json> [outDir]
// Runs every case two ways:
//   known item: the store knows the item's normal price (last good price and 30-day typical) -> rules, then the AI;
//   new item:   the store has never sold it (no history, no cost) -> the rules cannot judge, only the AI can.
// Reports, for each way: mistakes held (want all) and genuine sales held (want none), rules alone vs rules + AI.
// The Groq key is read from the single .txt file in ~/.dg_groq_key; nothing secret is printed.
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { checkPrice } from '../src/rules.mjs';
import { reviewPrices, combine } from '../src/ai.mjs';

const [file, outDir = 'eval'] = process.argv.slice(2);
if (!file) { console.error('usage: node tools/eval.mjs <eval_cases.json> [outDir]'); process.exit(2); }
const data = JSON.parse(readFileSync(file, 'utf8'));
const groqKey = process.env.GROQ_API_KEY || (() => { const d = join(homedir(), '.dg_groq_key'); return readFileSync(join(d, readdirSync(d).find((f) => f.endsWith('.txt'))), 'utf8').trim(); })();
const cents = (usd) => Math.round(Number(usd) * 100);

const cases = [
  ...data.mistakes.map((m) => ({ id: m.id, kind: 'mistake', product: m.product, category: m.category || '', normal: cents(m.normal_price_usd), price: cents(m.error_price_usd), source: m.source_url, status: m.status })),
  ...data.genuine_sales.map((s) => ({ id: s.id, kind: 'sale', product: s.product, category: s.category || '', normal: cents(s.regular_price_usd), price: cents(s.sale_price_usd), source: s.source_url, status: s.status })),
].filter((c) => Number.isSafeInteger(c.normal) && c.normal > 0 && Number.isSafeInteger(c.price) && c.price > 0);

async function aiFor(rows) { // batches of 25, like the store
  const out = new Map();
  for (let i = 0; i < rows.length; i += 25) {
    const batch = rows.slice(i, i + 25);
    const r = await reviewPrices(batch, { groqKey, timeoutMs: 90_000 }); // long budget: wait out the tokens-per-minute limit honestly
    if (!r.ok) console.error(`batch ${i / 25 + 1}: ${r.error}`);
    if (r.truncated) console.error(`batch ${i / 25 + 1}: answer was cut off`);
    for (const row of batch) out.set(row.sku, { ok: r.ok, error: r.error, verdict: r.verdicts.get(row.sku) });
  }
  return out;
}

async function run(mode) {
  const rows = cases.map((c) => ({
    sku: c.id, name: c.product, category: c.category, description: '', newCents: c.price,
    oldCents: mode === 'known' ? c.normal : null, costCents: null,
  }));
  const rules = new Map(cases.map((c) => [c.id, checkPrice({ newCents: c.price, oldCents: mode === 'known' ? c.normal : null, costCents: null, medianCents: mode === 'known' ? c.normal : null })]));
  // The store asks the AI about every price the rules hold or cannot vouch for; here we ask about every case so the
  // AI's own accuracy is visible too, then apply exactly the store's combine() to decide.
  const ai = await aiFor(rows);
  return cases.map((c) => {
    const rule = rules.get(c.id);
    const a = ai.get(c.id);
    const rulesOnlyHeld = rule.holds.length > 0 || rule.needsAi; // without an AI, an unvouched price is held (fail closed)
    const rulesOnlyHeldStrict = rule.holds.length > 0;           // rules that actually fire
    const final = combine(rule, a, c.price);
    return {
      id: c.id, kind: c.kind, product: c.product, normal: c.normal, price: c.price,
      ruleCodes: rule.holds.map((h) => h.code), needsAi: rule.needsAi,
      rulesFire: rulesOnlyHeldStrict, rulesFailClosed: rulesOnlyHeld,
      aiVerdict: a?.verdict?.verdict || (a?.ok ? 'none' : 'error'), aiRange: a?.verdict ? [a.verdict.marketLowCents, a.verdict.marketHighCents] : null,
      aiExplanation: a?.verdict?.explanation || '', held: final.status === 'held', source: c.source,
    };
  });
}

function score(results) {
  const m = results.filter((r) => r.kind === 'mistake'); const s = results.filter((r) => r.kind === 'sale');
  const pct = (n, d) => (d ? `${n}/${d} (${Math.round((n / d) * 100)}%)` : '0/0');
  return {
    mistakesHeld_rulesFire: pct(m.filter((r) => r.rulesFire).length, m.length),
    mistakesHeld_tripwire: pct(m.filter((r) => r.held).length, m.length),
    salesBlocked_rulesFailClosed: pct(s.filter((r) => r.rulesFailClosed).length, s.length),
    salesBlocked_tripwire: pct(s.filter((r) => r.held).length, s.length),
    missed: m.filter((r) => !r.held).map((r) => `${r.id} ${r.product} ${r.price / 100} (normal ${r.normal / 100}) AI:${r.aiVerdict}`),
    falseHolds: s.filter((r) => r.held).map((r) => `${r.id} ${r.product} ${r.price / 100} (regular ${r.normal / 100}) AI:${r.aiVerdict} ${r.aiExplanation}`),
  };
}

const known = await run('known');
const fresh = await run('new');
const summary = { cases: { mistakes: cases.filter((c) => c.kind === 'mistake').length, sales: cases.filter((c) => c.kind === 'sale').length }, knownItem: score(known), newItem: score(fresh), model: 'openai/gpt-oss-120b via Groq', ranAt: new Date().toISOString() };
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'results.json'), JSON.stringify({ summary, known, new: fresh }, null, 2));
console.log(JSON.stringify(summary, null, 2));
