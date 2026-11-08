// The shared AI budget: one Durable Object protects the one Groq key from any single store or script.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BudgetCore } from '../src/budget.mjs';
import { sqlAdapter, clock } from './helpers.mjs';

const make = (limits, now = clock()) => { const b = new BudgetCore({ sql: sqlAdapter(), now, limits }); b.init(); return { b, now }; };

test('a store is capped per day, the whole demo per minute and per day', () => {
  const { b, now } = make({ perMinute: 3, perDay: 5, perStorePerDay: 2 });
  assert.equal(b.take('s1').ok, true); assert.equal(b.take('s1').ok, true);
  const s1 = b.take('s1'); assert.equal(s1.ok, false); assert.match(s1.reason, /this demo store has used its AI checks for today/);
  assert.equal(b.take('s2').ok, true);
  const minute = b.take('s3'); assert.equal(minute.ok, false); assert.match(minute.reason, /the AI check is busy right now/);
  now.advance(61_000);
  assert.equal(b.take('s3').ok, true); assert.equal(b.take('s4').ok, true);
  const day = b.take('s5'); assert.equal(day.ok, false); assert.match(day.reason, /shared AI budget for today is used up/);
  now.advance(86_400_000); // the next day starts fresh
  assert.equal(b.take('s1').ok, true);
  assert.equal(b.status().aiCallsToday, 1);
});

test('a refusal uses nothing, and old minutes and days are pruned', () => {
  const { b, now } = make({ perMinute: 100, perDay: 100, perStorePerDay: 1 });
  b.take('s1'); b.take('s1'); b.take('s1');
  assert.equal(b.status().aiCallsToday, 1, 'refused calls are not counted');
  now.advance(2 * 86_400_000); b.take('s2');
  assert.equal(b.sql.exec('SELECT COUNT(*) AS n FROM usage').one().n, 3, 'one row each: this minute, today, this store today');
});

test('service health records the last success and the last failure', () => {
  const { b, now } = make();
  b.record('ai', true); now.advance(5000); b.record('ai', false, 'AI check is rate-limited (HTTP 429)'); b.record('paypal', true); b.record('nonsense', true);
  const s = b.status().services;
  assert.ok(s.ai.lastOkAt < s.ai.lastErrorAt); assert.match(s.ai.lastError, /429/);
  assert.ok(s.paypal.lastOkAt); assert.equal(s.market.lastOkAt, null);
  assert.equal(s.nonsense, undefined);
});

import { gatedAiCall, questionKey } from '../src/budget.mjs';
import { makeStore, fakeAi, verdict } from './helpers.mjs';

// A Budget stub over a real BudgetCore, the way the Worker calls the Durable Object.
const stub = (limits) => { const { b } = make(limits); return { core: b, take: async (s, n, ip) => b.take(s, n, ip), cacheGet: async (k) => b.cacheGet(k), cachePut: async (e) => b.cachePut(e), record: async (n, ok, e) => b.record(n, ok, e) }; };
const row = (sku, newCents) => ({ sku, name: 'Sony WH-1000XM5', category: 'Audio', description: '', newCents, oldCents: 34999, costCents: null });

test('gatedAiCall: a repeated question is answered from the shared cache, with no Groq call and no budget spent', async () => {
  const budget = stub();
  let groq = 0;
  const run = async (rows) => { groq++; return { ok: true, verdicts: new Map(rows.map((r) => [r.sku, verdict('ok', 25000, 35000, 'Normal sale.')])) }; };
  const a = await gatedAiCall([row('A', 25999)], { budget, storeKey: 's1', kind: 'price', field: 'verdicts', run });
  assert.equal(a.ok, true); assert.equal(a.verdicts.get('A').verdict, 'ok');
  const b = await gatedAiCall([row('OTHER-SKU', 25999)], { budget, storeKey: 's2', kind: 'price', field: 'verdicts', run });
  assert.equal(groq, 1, 'another store asking the same question reuses the answer'); assert.equal(b.cached, 1);
  assert.equal(b.verdicts.get('OTHER-SKU').verdict, 'ok');
  assert.equal(budget.core.status().aiCallsToday, 1);
  await gatedAiCall([row('A', 19999)], { budget, storeKey: 's1', kind: 'price', field: 'verdicts', run });
  assert.equal(groq, 2, 'a different price is a different question');
  assert.notEqual(await questionKey('price', row('A', 1)), await questionKey('match', row('A', 1)));
});

