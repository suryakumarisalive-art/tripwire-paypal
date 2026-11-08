import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeStore, fakePayPal, fakeAi, verdict } from './helpers.mjs';

const status = (store, sku) => store.catalog().find((c) => c.sku === sku);
const creates = (paypal) => paypal.calls.filter((c) => c[0] === 'createOrder');

test('the seeded catalog starts live with history', () => {
  const { store } = makeStore();
  const tv = status(store, 'TV-BRAVIA-65');
  assert.equal(tv.status, 'live');
  assert.equal(tv.priceCents, 129900);
  assert.equal(tv.typicalCents, 129900);
});

test('scene 1: a decimal slip is held by code; 25 bots get 25 refusals and PayPal is never called (AC1)', async () => {
  const { store, paypal, reviewAi } = makeStore({ reviewAi: fakeAi((r) => verdict('implausible', 110000, 150000, 'A 65" Mini LED TV sells for about $1,100-$1,500; $129.90 looks like a slipped decimal.')) });
  const res = await store.applyPriceChanges([{ sku: 'TV-BRAVIA-65', price: '129.90' }]);
  assert.equal(res[0].status, 'held');
  const tv = status(store, 'TV-BRAVIA-65');
  assert.equal(tv.status, 'held');
  assert.ok(tv.reasons.some((r) => r.code === 'DECIMAL_SHIFT' && r.source === 'rule'));
  assert.ok(tv.reasons.some((r) => r.code === 'AI_IMPLAUSIBLE' && r.source === 'ai'));
  assert.equal(reviewAi.calls.length, 1, 'held rows still get an AI explanation');
  const swarm = await store.swarm('TV-BRAVIA-65', 25);
  assert.deepEqual(swarm, { count: 25, authorized: 0, refused: 25, failed: 0 });
  assert.equal(creates(paypal).length, 0, 'no PayPal order may exist for a held price');
  assert.equal(store.summary().refusedCheckouts, 25);
  assert.deepEqual(store.summary().refusedByChannel, { bot: { n: 25, savedCents: 25 * (129900 - 12990) } }, 'the console can say these were the demo\'s own bots');
  assert.equal(store.summary().lossPreventedCents, 25 * (129900 - 12990));
});

test('fix restores the last good price and checkout works again at that price', async () => {
  const { store, paypal } = makeStore();
  await store.applyPriceChanges([{ sku: 'TV-BRAVIA-65', price: '129.90' }]);
  store.resolveHold('TV-BRAVIA-65', 'fix');
  assert.equal(status(store, 'TV-BRAVIA-65').priceCents, 129900);
  const r = await store.buyerCreateOrder('TV-BRAVIA-65', 'paypal');
  assert.equal(r.ok, true);
  assert.equal(creates(paypal)[0][1].amountCents, 129900, 'PayPal is asked for the server price, never a client price');
});

test('AC2: 25 concurrent checkouts with a limit of 5 allow exactly 5; the breaker trips; 20 are refused', async () => {
  const { store, paypal } = makeStore({ paypal: fakePayPal({ delayMs: 5 }) });
  const results = await Promise.all(Array.from({ length: 25 }, () => store.botCheckout('LEGO-75192')));
  assert.equal(results.filter((r) => r.ok).length, 5);
  assert.equal(results.filter((r) => !r.ok && r.code === 'TRIPPED').length, 20);
  assert.equal(creates(paypal).length, 5);
  assert.equal(status(store, 'LEGO-75192').status, 'tripped');
  assert.equal(store.timeline().filter((e) => e.kind === 'BREAKER_TRIPPED').length, 1);
});

test('the swarm endpoint respects the cap and the cooldown', async () => {
  const { store, now } = makeStore();
  const r = await store.swarm('KB-Q1PRO', 999);
  assert.equal(r.count, 25);
  await assert.rejects(store.swarm('KB-Q1PRO', 5), /swarm just ran/);
  now.advance(11_000);
  await store.swarm('KB-Q1PRO', 1); // allowed after the cooldown (and refused: the breaker is tripped)
});

