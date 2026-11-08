// A real merchant's server using the Tripwire checkout API (docs/GATE.md) in front of ITS OWN PayPal integration, live:
// the deployed Worker, the real PayPal sandbox and the real AI check. It imports nothing from src/: Tripwire is two HTTP
// calls, and PayPal is this merchant's own REST calls with its own app credentials.
// Run after deploying, with your PayPal sandbox app credentials in PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET:
//   node tools/merchant_example.mjs
// Nothing secret is printed. Exits 1 on any FAIL.
import dns from 'node:dns';
dns.setDefaultResultOrder('ipv4first'); // Node's fetch to *.workers.dev times out on this laptop otherwise

const BASE = (process.env.TRIPWIRE_BASE || 'https://tripwire-demo.suryakumarisalive.workers.dev').replace(/\/$/, '');
const PAYPAL = 'https://api-m.sandbox.paypal.com';
// The public PayPal sandbox test card (sandbox test data; it never works outside the sandbox).
const CARD = { card: { number: '4032039317984658', expiry: '2030-12', security_code: '123', name: 'Merchant Example Buyer',
  billing_address: { address_line_1: '1 Main St', admin_area_2: 'San Jose', admin_area_1: 'CA', postal_code: '95131', country_code: 'US' } } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const value = (c) => `${Math.floor(c / 100)}.${String(c % 100).padStart(2, '0')}`;
let failures = 0;
const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) failures++; };

const PP_ID = process.env.PAYPAL_CLIENT_ID || process.env.DG_ID; const PP_SECRET = process.env.PAYPAL_CLIENT_SECRET || process.env.DG_SECRET;
if (!PP_ID || !PP_SECRET) { console.log('Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET (a PayPal sandbox app) in the environment first.'); process.exit(1); }

// ---- the merchant's own PayPal client ----
const counts = { createOrder: 0, capture: 0, void: 0 };
let token = null;
async function paypal(method, path, body, requestId) {
  if (!token) {
    const t = await fetch(`${PAYPAL}/v1/oauth2/token`, { method: 'POST', redirect: 'error', body: 'grant_type=client_credentials',
      headers: { Authorization: `Basic ${btoa(`${PP_ID}:${PP_SECRET}`)}`, 'Content-Type': 'application/x-www-form-urlencoded' } });
    const j = await t.json().catch(() => ({}));
    if (!t.ok || !j.access_token) throw new Error(`PayPal sign-in failed (HTTP ${t.status})`);
    token = j.access_token;
  }
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Prefer: 'return=representation' };
  if (requestId) headers['PayPal-Request-Id'] = requestId;
  const r = await fetch(`${PAYPAL}${path}`, { method, redirect: 'error', headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`PayPal ${method} ${path.split('/').slice(0, 4).join('/')} -> HTTP ${r.status} ${j.name || ''} debug_id ${j.debug_id || r.headers.get('paypal-debug-id') || ''}`);
  return j;
}

