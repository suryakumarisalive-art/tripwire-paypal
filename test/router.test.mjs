import { test } from 'node:test';
import assert from 'node:assert/strict';
import { route, dispatch, createStoreIds } from '../src/router.mjs';
import { makeStore } from './helpers.mjs';
import { parseCsv } from '../src/csv.mjs';

const ORIGIN = 'https://tripwire.example';
const storeIds = createStoreIds('test-signing-key');
const SID = await storeIds.issue();

function harness({ limit } = {}) {
  const { store, paypal } = makeStore();
  const getStore = () => ({ call: (m, a) => dispatch(store, m, a).catch((e) => ({ __error: { status: e.status || 500, message: e.message } })) });
  const send = (path, { method = 'GET', body, headers = {} } = {}) => route(new Request(`${ORIGIN}${path}`, {
    method, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), origin: ORIGIN, ...headers },
  }), { getStore, config: { paypalClientId: 'public-client-id', paypalReady: true, aiReady: true, storeIds, limit } });
  return { store, paypal, send };
}

test('health, config and presets', async () => {
  const { send } = harness();
  assert.deepEqual(await (await send('/api/health')).json(), { ok: true, paypal: true, ai: true, environment: 'PayPal sandbox' });
  assert.equal((await (await send('/api/config')).json()).paypalClientId, 'public-client-id');
  const presets = (await (await send('/api/presets')).json()).presets;
  assert.deepEqual(presets.map((p) => p.id), ['decimal_slip', 'new_products', 'black_friday', 'doorbuster']);
  for (const p of presets) assert.ok(parseCsv(p.csv).rows.length > 0);
});

test('health reports when each outside service last worked, when the Worker provides it', async () => {
  const checks = { aiCallsToday: 3, aiCallsPerDay: 800, services: { ai: { lastOkAt: 1, lastErrorAt: null, lastError: null } } };
  const res = await route(new Request(`${ORIGIN}/api/health`), { getStore: () => null, config: { paypalReady: true, aiReady: true, storeIds, status: async () => checks } });
  assert.deepEqual((await res.json()).checks, checks);
  const broken = await route(new Request(`${ORIGIN}/api/health`), { getStore: () => null, config: { storeIds, status: async () => { throw new Error('down'); } } });
  assert.equal(broken.status, 200, 'health never fails because the status lookup did');
});

test('session issues a 32-hex store id', async () => {
  const { send } = harness();
  const r = await (await send('/api/session', { method: 'POST', body: {} })).json();
  assert.match(r.storeId, /^[a-f0-9]{32}$/);
  assert.equal(await storeIds.verify(r.storeId), true);
});

test('F7: a made-up store id is refused before any store is created; rate limits answer 429', async () => {
  const { send } = harness();
  assert.equal((await send(`/api/store/state?store=${'a'.repeat(32)}`)).status, 400);
  assert.equal((await send(`/api/store/state?store=${SID.slice(0, 31)}0`)).status, SID.endsWith('0') ? 200 : 400);
  const limited = harness({ limit: async (bucket) => bucket !== 'write' });
  assert.equal((await limited.send(`/api/store/state?store=${SID}`)).status, 200);
  assert.equal((await limited.send(`/api/store/swarm?store=${SID}`, { method: 'POST', body: { sku: 'KB-Q1PRO' } })).status, 429);
  const noSessions = harness({ limit: async (bucket) => bucket !== 'session' });
  assert.equal((await noSessions.send('/api/session', { method: 'POST', body: {} })).status, 429);
});

test('a chunked body over the limit is refused without a Content-Length', async () => {
  const { send } = harness();
  const big = new ReadableStream({ start(c) { for (let i = 0; i < 20; i++) c.enqueue(new TextEncoder().encode('x'.repeat(4096))); c.close(); } });
  const r = await route(new Request(`${ORIGIN}/api/store/import?store=${SID}`, { method: 'POST', body: big, duplex: 'half', headers: { 'content-type': 'application/json', origin: ORIGIN } }),
    { getStore: () => ({ call: async () => ({}) }), config: { storeIds } });
  assert.equal(r.status, 413);
  void send;
});

test('AC9: cross-site POSTs are refused, by Origin and by Sec-Fetch-Site', async () => {
  const { send, paypal } = harness();
  let r = await send(`/api/store/swarm?store=${SID}`, { method: 'POST', body: { sku: 'KB-Q1PRO' }, headers: { origin: 'https://evil.example' } });
  assert.equal(r.status, 403);
  r = await send(`/api/store/swarm?store=${SID}`, { method: 'POST', body: { sku: 'KB-Q1PRO' }, headers: { 'sec-fetch-site': 'cross-site' } });
  assert.equal(r.status, 403);
  assert.equal(paypal.calls.length, 0);
});

