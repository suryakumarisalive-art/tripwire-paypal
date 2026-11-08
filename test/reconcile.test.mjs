// Reconciliation in settlement: buyer orders whose checkout page never came back, abandoned checkouts, and
// authorizations PayPal let run out. PayPal's own answer decides each one. Tests R1-R6.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeStore, fakePayPal, FAKE_AUTH_EXPIRES } from './helpers.mjs';
import { PayPalError } from '../src/paypal.mjs';

const kinds = (store, kind) => store.timeline(0, 500).filter((e) => e.kind === kind);
const MIN = 60_000; const HOUR = 3_600_000;
const gets = (paypal) => paypal.calls.filter((c) => c[0] === 'getOrder').length;

test('R1 an approved order whose page never came back is authorized at the next settlement, after the same price check', async () => {
  const paypal = fakePayPal({ orderStatus: () => 'APPROVED' });
  const { store, now, alarms } = makeStore({ paypal });
  const r = await store.buyerCreateOrder('LEGO-75192', 'paypal');
  assert.ok(alarms.includes(now() + 10 * MIN), 'creating the order schedules the first look');
  now.advance(9 * MIN); await store.settle();
  assert.equal(gets(paypal), 0, 'not before 10 minutes');
  now.advance(2 * MIN); await store.settle();
  assert.equal(store.orders()[0].status, 'authorized');
  assert.equal(store.orders()[0].paypalOrderId, r.paypalOrderId);
  assert.match(kinds(store, 'PAYPAL_WEBHOOK')[0].message, /checkout page never came back/);
});

test('R2 an approved order whose price slipped since is blocked, never authorized', async () => {
  const paypal = fakePayPal({ orderStatus: () => 'APPROVED' });
  const { store, now } = makeStore({ paypal });
  await store.buyerCreateOrder('TV-BRAVIA-65', 'paypal');
  await store.applyPriceChanges([{ sku: 'TV-BRAVIA-65', price: '129.90' }]);
  now.advance(11 * MIN); await store.settle();
  assert.equal(store.orders()[0].status, 'blocked');
  assert.equal(paypal.calls.filter((c) => c[0] === 'authorizeOrder').length, 0);
});

test('R3 never approved: asked again every 3 hours, abandoned after a day; voided or gone at PayPal is abandoned at once', async () => {
  const paypal = fakePayPal({ orderStatus: () => 'PAYER_ACTION_REQUIRED' });
  const { store, now } = makeStore({ paypal });
  await store.buyerCreateOrder('LEGO-75192', 'paypal');
  now.advance(11 * MIN); await store.settle();
  assert.deepEqual([store.orders()[0].status, gets(paypal)], ['created', 1]);
  now.advance(1 * HOUR); await store.settle();
  assert.equal(gets(paypal), 1, 'no second look within 3 hours');
  now.advance(2 * HOUR + MIN); await store.settle();
  assert.equal(gets(paypal), 2);
  now.advance(21 * HOUR); await store.settle();
  assert.equal(store.orders()[0].status, 'abandoned');
  assert.match(kinds(store, 'ABANDONED')[0].message, /never approved it in PayPal\. Nothing was reserved or charged/);

  const gone = fakePayPal({ orderStatus: () => { throw new PayPalError(404, 'RESOURCE_NOT_FOUND'); } });
  const g = makeStore({ paypal: gone });
  await g.store.buyerCreateOrder('LEGO-75192', 'paypal');
  g.now.advance(11 * MIN); await g.store.settle();
  assert.equal(g.store.orders()[0].status, 'abandoned');
  const voided = makeStore({ paypal: fakePayPal({ orderStatus: () => 'VOIDED' }) });
  await voided.store.buyerCreateOrder('LEGO-75192', 'paypal');
  voided.now.advance(11 * MIN); await voided.store.settle();
  assert.equal(voided.store.orders()[0].status, 'abandoned');
});

test('R4 PayPal unreachable: the order stays created and is asked about again later, never abandoned on an error', async () => {
  const down = fakePayPal({ orderStatus: () => { throw new PayPalError(503, 'SERVICE_UNAVAILABLE'); } });
  const { store, now } = makeStore({ paypal: down });
  await store.buyerCreateOrder('LEGO-75192', 'paypal');
  now.advance(25 * HOUR); await store.settle();
  assert.equal(store.orders()[0].status, 'created');
  assert.equal(kinds(store, 'ABANDONED').length, 0);
});

test('R5 an authorization past PayPal\'s expiration_time is marked expired, never captured or honored', async () => {
  const { store, now } = makeStore();
  await store.botCheckout('KB-Q1PRO');
  store.sql.exec("UPDATE orders SET status = 'awaiting_merchant', wait_reason = 'tripped'");
  assert.ok(store.pendingWorkAt() <= Date.parse(FAKE_AUTH_EXPIRES), 'settlement is scheduled for the expiry');
  now.advance(Date.parse(FAKE_AUTH_EXPIRES) - now() + 1000);
  await store.settle();
  assert.equal(store.orders()[0].status, 'expired');
  assert.equal(store.summary().expired.n, 1);
  assert.match(kinds(store, 'EXPIRED')[0].message, /expired at PayPal before a decision\. The buyer was never charged/);
  await assert.rejects(store.decideOrders('KB-Q1PRO', 'honor'), (e) => e.status === 409);
});

test('R6 at most 10 PayPal lookups per settlement run; the rest wait for the next run', async () => {
  const paypal = fakePayPal({ orderStatus: () => 'PAYER_ACTION_REQUIRED' });
  const { store, now } = makeStore({ paypal, config: { maxPerWindow: 100 } });
  for (let i = 0; i < 12; i++) await store.buyerCreateOrder('LEGO-75192', 'paypal');
  now.advance(11 * MIN); await store.settle();
  assert.equal(gets(paypal), 10);
  assert.ok(store.pendingWorkAt() <= now() + 1000, 'the next run comes straight away');
  await store.settle();
  assert.equal(gets(paypal), 12);
});
