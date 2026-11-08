// Live end-to-end check (AC8): the real StoreCore against the real PayPal sandbox and the real Groq API, all demo scenes.
// Run through tools/run_sandbox.ps1 so the PayPal sandbox credentials arrive in DG_ID / DG_SECRET; the Groq key is read
// from the single .txt file in ~/.dg_groq_key. Nothing secret is printed. Exit code 1 on any failed check.
import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { StoreCore } from '../src/store.mjs';
import { createPayPal } from '../src/paypal.mjs';
import { reviewPrices } from '../src/ai.mjs';
import { DEMO_IMPORTS } from '../src/seed.mjs';
import { parseCsv } from '../src/csv.mjs';
import { sqlAdapter } from '../test/helpers.mjs';

const keyDir = join(homedir(), '.dg_groq_key');
const groqKey = readFileSync(join(keyDir, readdirSync(keyDir).find((f) => f.endsWith('.txt'))), 'utf8').trim();
const real = createPayPal({ clientId: process.env.DG_ID, clientSecret: process.env.DG_SECRET });
const counts = {};
const paypal = Object.fromEntries(Object.entries(real).map(([k, fn]) => [k, async (...a) => { counts[k] = (counts[k] || 0) + 1; return fn(...a); }]));
const store = new StoreCore({
  sql: sqlAdapter(), paypal, reviewAi: (rows) => reviewPrices(rows, { groqKey }),
  config: { coolingMs: 1500, swarmCooldownMs: 0, maxPerWindow: 5 },
});
store.init();

let failures = 0;
const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) failures++; };
const item = (sku) => store.catalog().find((c) => c.sku === sku);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const importPreset = (name) => store.applyPriceChanges(parseCsv(DEMO_IMPORTS[name].csv).rows);

console.log('--- Scene 1: decimal slip');
await importPreset('decimal_slip');
const tv = item('TV-BRAVIA-65');
check(tv.status === 'held', `TV held at ${tv.priceCents / 100} (${tv.reasons.map((r) => r.code).join(', ')})`);
console.log(`      AI said: ${tv.ai ? `${tv.ai.verdict}: ${tv.ai.explanation}` : '(no verdict)'}`);
check(item('KB-Q1PRO').status === 'live', 'Keyboard 199 -> 189 went live with no AI call needed');
const createsBefore = counts.createOrder || 0;
const s1 = await store.swarm('TV-BRAVIA-65', 25);
check(s1.refused === 25 && s1.authorized === 0, `swarm on held TV: ${JSON.stringify(s1)}`);
check((counts.createOrder || 0) === createsBefore, 'PayPal was never called for the held price');
store.resolveHold('TV-BRAVIA-65', 'fix');
const buy = await store.botCheckout('TV-BRAVIA-65');
check(buy.ok, `after fix, a checkout at $1,299.00 is authorized by PayPal (order ${buy.paypalOrderId}, authorization ${buy.authorizationId})`);
await wait(1700);
const st1 = await store.settle();
const o1 = store.orders().find((o) => o.authorizationId === buy.authorizationId);
check(st1.captured === 1 && o1?.status === 'captured', `settlement captured it at the confirmed price (capture ${o1?.captureId})`);

console.log('--- Scene 2: new products with no history or cost');
await importPreset('new_products');
const pods = item('AIRPODS-PRO2'); const anker = item('ANKER-737');
check(pods.status === 'held', `AirPods Pro 2 at $24.90 held (${pods.reasons.map((r) => r.code).join(', ')})`);
console.log(`      AI said: ${pods.ai ? `${pods.ai.verdict}: ${pods.ai.explanation}` : '(no verdict)'}`);
check(anker.status === 'live', `Anker 737 at $109.99 live (AI: ${anker.ai ? anker.ai.verdict : 'none'})`);

console.log('--- Black Friday sale (should NOT be blocked)');
await importPreset('black_friday');
for (const sku of ['HP-SONY-XM5', 'VAC-DYSON-V15']) { const c = item(sku); check(c.status === 'live', `${c.name} at ${c.priceCents / 100}: ${c.status} (AI: ${c.ai ? `${c.ai.verdict} - ${c.ai.explanation}` : 'none'})`); }

console.log('--- Scene 3: a wrong price confirmed by mistake, then bots rush it');
await store.applyPriceChanges([{ sku: 'LEGO-75192', price: '84.99' }]);
check(item('LEGO-75192').status === 'held', 'LEGO $849.99 -> $84.99 held by code');
store.resolveHold('LEGO-75192', 'confirm');
const s3 = await store.swarm('LEGO-75192', 25);
check(s3.authorized === 5 && s3.refused === 20, `swarm: ${JSON.stringify(s3)}`);
check(item('LEGO-75192').status === 'tripped', 'breaker tripped');
await wait(1700);
const st3 = await store.settle();
check(st3.captured === 0 && st3.held === 5, `settlement captured nothing on the tripped item: ${JSON.stringify(st3)}`);
const d3 = await store.decideOrders('LEGO-75192', 'void');
const voided = store.orders().filter((o) => o.sku === 'LEGO-75192' && o.status === 'voided');
check(d3.count === 5 && voided.length === 5, `merchant voided all 5 on PayPal: ${voided.map((o) => o.authorizationId).join(', ')}`);

console.log('--- Totals');
console.log(`      PayPal calls: ${JSON.stringify(counts)}`);
console.log(`      Summary: ${JSON.stringify(store.summary())}`);
const errors = store.timeline().filter((e) => e.kind === 'PAYPAL_ERROR' || e.kind === 'AI_ERROR');
check(errors.length === 0, `no PayPal or AI errors on the timeline${errors.length ? `: ${errors.map((e) => e.message).join(' | ')}` : ''}`);
console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nALL LIVE CHECKS PASSED');
process.exit(failures ? 1 : 0);
