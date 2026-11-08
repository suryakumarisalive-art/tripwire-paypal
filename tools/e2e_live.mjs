// Live check of the DEPLOYED Worker over HTTP: real Durable Object, real alarms, real PayPal sandbox, real Groq.
// Needs no secrets on this machine (the Worker holds them). Usage: node tools/e2e_live.mjs [baseUrl]
// The buyer checkout (PayPal or Venmo button) needs a person to log in as a sandbox buyer, so it is checked by hand.
const BASE = (process.argv[2] || 'https://tripwire-demo.suryakumarisalive.workers.dev').replace(/\/$/, '');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) failures++; };

async function call(path, body) {
  const init = body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: BASE }, body: JSON.stringify(body) };
  const r = await fetch(`${BASE}${path}`, init);
  const j = await r.json().catch(() => ({}));
  if (!r.ok && r.status !== 409) throw new Error(`${path} -> HTTP ${r.status}: ${j.error || ''}`);
  return j;
}

const health = await call('/api/health');
check(health.paypal && health.ai, `deployment has PayPal and AI configured (${JSON.stringify(health)})`);
if (!health.paypal || !health.ai) { console.log('Upload the secrets first: tools/set_secrets.ps1'); process.exit(1); }

const { storeId } = await call('/api/session', {});
const S = `?store=${storeId}`;
const state = () => call(`/api/store/state${S}`);
const item = async (sku) => (await state()).catalog.find((c) => c.sku === sku);
const presets = Object.fromEntries((await call('/api/presets')).presets.map((p) => [p.id, p.csv]));
console.log(`store ${storeId}`);

console.log('--- Scene 1: decimal slip, swarm, fix');
await call(`/api/store/import${S}`, { csv: presets.decimal_slip });
let tv = await item('TV-BRAVIA-65');
check(tv.status === 'held', `TV held: ${tv.reasons.map((r) => `${r.source}:${r.code}`).join(', ')}`);
check(tv.reasons.some((r) => r.source === 'ai'), `AI explanation present: ${tv.ai ? tv.ai.explanation : '(none)'}`);
const s1 = await call(`/api/store/swarm${S}`, { sku: 'TV-BRAVIA-65', n: 25 });
check(s1.refused === 25 && s1.authorized === 0, `swarm on held price: ${JSON.stringify(s1)}`);
await call(`/api/store/hold${S}`, { sku: 'TV-BRAVIA-65', action: 'fix', priceCents: tv.priceCents });
check((await item('TV-BRAVIA-65')).priceCents === 129900, 'fixed to $1,299.00');

console.log('--- Scene 2 and the sale');
await call(`/api/store/import${S}`, { csv: presets.new_products });
const pods = await item('AIRPODS-PRO2'); const anker = await item('ANKER-737');
check(pods.status === 'held', `AirPods at $24.90 held (AI: ${pods.ai ? pods.ai.explanation : 'none'})`);
check(anker.status === 'live', `Anker at $109.99 live (AI: ${anker.ai ? anker.ai.verdict : 'none'})`);
await call(`/api/store/import${S}`, { csv: presets.black_friday });
for (const sku of ['HP-SONY-XM5', 'VAC-DYSON-V15']) { const c = await item(sku); check(c.status === 'live', `${c.name} sale at ${c.priceCents / 100}: ${c.status}`); }

console.log('--- Scene 3: confirmed by mistake, bots rush, breaker trips, alarm settles, merchant voids');
await call(`/api/store/price${S}`, { sku: 'LEGO-75192', price: '84.99' });
await call(`/api/store/hold${S}`, { sku: 'LEGO-75192', action: 'confirm', priceCents: 8499 });
await wait(11_000); // swarm cooldown
const s3 = await call(`/api/store/swarm${S}`, { sku: 'LEGO-75192', n: 25 });
check(s3.authorized === 5 && s3.refused === 20, `swarm: ${JSON.stringify(s3)}`);
console.log('      waiting 30s for the Durable Object alarm to run settlement…');
await wait(30_000);
const lego = await item('LEGO-75192');
check(lego.status === 'tripped' && lego.awaiting === 5, `alarm settled: tripped item not captured, ${lego.awaiting} waiting for the merchant`);
const d = await call(`/api/store/decide${S}`, { sku: 'LEGO-75192', action: 'void' });
check(d.count === 5, `merchant voided ${d.count} on PayPal`);

console.log('--- Review: a deep sale keeps selling; capture waits for one click');
// The real AI decides between review (ok/suspicious) and held (implausible), so try steep drops until one is in review.
let rev = null;
for (const [sku, price] of [['VAC-DYSON-V15', '349.99'], ['CHAIR-AERON', '599.00'], ['HP-SONY-XM5', '169.99']]) {
  await call(`/api/store/price${S}`, { sku, price });
  const c = await item(sku);
  console.log(`      ${c.name} at $${price}: ${c.status} (${c.reasons.map((r) => `${r.source}:${r.code}`).join(', ')})`);
  if (c.status === 'review') { rev = c; break; }
}
check(rev !== null, 'a steep drop the AI did not call implausible is under review (selling, capture waits)');
if (rev) {
  await wait(11_000);
  const sr = await call(`/api/store/swarm${S}`, { sku: rev.sku, n: 2 });
  check(sr.authorized === 2, `2 checkouts authorized on the review price: ${JSON.stringify(sr)}`);
  console.log('      waiting 30s for settlement (it must NOT capture)…');
  await wait(30_000);
  const w = await item(rev.sku);
  check(w.status === 'review' && w.awaiting === 2, `settlement left ${w.awaiting} waiting, nothing captured`);
  const conf = await call(`/api/store/hold${S}`, { sku: rev.sku, action: 'confirm', priceCents: rev.priceCents });
  check(conf.captured === 2 && conf.status === 'live', `one click: confirmed and captured ${conf.captured}`);
  const caps = (await state()).orders.filter((o) => o.sku === rev.sku && o.status === 'captured');
  check(caps.length === 2 && caps.every((o) => /^[A-Z0-9]{17}$/.test(o.captureId || '')), `PayPal captures: ${caps.map((o) => o.captureId).join(', ')}`);
}

console.log('--- Capture path: a normal order on a live price is captured by the alarm');
await wait(11_000);
const one = await call(`/api/store/swarm${S}`, { sku: 'DRONE-MINI4', n: 1 });
check(one.authorized === 1, `one checkout authorized on a live price: ${JSON.stringify(one)}`);
console.log('      waiting 30s for settlement…');
await wait(30_000);

const end = await state();
const orders = end.orders;
check(orders.filter((o) => o.sku === 'LEGO-75192' && o.status === 'voided').length === 5, 'all 5 LEGO authorizations voided');
const kettle = orders.find((o) => o.sku === 'DRONE-MINI4');
check(kettle && kettle.status === 'captured' && /^[A-Z0-9]{17}$/.test(kettle.captureId || ''), `drone captured by the alarm (capture ${kettle?.captureId})`);
const errors = end.timeline.filter((e) => e.kind === 'PAYPAL_ERROR' || e.kind === 'AI_ERROR');
check(!errors.length, `no PayPal or AI errors${errors.length ? `: ${errors.map((e) => e.message).join(' | ')}` : ''}`);
console.log(`      summary: ${JSON.stringify(end.summary)}`);
console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nALL LIVE CHECKS PASSED');
process.exit(failures ? 1 : 0);
