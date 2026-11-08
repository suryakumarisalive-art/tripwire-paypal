// Regression tests for the independent review of 6 Nov 2026 (findings F1-F8 and the confirmed LOW items).
// Each test reproduces the reviewer's failure scenario and fails on the code before the fix.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeStore, fakePayPal, fakeAi, verdict, clock } from './helpers.mjs';
import { parseVerdicts } from '../src/ai.mjs';
import { checkPrice } from '../src/rules.mjs';

const item = (store, sku) => store.catalog().find((c) => c.sku === sku);
const tick = () => new Promise((r) => setImmediate(r));
function gatedAi(answer) {
  const gates = [];
  const fn = async (rows) => {
    let release; const g = new Promise((r) => { release = r; }); gates.push(release); await g;
    return { ok: true, verdicts: new Map(rows.map((r) => [r.sku, answer(r)])) };
  };
  fn.gates = gates;
  return fn;
}

test('F1: a late AI answer from before a reset cannot release a code hold (reviewer probe2)', async () => {
  const now = clock();
  const ai = gatedAi((r) => (r.newCents === 25999 ? verdict('ok', 24900, 34999, 'Normal sale.') : verdict('implausible', 29900, 34999, 'Slipped decimal.')));
  const { store, paypal } = makeStore({ reviewAi: ai, now });
  const p1 = store.applyPriceChanges([{ sku: 'HP-SONY-XM5', price: '259.99' }]);
  await tick();
  await store.reset();
  const p2 = store.applyPriceChanges([{ sku: 'HP-SONY-XM5', price: '34.99' }]);
  await tick();
  ai.gates[1](); await p2;
  ai.gates[0](); await p1; // the stale "ok" lands last
  const after = item(store, 'HP-SONY-XM5');
  assert.equal(after.status, 'held');
  assert.equal(after.priceCents, 3499);
  const r = await store.botCheckout('HP-SONY-XM5');
  assert.equal(r.code, 'HELD');
  assert.equal(paypal.calls.filter((c) => c[0] === 'createOrder').length, 0);
});

test('F1: an AI "ok" for a price that has since changed is discarded even without a reset', async () => {
  const ai = gatedAi(() => verdict('ok', 24900, 34999, 'Normal sale.'));
  const { store } = makeStore({ reviewAi: ai });
  const p1 = store.applyPriceChanges([{ sku: 'HP-SONY-XM5', price: '259.99' }]);
  await tick();
  store.resolveHold('HP-SONY-XM5', 'fix'); // merchant goes back to $349.99 while the AI is thinking
  ai.gates[0](); await p1;
  const after = item(store, 'HP-SONY-XM5');
  assert.equal(after.priceCents, 34999);
  assert.equal(after.status, 'live');
});

test('F2: orders stuck mid-capture or mid-void are finished by settlement with the same idempotency key', async () => {
  const now = clock();
  const { store, paypal } = makeStore({ now });
  await store.swarm('LEGO-75192', 25);
  now.advance(21_000); await store.settle(); // 5 awaiting
  // simulate an eviction in the middle of a merchant decision: rows left in 'voiding' with no PayPal result recorded
  const orders = store.orders().filter((o) => o.status === 'awaiting_merchant');
  for (const o of orders) store.sql.exec("UPDATE orders SET status = 'voiding', updated_at = ? WHERE id = ?", now(), o.id);
  assert.notEqual(store.pendingWorkAt(), null, 'a restarted object knows there is work to finish');
  now.advance(61_000);
  await store.settle();
  assert.equal(store.orders().filter((o) => o.status === 'voided').length, 5);
  const keys = paypal.calls.filter((c) => c[0] === 'voidAuthorization').map((c) => c[2]);
  assert.ok(keys.every((k, i) => k === `void-${orders.find((o) => o.authorizationId === paypal.calls.filter((c) => c[0] === 'voidAuthorization')[i][1]).id}`));
});

test('F2: a bot order stuck in "creating" is recovered with the same create request id and settles normally', async () => {
  const now = clock();
  const { store, paypal } = makeStore({ now });
  const g = store.gate('KB-Q1PRO', 'bot'); // the gate wrote 'creating'; the PayPal response never got recorded
  assert.equal(g.ok, true);
  now.advance(61_000);
  await store.settle();
  const o = store.orders()[0];
  assert.equal(o.status, 'authorized');
  assert.equal(paypal.calls.find((c) => c[0] === 'createOrder')[1].requestId, `create-${g.order.id}`);
  now.advance(21_000);
  await store.settle();
  assert.equal(store.orders()[0].status, 'captured');
});