test('AC9: bad store ids, non-JSON, oversized bodies and unknown routes are refused', async () => {
  const { send } = harness();
  assert.equal((await send('/api/store/state?store=nope')).status, 400);
  assert.equal((await send('/api/store/state')).status, 400);
  assert.equal((await send(`/api/store/reset?store=${SID}`, { method: 'POST', body: 'x', headers: { 'content-type': 'text/plain' } })).status, 415);
  assert.equal((await send(`/api/store/reset?store=${SID}`, { method: 'POST', body: '[1,2]' })).status, 400);
  assert.equal((await send(`/api/store/import?store=${SID}`, { method: 'POST', body: { csv: 'x'.repeat(80_000) } })).status, 413);
  assert.equal((await send(`/api/store/nope?store=${SID}`, { method: 'POST', body: {} })).status, 404);
  assert.equal((await send('/api/nope')).status, 404);
  assert.equal((await send(`/api/store/state?store=${SID}`, { method: 'DELETE' })).status, 405);
});

test('import a preset over HTTP, then state shows the hold and the timeline', async () => {
  const { send } = harness();
  const presets = (await (await send('/api/presets')).json()).presets;
  const r = await send(`/api/store/import?store=${SID}`, { method: 'POST', body: { csv: presets[0].csv } });
  assert.equal(r.status, 200);
  const state = await (await send(`/api/store/state?store=${SID}`)).json();
  const tv = state.catalog.find((c) => c.sku === 'TV-BRAVIA-65');
  assert.equal(tv.status, 'held');
  assert.ok(state.timeline.some((e) => e.kind === 'PRICE_HELD'));
  assert.ok('summary' in state && 'orders' in state);
});

test('a bad CSV is a 400 with a plain message', async () => {
  const { send } = harness();
  const r = await send(`/api/store/import?store=${SID}`, { method: 'POST', body: { csv: 'name,cost\nx,1' } });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /sku/);
});

test('checkout of a held item is a 409 and creates no PayPal order (AC1)', async () => {
  const { send, paypal } = harness();
  await send(`/api/store/price?store=${SID}`, { method: 'POST', body: { sku: 'TV-BRAVIA-65', price: '129.90' } });
  const r = await send(`/api/store/checkout?store=${SID}`, { method: 'POST', body: { sku: 'TV-BRAVIA-65', channel: 'paypal' } });
  assert.equal(r.status, 409);
  assert.equal((await r.json()).code, 'HELD');
  assert.equal(paypal.calls.length, 0);
});

test('store errors become 4xx with their message, never a stack', async () => {
  const { send } = harness();
  const r = await send(`/api/store/hold?store=${SID}`, { method: 'POST', body: { sku: 'KB-Q1PRO', action: 'confirm', priceCents: 19900 } });
  assert.equal(r.status, 409);
  assert.deepEqual(await r.json(), { error: 'This item is not held.' });
});

test('decide refuses an unknown waitReason instead of acting on every waiting order', async () => {
  const { send } = harness();
  const r = await send(`/api/store/decide?store=${SID}`, { method: 'POST', body: { sku: 'KB-Q1PRO', action: 'void', waitReason: 'everything' } });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /waitReason must be one of/);
});

test('a hold decision names the price the merchant saw: malformed is a 400, a changed price is refused', async () => {
  const { send } = harness();
  for (const bad of ['19900', 199.0001, null]) {
    const r = await send(`/api/store/hold?store=${SID}`, { method: 'POST', body: { sku: 'KB-Q1PRO', action: 'confirm', priceCents: bad } });
    assert.equal(r.status, 400, `priceCents ${JSON.stringify(bad)}`);
  }
  // an older console that sends no price still works (no staleness check for it)
  const legacy = await send(`/api/store/hold?store=${SID}`, { method: 'POST', body: { sku: 'KB-Q1PRO', action: 'confirm' } });
  assert.equal(legacy.status, 409); assert.deepEqual(await legacy.json(), { error: 'This item is not held.' });
  await send(`/api/store/import?store=${SID}`, { method: 'POST', body: { csv: 'sku,name,price\nTV-BRAVIA-65,,129.90\n' } });
  const stale = await send(`/api/store/hold?store=${SID}`, { method: 'POST', body: { sku: 'TV-BRAVIA-65', action: 'fix', priceCents: 129900 } });
  assert.equal(stale.status, 409);
  assert.match((await stale.json()).error, /changed to \$129\.90/);
});

test('the storefront sees products without reasons or costs', async () => {
  const { send } = harness();
  const p = (await (await send(`/api/store/products?store=${SID}`)).json()).products;
  assert.ok(p.length >= 8);
  assert.ok(p.every((x) => !('costCents' in x) && !('reasons' in x)));
});

test('unknown store methods are refused by dispatch', async () => {
  const { store } = makeStore();
  assert.deepEqual(await dispatch(store, 'init', {}), { __error: { status: 404, message: 'Unknown store method.' } });
});
