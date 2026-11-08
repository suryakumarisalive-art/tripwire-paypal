// Real-world handling (8 Nov): overcharges (a price slipped UP), multi-unit orders, PayPal webhooks and the
// reconciliation of orders PayPal changed outside Tripwire. Tests O (overcharge), Q (quantity), W (webhooks), R (reconcile).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeStore } from './helpers.mjs';
import { checkPrice } from '../src/rules.mjs';

const item = (store, sku) => store.catalog().find((c) => c.sku === sku);
const kinds = (store, kind) => store.timeline(0, 500).filter((e) => e.kind === kind);
const codes = (r) => r.holds.map((h) => h.code);

// ---------- O: overcharges ----------

test('O1 rule: a price slipped up by exactly 10x, 100x or 1000x is a hard hold', () => {
  for (const [newCents, f] of [[1_299_000, 10], [12_990_000, 100], [19_900_000, 1000]]) {
    const old = Math.round(newCents / f);
    const r = checkPrice({ newCents, oldCents: old, medianCents: old });
    assert.deepEqual(codes(r), ['DECIMAL_SHIFT_UP'], String(newCents));
    assert.match(r.holds[0].message, new RegExp(`exactly ${f}x higher`));
  }
});

test('O2 rule: a price 5x or more above the usual price is held; 4.9x and normal rises are not', () => {
  assert.deepEqual(codes(checkPrice({ newCents: 99_500, oldCents: 19_900, medianCents: 19_900 })), ['PRICE_SPIKE']); // 5.0x
  assert.deepEqual(codes(checkPrice({ newCents: 97_500, oldCents: 19_900, medianCents: 19_900 })), []); // 4.9x
  assert.deepEqual(codes(checkPrice({ newCents: 21_900, oldCents: 19_900, medianCents: 19_900 })), []); // a 10% rise
});

test('O3 rule: restoring the usual price after a mistaken low price went live is never held', () => {
  // the mistake $12.99 went live (so it is the last good price), but the 30-day typical price is still $1,299
  assert.deepEqual(codes(checkPrice({ newCents: 129_900, oldCents: 1_299, medianCents: 129_900 })), []);
});

test('O4 store: a price slipped up is refused at checkout before PayPal, and Fix restores the last good price', async () => {
  const { store, paypal } = makeStore();
  const [r] = await store.applyPriceChanges([{ sku: 'KB-Q1PRO', price: '1990.00' }]); // $199.00 -> $1,990.00
  assert.equal(r.status, 'held');
  assert.ok(item(store, 'KB-Q1PRO').reasons.some((x) => x.code === 'DECIMAL_SHIFT_UP'));
  const g = await store.botCheckout('KB-Q1PRO');
  assert.deepEqual([g.ok, g.code], [false, 'HELD']);
  assert.equal(paypal.calls.length, 0);
  // an overcharge is not money the merchant was about to lose: it never counts as loss prevented
  assert.equal(store.summary().lossPreventedCents, 0);
  const fixed = await store.decideHold('KB-Q1PRO', 'fix', 199_000);
  assert.deepEqual([fixed.status, fixed.price_cents], ['live', 19_900]);
});

test('O5 API check: an overcharge on a live item is held for the merchant\'s own checkout too', async () => {
  const { store } = makeStore();
  const r = await store.apiCheck({ sku: 'KETTLE-STAGG', priceCents: 165_000 }); // $165.00 -> $1,650.00
  assert.deepEqual([r.decision, r.code], ['hold', 'HELD']);
  assert.equal(kinds(store, 'PRICE_HELD').length, 1);
});

// ---------- Q: multi-unit orders ----------
const KB = { sku: 'KB-Q1PRO', priceCents: 19_900 };