test('F3: a tripped item confirmed by mistake can be fixed back to the price before the change', async () => {
  const now = clock();
  const { store, paypal } = makeStore({ now });
  await store.applyPriceChanges([{ sku: 'LEGO-75192', price: '84.99' }]);
  store.resolveHold('LEGO-75192', 'confirm');
  await store.swarm('LEGO-75192', 25);
  assert.equal(item(store, 'LEGO-75192').status, 'tripped');
  assert.equal(item(store, 'LEGO-75192').restoreCents, 84999);
  const fixed = await store.decideHold('LEGO-75192', 'fix');
  const lego = item(store, 'LEGO-75192');
  assert.equal(lego.status, 'live');
  assert.equal(lego.priceCents, 84999);
  now.advance(21_000);
  await store.settle(); // the 5 orders at $84.99 must not be captured at the restored price...
  assert.equal(paypal.calls.filter((c) => c[0] === 'captureAuthorization').length, 0);
  // ...and the same click releases them: fixing a mistaken price voids the orders taken at it
  assert.equal(fixed.voided, 5);
  assert.equal(paypal.calls.filter((c) => c[0] === 'voidAuthorization').length, 5);
  assert.equal(store.orders().filter((o) => o.status === 'voided').length, 5);
});

test('F4: reset voids open authorizations on PayPal first and refuses while a PayPal call is in flight', async () => {
  const now = clock();
  const { store, paypal } = makeStore({ now });
  await store.swarm('LEGO-75192', 25);
  now.advance(21_000); await store.settle();
  const r = await store.reset();
  assert.equal(r.voided, 5);
  assert.equal(paypal.calls.filter((c) => c[0] === 'voidAuthorization').length, 5);
  assert.equal(store.orders().length, 0);
  store.gate('KB-Q1PRO', 'bot'); // leaves an order in 'creating'
  await assert.rejects(store.reset(), /in flight/);
});

test('F5: an AI "ok" with no market range is not an answer, so a new item stays held', () => {
  const rows = [{ sku: 'A', name: 'AirPods', newCents: 1 }];
  const v = parseVerdicts(JSON.stringify({ results: [{ sku: 'A', verdict: 'ok', market_low_usd: 0, market_high_usd: 0, explanation: 'fine' }] }), rows);
  assert.equal(v.size, 0);
});

test('F6: void and honor act only on orders shown as waiting, never on orders still cooling', async () => {
  const now = clock();
  const { store, paypal } = makeStore({ now });
  await store.applyPriceChanges([{ sku: 'KB-Q1PRO', price: '19.90' }]); // held
  await assert.rejects(store.decideOrders('KB-Q1PRO', 'void'), /No orders are waiting/);
  store.resolveHold('KB-Q1PRO', 'fix');
  await store.botCheckout('KB-Q1PRO'); // cooling, authorized
  await assert.rejects(store.decideOrders('KB-Q1PRO', 'void'), /No orders are waiting/);
  assert.equal(paypal.calls.filter((c) => c[0] === 'voidAuthorization').length, 0);
});

test('a PENDING authorization is kept for the merchant, not dropped as failed', async () => {
  const paypal = fakePayPal();
  paypal.createOrder = async (args) => { paypal.calls.push(['createOrder', args]); return { status: 201, body: { id: 'ORDP', status: 'COMPLETED', purchase_units: [{ payments: { authorizations: [{ id: 'AUTHP', status: 'PENDING' }] } }] } }; };
  const { store } = makeStore({ paypal });
  const r = await store.botCheckout('KB-Q1PRO');
  assert.equal(r.ok, true);
  const o = store.orders()[0];
  assert.equal(o.status, 'awaiting_merchant');
  assert.equal(o.authorizationId, 'AUTHP');
});

test('imports larger than one AI batch are split, and every row gets an answer', async () => {
  const ai = fakeAi(() => verdict('ok', 100, 100000, 'Typical.'));
  const { store } = makeStore({ reviewAi: ai });
  const rows = Array.from({ length: 30 }, (_, i) => ({ sku: `NEW-${i}`, name: `Gadget ${i}`, price: '20.00' }));
  const res = await store.applyPriceChanges(rows);
  assert.equal(ai.calls.length, 2);
  assert.deepEqual([ai.calls[0].length, ai.calls[1].length], [25, 5]);
  assert.ok(res.every((r) => r.status === 'live'));
});

test('re-importing a held price does not ask the AI again (so an AI hold cannot flip)', async () => {
  const ai = fakeAi(() => verdict('implausible', 19900, 24900, 'Too cheap.'));
  const { store } = makeStore({ reviewAi: ai });
  await store.applyPriceChanges([{ sku: 'AIRPODS-PRO2', name: 'AirPods Pro 2', price: '24.90' }]);
  const res = await store.applyPriceChanges([{ sku: 'AIRPODS-PRO2', name: 'AirPods Pro 2', price: '24.90', description: 'changed text' }]);
  assert.equal(ai.calls.length, 1);
  assert.deepEqual(res[0], { sku: 'AIRPODS-PRO2', status: 'held', unchanged: true });
});

test('small cuts cannot walk a price down without the AI: the drop is measured against the 30-day typical price too', () => {
  // $349.99 typical; the last good price was already walked down to $289.99; $239.99 is only -17% from that
  const r = checkPrice({ newCents: 23999, oldCents: 28999, medianCents: 34999 });
  assert.equal(r.needsAi, true);
});

test('pendingWorkAt is null for an idle store and set when an authorization is cooling', async () => {
  const now = clock();
  const { store } = makeStore({ now });
  assert.equal(store.pendingWorkAt(), null);
  await store.botCheckout('KB-Q1PRO');
  assert.equal(store.pendingWorkAt(), now() + 20_000);
});