// ---- Tripwire ----
async function http(path, { body, headers = {} } = {}) {
  const r = await fetch(`${BASE}${path}`, body === undefined ? { headers } : { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${path.split('?')[0]} -> HTTP ${r.status}: ${j.error || ''}`);
  return j;
}
// Any error is printed as one safe line on stdout: run_sandbox.ps1 suppresses everything when a script writes to
// stderr (so a secret can never leak through an error), which would hide the cause. These messages never carry
// the PayPal token or the API key.
process.on('uncaughtException', (e) => { console.log(`FAIL  stopped: ${String(e && e.message).slice(0, 300)}`); process.exit(1); });
process.on('unhandledRejection', (e) => { console.log(`FAIL  stopped: ${String(e && e.message).slice(0, 300)}`); process.exit(1); });

// Onboarding, done once in the Tripwire console: a store, and the API key the console shows.
const { storeId } = await http('/api/session', { body: {}, headers: { Origin: BASE } });
const { apiKey } = await http(`/api/store/apikey?store=${storeId}`);
check(/^twk_[a-f0-9]{88}$/.test(apiKey) && !apiKey.includes(storeId), `API key issued (${apiKey.slice(0, 8)}…), and it is not the console credential`);
console.log(`      watch it live in the console: ${BASE}/?store=${storeId}`);
const tripwire = (action, body) => http(`/api/v1/${action}`, { body, headers: { Authorization: `Bearer ${apiKey}` } });

// The merchant's checkout, with Tripwire in front of it.
async function startCheckout(item) { // before creating a PayPal order
  const t0 = Date.now();
  const c = await tripwire('check', item);
  const ms = Date.now() - t0;
  if (c.decision !== 'allow') return { held: c, ms };
  counts.createOrder++;
  const o = await paypal('POST', '/v2/checkout/orders', { intent: 'AUTHORIZE', payment_source: CARD,
    // the whole order: priceCents is one unit; amountCents (priceCents x quantity) is what PayPal must authorize
    purchase_units: [{ reference_id: item.sku, custom_id: c.checkId, description: item.name || item.sku, amount: { currency_code: 'USD', value: value(c.amountCents ?? c.priceCents) } }] }, `create-${c.checkId}`);
  const auth = o.purchase_units?.[0]?.payments?.authorizations?.[0];
  return { sale: { checkId: c.checkId, amountCents: c.amountCents ?? c.priceCents, authorizationId: auth?.id }, authStatus: auth?.status, ms };
}
async function finishCheckout(sale, maxWaits = 3) { // before capturing
  for (let i = 0; ; i++) {
    const d = await tripwire('capture-check', sale);
    if (d.decision === 'capture') { counts.capture++; return { d, pp: await paypal('POST', `/v2/payments/authorizations/${sale.authorizationId}/capture`, { final_capture: true }, `capture-${sale.checkId}`) }; }
    if (d.decision === 'void') { counts.void++; await paypal('POST', `/v2/payments/authorizations/${sale.authorizationId}/void`, undefined, `void-${sale.checkId}`); return { d }; }
    if (i >= maxWaits) return { d }; // still waiting on the merchant's decision: leave the authorization alone
    console.log(`      capture-check says wait (${d.reason}); asking again in ${Math.ceil(d.retryAfterMs / 1000)} s`);
    await sleep(d.retryAfterMs + 500);
  }
}
const authStatus = async (id) => (await paypal('GET', `/v2/payments/authorizations/${id}`)).status;

console.log('--- Scene A: a normal sale on a brand-new item is allowed (the AI vouches) and captured');
const anker = { sku: 'MX-ANKER-737', name: 'Anker 737 Power Bank 24000mAh', priceCents: 10999, category: 'Accessories', description: '140W portable charger' };
const a = await startCheckout(anker);
check(!!a.sale && a.authStatus === 'CREATED', `check allowed $109.99 in ${a.ms} ms; PayPal authorized it (${a.sale ? a.sale.authorizationId : a.held.code}: ${a.authStatus || a.held.message})`);
if (a.sale) {
  const early = await tripwire('capture-check', a.sale);
  check(early.decision === 'wait' && early.reason === 'COOLING', `an immediate capture-check says wait (${early.reason}, ${early.retryAfterMs} ms): a bot rush trips the breaker first`);
  const fa = await finishCheckout(a.sale);
  check(fa.d.decision === 'capture' && fa.pp?.status === 'COMPLETED', `capture-check cleared it; PayPal capture ${fa.pp ? `${fa.pp.id} ${fa.pp.status}` : 'not made'}`);
  check(await authStatus(a.sale.authorizationId) === 'CAPTURED', 'PayPal shows the authorization CAPTURED');
  const again = await tripwire('capture-check', a.sale);
  check(again.decision === 'capture' && again.repeat === true, 'a repeat capture-check answers capture again (safe to retry)');
}

console.log('--- Scene B: the merchant\'s feed slips a decimal: held, and no PayPal order is ever created');
const before = counts.createOrder;
const b = await startCheckout({ ...anker, priceCents: 1099 });
check(b.held?.decision === 'hold' && b.held.code === 'HELD' && b.held.checkId === null, `$10.99 held: ${b.held ? b.held.message : 'NOT HELD'}`);
check(counts.createOrder === before, 'the merchant created no PayPal order');

console.log('--- Scene C: the price changes after the buyer authorized: capture-check says void');
const kettle = { sku: 'MX-KETTLE-EKG', name: 'Fellow Stagg EKG Electric Kettle', priceCents: 16500, costCents: 9500, category: 'Kitchen' };
const c = await startCheckout(kettle);
check(!!c.sale && c.authStatus === 'CREATED', `check allowed $165.00 in ${c.ms} ms (a new SKU: the AI vouched); PayPal authorized it`);
const sale = await tripwire('check', { ...kettle, priceCents: 14900 });
check(sale.decision === 'allow', `a sale at $149.00 goes live (${sale.code})`);
if (c.sale) {
  const fc = await finishCheckout(c.sale);
  check(fc.d.decision === 'void' && fc.d.reason === 'PRICE_CHANGED', `capture-check on the $165.00 authorization: ${fc.d.decision} (${fc.d.message})`);
  check(await authStatus(c.sale.authorizationId) === 'VOIDED', 'PayPal shows the authorization VOIDED: the buyer is not charged more than the live price');
}

console.log('--- Scene D: one order for several units: PayPal authorizes price x quantity, and capture-check clears exactly that');
console.log('      waiting 61 s so scene C\'s kettle sales leave the breaker\'s 60 s window (3 + 2 units = its limit of 5)');
await sleep(61_000);
const d = await startCheckout({ ...kettle, priceCents: 14900, quantity: 3 });
check(!!d.sale && d.sale.amountCents === 44700 && d.authStatus === 'CREATED', `check allowed 3 x $149.00 = $${d.sale ? value(d.sale.amountCents) : '-'}; PayPal authorized the whole order`);
if (d.sale) {
  const one = await tripwire('capture-check', { ...d.sale, amountCents: 14900 });
  check(one.decision === 'void' && one.reason === 'AMOUNT_MISMATCH', `capture-check for one unit's price on the 3-unit check: ${one.decision} (${one.reason})`);
  counts.void++; await paypal('POST', `/v2/payments/authorizations/${d.sale.authorizationId}/void`, undefined, `void-${d.sale.checkId}`);
}
const d2 = await startCheckout({ ...kettle, priceCents: 14900, quantity: 2 });
if (d2.sale) {
  const fd = await finishCheckout(d2.sale);
  check(fd.d.decision === 'capture' && fd.pp?.status === 'COMPLETED' && fd.pp?.amount?.value === '298.00', `a 2-unit order captured in full: PayPal capture ${fd.pp ? `${fd.pp.id} $${fd.pp.amount?.value} ${fd.pp.status}` : 'not made'}`);
} else check(false, `a 2-unit order was not allowed: ${d2.held ? `${d2.held.code} ${d2.held.message}` : ''}`);

console.log('--- Scene E: the feed slips a decimal UP: held, so no buyer is overcharged, and no PayPal order is created');
const beforeE = counts.createOrder;
const e = await startCheckout({ ...kettle, priceCents: 149000 });
check(e.held?.decision === 'hold' && e.held.code === 'HELD', `$1,490.00 (was $149.00) held: ${e.held ? e.held.message : 'NOT HELD'}`);
check(counts.createOrder === beforeE, 'the merchant created no PayPal order');

console.log('--- Scene F: a bot asks for 500 units in ONE order: the breaker counts units and trips before PayPal');
const lego = { sku: 'MX-LEGO-75192', name: 'LEGO Star Wars Millennium Falcon 75192', priceCents: 84999, category: 'Toys', description: 'Ultimate Collector Series set, 7,541 pieces.' };
const beforeF = counts.createOrder;
const f = await startCheckout({ ...lego, quantity: 500 }); // a new SKU: the AI vouches for the price; the units trip the breaker
check(f.held?.decision === 'hold' && f.held.code === 'TRIPPED' && f.held.amountCents === 42499500, `500 x $849.99 ($424,995.00) in one order: ${f.held ? `${f.held.decision} ${f.held.code}` : 'NOT HELD'}`);
check(counts.createOrder === beforeF, 'the merchant created no PayPal order for it');

console.log('--- What the merchant sees in the Tripwire console');
const st = await http(`/api/store/state?store=${storeId}`);
const kinds = st.timeline.map((e) => e.kind);
check(st.orders.length === 0, 'Tripwire itself made no PayPal order (the merchant\'s server did)');
check(st.timeline.some((e) => e.kind === 'CHECKOUT_REFUSED' && e.sku === 'MX-ANKER-737' && /^API checkout/.test(e.message)), 'the refused $10.99 checkout is on the timeline');
check(st.timeline.some((e) => e.kind === 'API_CAPTURE' && a.sale && e.paypalId === a.sale.authorizationId), 'API_CAPTURE carries the merchant\'s authorization id');
check(st.timeline.some((e) => e.kind === 'API_VOID' && e.sku === 'MX-KETTLE-EKG'), 'API_VOID for the kettle');
check(!kinds.includes('PAYPAL_ERROR') && !kinds.includes('AI_ERROR'), 'no PayPal or AI errors');
check(st.timeline.some((e) => e.kind === 'BREAKER_TRIPPED' && e.sku === 'MX-LEGO-75192' && /500 of them in one order/.test(e.message)), 'BREAKER_TRIPPED names the 500-unit order');
check(st.timeline.some((e) => e.kind === 'PRICE_HELD' && e.sku === 'MX-KETTLE-EKG' && /Every buyer would be overcharged/.test(e.message)), 'PRICE_HELD explains the overcharge');
// refused: the $10.99 slip, the $1,490.00 overcharge and the 500-unit order. Only the slip would have lost the merchant money.
check(st.summary.refusedCheckouts === 3 && st.summary.lossPreventedCents === 9900, `summary: ${st.summary.refusedCheckouts} refused, $${value(st.summary.lossPreventedCents)} loss prevented`);
check(counts.createOrder === 4 && counts.capture === 2 && counts.void === 2, `the merchant's PayPal calls: ${JSON.stringify(counts)}`);

console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nMERCHANT GATE: ALL LIVE CHECKS PASSED');
process.exit(failures ? 1 : 0);