test('Q1 API check: one order for 500 units trips the breaker like 500 orders would, before any PayPal order', async () => {
  const { store, paypal } = makeStore();
  const r = await store.apiCheck({ ...KB, quantity: 500 });
  assert.deepEqual([r.decision, r.code, r.quantity, r.amountCents], ['hold', 'TRIPPED', 500, 9_950_000]);
  assert.equal(item(store, 'KB-Q1PRO').status, 'tripped');
  assert.match(kinds(store, 'BREAKER_TRIPPED')[0].message, /500 units in under 60 seconds \(limit 5\), 500 of them in one order/);
  assert.match(kinds(store, 'CHECKOUT_REFUSED')[0].message, /500 × \$199\.00 \(\$99,500\.00\) refused before PayPal/);
  assert.equal(paypal.calls.length, 0);
});

test('Q2 API check: units add up across orders inside the window (3 + 2 sell, the next 1 trips)', async () => {
  const { store } = makeStore();
  assert.equal((await store.apiCheck({ ...KB, quantity: 3 })).decision, 'allow');
  assert.equal((await store.apiCheck({ ...KB, quantity: 2 })).decision, 'allow');
  const third = await store.apiCheck(KB);
  assert.deepEqual([third.decision, third.code], ['hold', 'TRIPPED']);
});

test('Q3 capture-check: a 3-unit check captures exactly 3 × price and voids any other amount, the one-unit price included', async () => {
  const { store, now } = makeStore();
  const a = await store.apiCheck({ ...KB, quantity: 3 });
  assert.deepEqual([a.decision, a.quantity, a.amountCents], ['allow', 3, 59_700]);
  assert.match(a.message, /exactly amountCents \(3 × priceCents\)/);
  now.advance(25_000);
  const ok = store.captureCheck(a.checkId, 59_700, 'AUTH-Q3');
  assert.deepEqual([ok.decision, ok.reason, ok.amountCents], ['capture', 'LIVE', 59_700]);
  const b = await store.apiCheck({ ...KB, quantity: 2 });
  now.advance(25_000);
  const wrong = store.captureCheck(b.checkId, 19_900, 'AUTH-Q3B'); // only one unit's price authorized
  assert.deepEqual([wrong.decision, wrong.reason], ['void', 'AMOUNT_MISMATCH']);
  assert.match(wrong.message, /2 × \$199\.00 \(\$398\.00\)/);
});

test('Q4 API check: quantity must be a whole number from 1 to 1000', async () => {
  const { store } = makeStore();
  for (const bad of [0, -1, 1.5, 1001, '3', NaN]) await assert.rejects(store.apiCheck({ ...KB, quantity: bad }), (e) => e.status === 400, String(bad));
  assert.equal((await store.apiCheck(KB)).quantity, 1); // default
});

test('Q5 review: the review cap counts units, so one order cannot take more than the cap', async () => {
  const { store } = makeStore({ config: { maxPerWindow: 100 } });
  await store.applyPriceChanges([{ sku: 'VAC-DYSON-V15', price: '349.99' }]); // a steep drop with no AI answer is held...
  store.sql.exec("UPDATE sku SET status = 'review', review_since = ? WHERE sku = 'VAC-DYSON-V15'", store.now()); // ...put it under review
  const big = await store.apiCheck({ sku: 'VAC-DYSON-V15', priceCents: 34_999, quantity: 11 });
  assert.deepEqual([big.decision, big.code], ['hold', 'REVIEW_FULL']);
  assert.equal((await store.apiCheck({ sku: 'VAC-DYSON-V15', priceCents: 34_999, quantity: 10 })).code, 'REVIEW');
  assert.equal((await store.apiCheck({ sku: 'VAC-DYSON-V15', priceCents: 34_999 })).code, 'REVIEW_FULL');
});

test('Q6 loss prevented counts every refused unit', async () => {
  const { store } = makeStore();
  await store.applyPriceChanges([{ sku: 'TV-BRAVIA-65', price: '129.90' }]); // decimal slip: held
  await store.apiCheck({ sku: 'TV-BRAVIA-65', priceCents: 12_990, quantity: 4 });
  assert.equal(store.summary().lossPreventedCents, 4 * (129_900 - 12_990));
  assert.equal(store.summary().refusedByChannel.api.savedCents, 4 * (129_900 - 12_990));
});