test('gatedAiCall: past the budget there is no Groq call and the answer is a failure (the store holds the price)', async () => {
  const budget = stub({ perStorePerDay: 1 });
  let groq = 0;
  const run = async (rows) => { groq++; return { ok: true, verdicts: new Map(rows.map((r) => [r.sku, verdict('ok', 1, 2, 'x')])) }; };
  await gatedAiCall([row('A', 100)], { budget, storeKey: 's1', kind: 'price', field: 'verdicts', run });
  const r = await gatedAiCall([row('B', 200)], { budget, storeKey: 's1', kind: 'price', field: 'verdicts', run });
  assert.equal(r.ok, false); assert.match(r.error, /AI check skipped: this demo store has used its AI checks for today/);
  assert.equal(groq, 1);
  const failing = await gatedAiCall([row('C', 300)], { budget: stub(), storeKey: 's1', kind: 'price', field: 'verdicts', run: async () => ({ ok: false, error: 'AI check timed out.' }) });
  assert.deepEqual([failing.ok, failing.error], [false, 'AI check timed out.']);
  const broken = { take: async () => { throw new Error('down'); }, cacheGet: async () => { throw new Error('down'); }, cachePut: async () => {}, record: async () => {} };
  assert.equal((await gatedAiCall([row('D', 400)], { budget: broken, storeKey: 's1', kind: 'price', field: 'verdicts', run })).ok, true, 'a broken budget guards nothing, but blocks nothing');
});

test('one network is capped per day across all its stores', () => {
  const { b } = make({ perIpPerDay: 2, perStorePerDay: 100 });
  assert.equal(b.take('s1', 1, 'ip-a').ok, true); assert.equal(b.take('s2', 1, 'ip-a').ok, true);
  const r = b.take('s3', 1, 'ip-a'); assert.equal(r.ok, false); assert.match(r.reason, /this network has used its AI checks for today/);
  assert.equal(b.take('s3', 1, 'ip-b').ok, true, 'another network is not affected');
});

test('a price held because the AI never answered is checked again when it is imported again', async () => {
  let up = false;
  const ai = fakeAi(() => verdict('ok', 1000, 2000, 'Fine.'));
  const reviewAi = async (rows) => (up ? ai(rows) : { ok: false, error: 'AI check skipped: the AI check is busy right now.', verdicts: new Map() });
  const { store } = makeStore({ reviewAi });
  await store.applyPriceChanges([{ sku: 'NEW-Z', name: 'New gadget', price: '15.00' }]);
  const held = store.catalog().find((c) => c.sku === 'NEW-Z');
  assert.equal(held.status, 'held'); assert.match(held.reasons[0].message, /Import the same price again to retry/);
  up = true;
  const again = await store.applyPriceChanges([{ sku: 'NEW-Z', price: '15.00' }]);
  assert.equal(again[0].status, 'live', 'the retry asked the AI, which vouched');
  // an AI hold is never re-asked: the answer on record stands
  const { store: s2 } = makeStore({ reviewAi: fakeAi(() => verdict('implausible', 9000, 12000, 'Too cheap.')) });
  await s2.applyPriceChanges([{ sku: 'NEW-Q', name: 'Other gadget', price: '15.00' }]);
  const res = await s2.applyPriceChanges([{ sku: 'NEW-Q', price: '15.00' }]);
  assert.equal(res[0].unchanged, true);
});