test('AC3: settlement captures only after cooling, only while live at the same price', async () => {
  const { store, paypal, now } = makeStore();
  await store.botCheckout('KETTLE-STAGG');
  assert.deepEqual(await store.settle(), { captured: 0, held: 0 }, 'nothing is due before the cooling window');
  now.advance(21_000);
  assert.deepEqual(await store.settle(), { captured: 1, held: 0 });
  const o = store.orders()[0];
  assert.equal(o.status, 'captured');
  assert.match(o.captureId, /^CAP/);
  const cap = paypal.calls.find((c) => c[0] === 'captureAuthorization');
  assert.equal(cap[2], `capture-${o.id}`, 'capture uses an idempotency key derived from the order');
});

test('AC3: a tripped item is never captured; its orders wait; void releases them on PayPal', async () => {
  const { store, paypal, now } = makeStore();
  await store.swarm('LEGO-75192', 25);
  now.advance(21_000);
  assert.deepEqual(await store.settle(), { captured: 0, held: 5 });
  assert.equal(paypal.calls.filter((c) => c[0] === 'captureAuthorization').length, 0);
  assert.equal(status(store, 'LEGO-75192').awaiting, 5);
  assert.deepEqual(await store.decideOrders('LEGO-75192', 'void'), { count: 5 });
  assert.equal(store.orders().filter((o) => o.status === 'voided').length, 5);
  const voids = paypal.calls.filter((c) => c[0] === 'voidAuthorization');
  assert.equal(voids.length, 5);
  assert.ok(voids.every((v) => v[2].startsWith('void-')));
  assert.equal(store.summary().voided.cents, 5 * 84999);
});

test('honor captures the waiting orders; resume re-arms the breaker', async () => {
  const { store, paypal, now } = makeStore();
  await store.swarm('LEGO-75192', 25);
  now.advance(21_000); await store.settle();
  await store.decideOrders('LEGO-75192', 'honor');
  assert.equal(store.orders().filter((o) => o.status === 'captured').length, 5);
  store.resume('LEGO-75192');
  assert.equal(status(store, 'LEGO-75192').status, 'live');
  now.advance(1000);
  const again = await Promise.all(Array.from({ length: 7 }, () => store.botCheckout('LEGO-75192')));
  assert.equal(again.filter((r) => r.ok).length, 5, 'the window restarts at resume');
  assert.ok(paypal.calls.length > 0);
});

test('a price held after authorization is not captured at settlement', async () => {
  const { store, now } = makeStore();
  await store.botCheckout('TV-BRAVIA-65');
  await store.applyPriceChanges([{ sku: 'TV-BRAVIA-65', price: '129.90' }]);
  now.advance(21_000);
  assert.deepEqual(await store.settle(), { captured: 0, held: 1 });
  assert.equal(store.orders()[0].status, 'awaiting_merchant');
});

test('a price changed (even upward) after authorization is not captured at the old amount', async () => {
  const { store, now } = makeStore();
  await store.botCheckout('KB-Q1PRO');
  await store.applyPriceChanges([{ sku: 'KB-Q1PRO', price: '209.00' }]);
  now.advance(21_000);
  assert.deepEqual(await store.settle(), { captured: 0, held: 1 });
});

test('scene 2: a new item with no history or cost is held when the AI calls it implausible', async () => {
  const ai = fakeAi((r) => (r.sku === 'AIRPODS-PRO2' ? verdict('implausible', 19900, 24900, 'AirPods Pro 2 sell for about $199-$249; $24.90 is missing a digit.') : verdict('ok', 9999, 14999, 'Typical for a 24,000mAh 140W power bank.')));
  const { store } = makeStore({ reviewAi: ai });
  const res = await store.applyPriceChanges([
    { sku: 'AIRPODS-PRO2', name: 'Apple AirPods Pro 2 (USB-C)', price: '24.90' },
    { sku: 'ANKER-737', name: 'Anker 737 Power Bank', price: '109.99' },
  ]);
  assert.deepEqual(res.map((r) => r.status), ['held', 'live']);
  assert.equal(status(store, 'AIRPODS-PRO2').reasons[0].code, 'AI_IMPLAUSIBLE');
  assert.throws(() => store.resolveHold('AIRPODS-PRO2', 'fix'), /no earlier price/);
});

