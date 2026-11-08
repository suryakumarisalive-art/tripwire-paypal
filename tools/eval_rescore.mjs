// Re-score recorded eval runs with the store's CURRENT rules and combine(), using the AI answers already recorded.
// No network, no key: the AI is not asked again, so policy changes are measured on exactly the same AI answers.
// Usage: node tools/eval_rescore.mjs eval/results.json [eval/results_run2.json ...]
import { readFileSync } from 'node:fs';
import { checkPrice } from '../src/rules.mjs';
import { combine } from '../src/ai.mjs';

const files = process.argv.slice(2);
if (!files.length) { console.error('usage: node tools/eval_rescore.mjs <results.json> [...]'); process.exit(2); }

// The recorded AI answer as the store would have received it.
function recordedAi(r) {
  if (r.aiVerdict === 'error') return { ok: false, error: 'recorded AI error' };
  if (!r.aiRange || r.aiVerdict === 'none') return { ok: true };
  return { ok: true, verdict: { verdict: r.aiVerdict, marketLowCents: r.aiRange[0], marketHighCents: r.aiRange[1], explanation: r.aiExplanation || '', likelyCause: 'unknown' } };
}

// What the store decides for one case: 'held' (checkout refused), 'review' (sells; capture waits), 'live'.
function decide(r, known) {
  const rule = checkPrice({ newCents: r.price, oldCents: known ? r.normal : null, costCents: null, medianCents: known ? r.normal : null });
  const asked = rule.holds.length > 0 || rule.needsAi; // the store only asks the AI about prices it cannot vouch for
  return combine(rule, asked ? recordedAi(r) : null, r.price).status;
}

const out = {};
for (const f of files) {
  const data = JSON.parse(readFileSync(f, 'utf8'));
  for (const [mode, rows] of [['known', data.known], ['new', data.new]]) {
    const tally = (kind) => {
      const t = { held: [], review: [], live: [] };
      for (const r of rows.filter((x) => x.kind === kind)) t[decide(r, mode === 'known')].push(r.id);
      return t;
    };
    out[`${f} ${mode}`] = { mistakes: tally('mistake'), sales: tally('sale') };
  }
}
for (const [k, v] of Object.entries(out)) {
  const n = (t) => `refused ${t.held.length}, sells but capture waits ${t.review.length}, live ${t.live.length}`;
  console.log(`${k}\n  mistakes: ${n(v.mistakes)}  (missed: ${v.mistakes.live.join(' ') || 'none'})\n  sales:    ${n(v.sales)}  (refused: ${v.sales.held.join(' ') || 'none'}; waits: ${v.sales.review.join(' ') || 'none'})`);
}
