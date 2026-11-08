// Tripwire's MCP server (POST /api/mcp): the merchant gate as tools an AI agent or agentic checkout calls before PayPal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { route, dispatch, createStoreIds } from '../src/router.mjs';
import { makeStore, clock, fakeAi, verdict } from './helpers.mjs';

const ORIGIN = 'https://tripwire.example';
const storeIds = createStoreIds('test-signing-key');
const SID = await storeIds.issue();
const KEY = await storeIds.apiKeyFor(SID);

function harness({ limit, reviewAi } = {}) {
  const now = clock();
  const { store, paypal } = makeStore({ now, reviewAi });
  const getStore = () => ({ call: (m, a) => dispatch(store, m, a).catch((e) => ({ __error: { status: e.status || 500, message: e.message } })) });
  const config = { paypalClientId: 'x', paypalReady: true, aiReady: true, storeIds, limit };
  const raw = (body, { method = 'POST', headers = {} } = {}) => route(new Request(`${ORIGIN}/api/mcp`, {
    method, body: method === 'POST' ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${KEY}`, ...headers },
  }), { getStore, config });
  let id = 0;
  const rpc = async (method, params) => (await raw({ jsonrpc: '2.0', id: ++id, method, params })).json();
  const tool = async (name, args) => (await rpc('tools/call', { name, arguments: args })).result;
  return { store, paypal, now, raw, rpc, tool };
}

test('initialize, the initialized notification, ping and tools/list', async () => {
  const { raw, rpc } = harness();
  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.deepEqual(init.result.capabilities, { tools: { listChanged: false } });
  assert.equal(init.result.serverInfo.name, 'tripwire');
  assert.match(init.result.instructions, /check_price before you create a PayPal order/);
  assert.equal((await rpc('initialize', { protocolVersion: '1999-01-01' })).result.protocolVersion, '2025-06-18', 'an unknown version gets ours');
  const note = await raw({ jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.equal(note.status, 202); assert.equal(await note.text(), '');
  assert.deepEqual((await rpc('ping')).result, {});
  const tools = (await rpc('tools/list')).result.tools;
  assert.deepEqual(tools.map((t) => t.name), ['check_price', 'check_capture']);
  assert.deepEqual(tools[0].inputSchema.required, ['sku', 'priceCents']);
  assert.deepEqual(tools[1].inputSchema.required, ['checkId', 'amountCents', 'authorizationId']);
});

test('check_price: a slipped decimal is a HOLD for the agent, and no PayPal order is created', async () => {
  const { tool, paypal, store } = harness({ reviewAi: fakeAi(() => verdict('implausible', 110000, 150000, 'A 65" Mini LED TV costs about $1,100-$1,500.')) });
  const r = await tool('check_price', { sku: 'TV-BRAVIA-65', priceCents: 12990 });
  assert.equal(r.isError, false);
  assert.equal(r.structuredContent.decision, 'hold'); assert.equal(r.structuredContent.checkId, null);
  assert.match(r.content[0].text, /^HOLD \(HELD\): do not create a PayPal order/);
  assert.equal(paypal.calls.length, 0);
  assert.ok(store.timeline().some((e) => e.kind === 'CHECKOUT_REFUSED' && /^AI agent \(MCP\) checkout for Sony Bravia/.test(e.message)), 'the console shows it was an agent');
});

test('check_price then check_capture: allow, wait while cooling, then capture', async () => {
  const { tool, now, store } = harness();
  const a = await tool('check_price', { sku: 'KB-Q1PRO', priceCents: 19900 });
  assert.equal(a.structuredContent.decision, 'allow'); assert.match(a.structuredContent.checkId, /^chk_/);
  assert.match(a.content[0].text, /^ALLOW: create the PayPal order for exactly \$199\.00 with intent AUTHORIZE/);
  assert.ok(store.timeline().some((e) => e.kind === 'API_ALLOWED' && /^An AI agent checkout \(MCP\) may sell/.test(e.message)));
  const w = await tool('check_capture', { checkId: a.structuredContent.checkId, amountCents: 19900, authorizationId: 'AUTH-1' });
  assert.equal(w.structuredContent.decision, 'wait'); assert.match(w.content[0].text, /^WAIT \(COOLING\)/);
  now.advance(21_000);
  const c = await tool('check_capture', { checkId: a.structuredContent.checkId, amountCents: 19900, authorizationId: 'AUTH-1' });
  assert.equal(c.structuredContent.decision, 'capture'); assert.match(c.content[0].text, /^CAPTURE/);
  const v = await tool('check_capture', { checkId: a.structuredContent.checkId, amountCents: 19999, authorizationId: 'AUTH-1' });
  assert.equal(v.structuredContent.decision, 'void'); assert.match(v.content[0].text, /^VOID \(AMOUNT_MISMATCH\): void the authorization, never capture it/);
});

test('agents rushing through MCP count in the same breaker as everyone else', async () => {
  const { tool, store } = harness();
  const answers = await Promise.all(Array.from({ length: 8 }, () => tool('check_price', { sku: 'LEGO-75192', priceCents: 84999 })));
  assert.equal(answers.filter((r) => r.structuredContent.decision === 'allow').length, 5);
  assert.equal(answers.filter((r) => r.structuredContent.code === 'TRIPPED').length, 3);
  assert.equal(store.catalog().find((c) => c.sku === 'LEGO-75192').status, 'tripped');
});

test('bad tool input is a tool error the agent can read; unknown tools and methods are JSON-RPC errors', async () => {
  const { tool, rpc } = harness();
  const bad = await tool('check_price', { sku: 'not a sku!', priceCents: 100 });
  assert.equal(bad.isError, true); assert.match(bad.content[0].text, /^Invalid input: SKU must be/);
  const badPrice = await tool('check_price', { sku: 'KB-Q1PRO', priceCents: '199.00' });
  assert.equal(badPrice.isError, true);
  assert.equal((await rpc('tools/call', { name: 'buy_now', arguments: {} })).error.code, -32602);
  assert.equal((await rpc('resources/list')).error.code, -32601);
});

test('malformed messages get JSON-RPC errors', async () => {
  const { raw } = harness();
  const notJson = await raw('{nope');
  assert.equal(notJson.status, 400); assert.equal((await notJson.json()).error.code, -32700);
  assert.equal((await (await raw({ id: 1, method: 'ping' })).json()).error.code, -32600, 'jsonrpc 2.0 is required');
  assert.equal((await (await raw({ jsonrpc: '2.0', id: { x: 1 }, method: 'ping' })).json()).error.code, -32600, 'an id must be a string or an integer');
  const reply = await raw({ jsonrpc: '2.0', id: 9, result: {} }); // a response sent to the server
  assert.equal(reply.status, 202);
});

test('batches (2025-03-26): each message answered in order; notifications drop out; an empty batch is invalid', async () => {
  const { raw } = harness();
  const both = await (await raw([{ jsonrpc: '2.0', id: 1, method: 'ping' }, { jsonrpc: '2.0', method: 'notifications/initialized' }, { jsonrpc: '2.0', id: 'b', method: 'tools/list' }])).json();
  assert.deepEqual(both.map((r) => r.id), [1, 'b']);
  assert.equal(both[1].result.tools.length, 2);
  assert.equal((await raw([{ jsonrpc: '2.0', method: 'notifications/initialized' }])).status, 202);
  const empty = await raw([]);
  assert.equal(empty.status, 400); assert.equal((await empty.json()).error.code, -32600);
});

test('check_price refuses a currency other than USD instead of ignoring it', async () => {
  const { tool, store } = harness();
  const eur = await tool('check_price', { sku: 'KB-Q1PRO', priceCents: 19900, currency: 'EUR' });
  assert.equal(eur.isError, true); assert.match(eur.content[0].text, /USD prices only/);
  assert.equal(store.timeline().filter((e) => e.kind === 'API_ALLOWED').length, 0, 'nothing was checked');
  assert.equal((await tool('check_price', { sku: 'KB-Q1PRO', priceCents: 19900, currency: 'USD' })).structuredContent.decision, 'allow');
});

test('transport security: API key required, no cross-site browser origin, no GET stream, known protocol versions only', async () => {
  const { raw } = harness();
  const ping = { jsonrpc: '2.0', id: 1, method: 'ping' };
  const noKey = await raw(ping, { headers: { authorization: '' } });
  assert.equal(noKey.status, 401); assert.equal(noKey.headers.get('www-authenticate'), 'Bearer');
  assert.equal((await raw(ping, { headers: { authorization: `Bearer ${SID}` } })).status, 401, 'the console store id is not an API key');
  assert.equal((await raw(ping, { headers: { origin: 'https://evil.example' } })).status, 403);
  assert.equal((await raw(ping, { headers: { origin: ORIGIN } })).status, 200);
  const get = await raw(undefined, { method: 'GET' });
  assert.equal(get.status, 405); assert.equal(get.headers.get('allow'), 'POST');
  assert.equal((await raw(ping, { headers: { 'mcp-protocol-version': '2024-01-01' } })).status, 400);
  assert.equal((await raw(ping, { headers: { 'mcp-protocol-version': '2025-06-18' } })).status, 200);
  const limited = harness({ limit: async () => false });
  assert.equal((await limited.raw(ping)).status, 429);
});

test('check_price takes a quantity: the answer names the full amount, and one 500-unit order trips the breaker', async () => {
  const { tool, paypal, store } = harness();
  const ok = await tool('check_price', { sku: 'KB-Q1PRO', priceCents: 19900, quantity: 2 });
  assert.equal(ok.structuredContent.amountCents, 39800);
  assert.match(ok.content[0].text, /^ALLOW: create the PayPal order for exactly \$398\.00 \(2 × \$199\.00\)/);
  const big = await tool('check_price', { sku: 'LEGO-75192', priceCents: 84999, quantity: 500 });
  assert.deepEqual([big.structuredContent.decision, big.structuredContent.code], ['hold', 'TRIPPED']);
  const bad = await tool('check_price', { sku: 'KB-Q1PRO', priceCents: 19900, quantity: '2' });
  assert.equal(bad.isError, true);
  assert.equal(paypal.calls.length, 0); assert.equal(store.catalog().find((c) => c.sku === 'LEGO-75192').status, 'tripped');
});