test('AC5: when the AI is down, a price nothing can vouch for is held, and the outage is on the timeline', async () => {
  const { store } = makeStore({ reviewAi: fakeAi(() => null, { ok: false, error: 'AI check timed out.' }) });
  const res = await store.applyPriceChanges([{ sku: 'NEW-1', name: 'Mystery item', price: '10.00' }, { sku: 'HP-SONY-XM5', price: '259.99' }]);
  assert.deepEqual(res.map((r) => r.status), ['held', 'held']);
  assert.equal(status(store, 'NEW-1').reasons[0].code, 'UNVERIFIED');
  assert.ok(store.timeline().some((e) => e.kind === 'AI_ERROR'));
});

test('AC5: a silent AI (no verdict for the row) also leaves the price held', async () => {
  const { store } = makeStore({ reviewAi: fakeAi(() => null) });
  const res = await store.applyPriceChanges([{ sku: 'HP-SONY-XM5', price: '259.99' }]);
  assert.equal(res[0].status, 'held');
});

test('AC4: an AI "ok" cannot release a code hold', async () => {
  const { store } = makeStore({ reviewAi: fakeAi(() => verdict('ok', 100, 20000, 'Looks fine.')) });
  const res = await store.applyPriceChanges([{ sku: 'TV-BRAVIA-65', price: '129.90' }]);
  assert.equal(res[0].status, 'held');
  assert.equal(status(store, 'TV-BRAVIA-65').status, 'held');
});

test('AC4: an AI verdict arriving after the merchant decided is discarded', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const slowAi = async (rows) => { await gate; return { ok: true, verdicts: new Map(rows.map((r) => [r.sku, verdict('implausible', 30000, 40000, 'Too cheap.')])) }; };
  const { store } = makeStore({ reviewAi: slowAi });
  const pending = store.applyPriceChanges([{ sku: 'HP-SONY-XM5', price: '259.99' }]);
  await new Promise((r) => setImmediate(r));
  assert.equal(status(store, 'HP-SONY-XM5').status, 'checking');
  store.resolveHold('HP-SONY-XM5', 'confirm');
  release();
  await pending;
  assert.equal(status(store, 'HP-SONY-XM5').status, 'live', 'the merchant decision stands');
});

test('a real sale the AI vouches for goes live and becomes the new good price', async () => {
  const { store } = makeStore({ reviewAi: fakeAi(() => verdict('ok', 24800, 34999, 'A common sale price for these headphones.')) });
  const res = await store.applyPriceChanges([{ sku: 'HP-SONY-XM5', price: '259.99' }]);
  assert.equal(res[0].status, 'live');
  const hp = status(store, 'HP-SONY-XM5');
  assert.equal(hp.lastGoodCents, 25999);
  assert.equal(hp.ai.verdict, 'ok');
});

test('checking items refuse checkout until the AI answers', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const { store, paypal } = makeStore({ reviewAi: async (rows) => { await gate; return { ok: true, verdicts: new Map(rows.map((r) => [r.sku, verdict('ok', 20000, 35000, 'Fine.')])) }; } });
  const pending = store.applyPriceChanges([{ sku: 'HP-SONY-XM5', price: '259.99' }]);
  await new Promise((r) => setImmediate(r));
  const r = await store.botCheckout('HP-SONY-XM5');
  assert.equal(r.code, 'CHECKING');
  assert.equal(creates(paypal).length, 0);
  release(); await pending;
  assert.equal((await store.botCheckout('HP-SONY-XM5')).ok, true);
});

test('buyer approval re-checks the price before PayPal reserves anything', async () => {
  const { store, paypal } = makeStore();
  const c = await store.buyerCreateOrder('KB-Q1PRO', 'venmo');
  await store.applyPriceChanges([{ sku: 'KB-Q1PRO', price: '19.90' }]); // decimal slip after the buyer opened checkout
  const a = await store.buyerApprove(c.paypalOrderId);
  assert.equal(a.ok, false);
  assert.equal(paypal.calls.filter((x) => x[0] === 'authorizeOrder').length, 0);
  assert.equal(store.orders()[0].status, 'blocked');
});

test('buyer approval authorizes once; a second approval is refused', async () => {
  const { store, paypal } = makeStore();
  const c = await store.buyerCreateOrder('KB-Q1PRO', 'paypal');
  assert.equal((await store.buyerApprove(c.paypalOrderId)).ok, true);
  await assert.rejects(store.buyerApprove(c.paypalOrderId), /already handled/);
  assert.equal(paypal.calls.filter((x) => x[0] === 'authorizeOrder').length, 1);
});

test('PayPal failures are recorded with debug_id and never crash the gate', async () => {
  const { store } = makeStore({ paypal: fakePayPal({ failCreate: true }) });
  const r = await store.botCheckout('KB-Q1PRO');
  assert.equal(r.ok, false);
  const o = store.orders()[0];
  assert.equal(o.status, 'failed');
  assert.equal(o.debugId, 'dbg123');
  assert.ok(store.timeline().some((e) => e.kind === 'PAYPAL_ERROR' && e.message.includes('dbg123')));
});

test('a failed capture leaves the order waiting, never captured twice', async () => {
  const { store, now } = makeStore({ paypal: fakePayPal({ failCapture: true }) });
  await store.botCheckout('KB-Q1PRO');
  now.advance(21_000);
  await store.settle();
  assert.equal(store.orders()[0].status, 'awaiting_merchant');
});

test('imports validate every row and never touch the store on a bad row', async () => {
  const { store } = makeStore();
  const res = await store.applyPriceChanges([
    { sku: 'bad sku!', price: '1.00' }, { sku: 'TV-BRAVIA-65', price: '12.345' }, { sku: 'NEW-2', price: '5.00' }, { sku: 'KB-Q1PRO', price: '199.00' },
  ]);
  assert.match(res[0].error, /SKU/);
  assert.match(res[1].error, /not a price/);
  assert.match(res[2].error, /needs a name/);
  assert.equal(res[3].unchanged, true);
  assert.equal(status(store, 'TV-BRAVIA-65').priceCents, 129900);
  await assert.rejects(store.applyPriceChanges([]), /No rows/);
  await assert.rejects(store.applyPriceChanges(Array.from({ length: 101 }, (_, i) => ({ sku: `S${i}`, name: 'x', price: '1' }))), /at most 100/);
});

test('a tripped item can be repriced: the new price replaces the breaker and the window restarts', async () => {
  const { store } = makeStore();
  await store.swarm('LEGO-75192', 25);
  const res = await store.applyPriceChanges([{ sku: 'LEGO-75192', price: '799.99' }]);
  assert.equal(res[0].status, 'live');
  assert.equal(status(store, 'LEGO-75192').status, 'live');
});

test('reset restores the starting catalog', async () => {
  const { store } = makeStore();
  await store.applyPriceChanges([{ sku: 'TV-BRAVIA-65', price: '129.90' }]);
  await store.reset();
  assert.equal(status(store, 'TV-BRAVIA-65').status, 'live');
  assert.equal(store.orders().length, 0);
});

test('the public catalog exposes availability, never reasons or costs', () => {
  const { store } = makeStore();
  const item = store.publicCatalog()[0];
  assert.deepEqual(Object.keys(item).sort(), ['available', 'category', 'description', 'name', 'priceCents', 'sku']);
});
