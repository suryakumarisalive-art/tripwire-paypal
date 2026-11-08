// PayPal webhooks (POST /api/paypal/webhook): verified with PayPal, routed by the store's route token in custom_id, and
// applied so each order shows what PayPal says happened, including what happened outside Tripwire. Tests W1-W11.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeStore, fakePayPal } from './helpers.mjs';
import { route, dispatch, createStoreIds } from '../src/router.mjs';

const kinds = (store, kind) => store.timeline(0, 500).filter((e) => e.kind === kind);
const ids = createStoreIds('test-signing-key-w');
const SID = await ids.issue();
const ROUTE = await ids.routeFor(SID);
const HEADERS = { 'paypal-auth-algo': 'SHA256withRSA', 'paypal-cert-url': 'https://api.sandbox.paypal.com/v1/notifications/certs/CERT-1',
  'paypal-transmission-id': 'tx-1', 'paypal-transmission-sig': 'c2lnbmF0dXJl', 'paypal-transmission-time': '2026-11-08T10:00:00Z' };
let evn = 0;
const ev = (type, resource, id = `WH-${++evn}`) => ({ id, event_type: type, resource_type: 'x', resource });
const tick = (ms) => new Promise((r) => setTimeout(r, ms));

// A store behind the router, with a fake PayPal verifier. verified: PayPal's answer; verifyCalls: what PayPal was asked.
function hook({ verified = true, verifyThrows = false, captureCustom = null, paypal = fakePayPal(), configured = true } = {}) { // verifyThrows: true or an error to throw
  const made = makeStore({ paypal });
  const asked = [];
  const getStore = (sid) => { asked.push(sid); return { call: (m, a) => dispatch(made.store, m, a).catch((e) => ({ __error: { status: e.status || 500, message: e.message } })) }; };
  const verifyCalls = [];
  const config = { storeIds: ids, ...(configured ? {
    verifyWebhook: async (f) => { verifyCalls.push(f); if (verifyThrows) throw (verifyThrows === true ? new Error('PayPal down') : verifyThrows); return verified; },
    captureCustomId: async (cap) => { verifyCalls.push({ captureLookup: cap }); return captureCustom; },
  } : {}) };
  const send = (body, { headers = HEADERS, method = 'POST' } = {}) => route(new Request('https://t.example/api/paypal/webhook', {
    method, body: method === 'POST' ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined, headers: { 'content-type': 'application/json', ...headers },
  }), { getStore, config });
  return { ...made, send, verifyCalls, asked };
}

// A bot order taken through dispatch (so the store learns its route token), left waiting on the merchant.
async function waitingOrder(h, sku = 'KB-Q1PRO') {
  await dispatch(h.store, 'swarm', { sku, n: 1, route: ROUTE });
  const o = h.store.orders()[0];
  h.store.sql.exec("UPDATE orders SET status = 'awaiting_merchant', wait_reason = 'tripped' WHERE id = ?", o.id);
  return h.store.orders()[0];
}
const captured = (h, o, capId) => h.store.sql.exec("UPDATE orders SET status = 'captured', capture_id = ? WHERE id = ?", capId, o.id);
const upLink = (capId) => [{ rel: 'up', href: `https://api.sandbox.paypal.com/v2/payments/captures/${capId}` }];

test('W1 route token: round-trips to its store, refuses tampering, and is neither the store id nor the API key', async () => {
  assert.match(ROUTE, /^twr_[a-f0-9]{88}$/);
  assert.equal(await ids.storeForRoute(ROUTE), SID);
  assert.equal(await ids.storeForRoute(ROUTE.slice(0, -1) + (ROUTE.endsWith('0') ? '1' : '0')), null);
  assert.equal(await ids.storeForRoute(await ids.apiKeyFor(SID)), null);
  assert.equal(await ids.storeForApiKey(ROUTE), null);
  assert.ok(!ROUTE.includes(SID));
  assert.equal(await createStoreIds('another-key').storeForRoute(ROUTE), null);
});

test('W2 every PayPal order a store creates carries its route token as custom_id', async () => {
  const h = hook();
  await dispatch(h.store, 'swarm', { sku: 'KB-Q1PRO', n: 1, route: ROUTE });
  assert.equal(h.paypal.calls.find((c) => c[0] === 'createOrder')[1].customId, ROUTE);
  await dispatch(h.store, 'buyerCreateOrder', { sku: 'LEGO-75192', channel: 'paypal', route: 'twr_not-a-token' }); // never stored
  assert.equal(h.paypal.calls.filter((c) => c[0] === 'createOrder')[1][1].customId, ROUTE);
});

test('W3 HTTP: junk is refused before any PayPal call; a failed signature is 401; PayPal down is 503 (PayPal retries)', async () => {
  const h = hook();
  const voided = (extra = {}) => ev('PAYMENT.AUTHORIZATION.VOIDED', { id: 'A', custom_id: ROUTE, ...extra });
  assert.equal((await h.send({}, { method: 'GET' })).status, 405);
  assert.equal((await h.send(voided(), { headers: {} })).status, 400);
  assert.equal((await h.send(voided(), { headers: { ...HEADERS, 'paypal-cert-url': 'https://evil.example/cert' } })).status, 400);
  assert.equal((await h.send(voided(), { headers: { ...HEADERS, 'paypal-cert-url': 'https://paypal.com.evil.example/c' } })).status, 400);
  assert.equal((await h.send(voided(), { headers: { ...HEADERS, 'paypal-cert-url': 'http://api.paypal.com/c' } })).status, 400);
  assert.equal((await h.send('not json')).status, 400);
  const other = await h.send(ev('BILLING.SUBSCRIPTION.CREATED', {}));
  assert.deepEqual([other.status, (await other.json()).ignored], [200, 'event type not used by Tripwire']);
  assert.equal(h.verifyCalls.length, 0, 'none of that reached PayPal');
  assert.equal((await hook({ verified: false }).send(voided())).status, 401);
  assert.equal((await hook({ verifyThrows: true }).send(voided())).status, 503);
  const { PayPalError } = await import('../src/paypal.mjs');
  assert.equal((await hook({ verifyThrows: new PayPalError(400, 'VALIDATION_ERROR') }).send(voided())).status, 401, 'PayPal refusing the request: not genuine');
  assert.equal((await hook({ verifyThrows: new PayPalError(503, 'SERVICE_UNAVAILABLE') }).send(voided())).status, 503);
  assert.equal((await hook({ verifyThrows: new PayPalError(429, 'RATE_LIMIT_REACHED') }).send(voided())).status, 503);
  assert.equal((await hook({ configured: false }).send(voided())).status, 503);
});

test('W4 HTTP: PayPal verifies the event exactly as sent, and a verified event reaches only the store its token names', async () => {
  const h = hook();
  const o = await waitingOrder(h);
  const raw = JSON.stringify(ev('PAYMENT.AUTHORIZATION.VOIDED', { id: o.authorizationId, custom_id: ROUTE })).replace('":"', '" : "');
  const res = await h.send(raw);
  assert.deepEqual([res.status, (await res.json()).voided], [200, o.id]);
  assert.equal(h.verifyCalls[0].rawEvent, raw, 'byte for byte');
  assert.equal(h.verifyCalls[0].transmissionId, 'tx-1');
  assert.deepEqual(h.asked, [SID]);
  const foreign = await h.send(ev('PAYMENT.AUTHORIZATION.VOIDED', { id: 'X', custom_id: 'chk_some-merchant-check' }));
  assert.deepEqual([foreign.status, (await foreign.json()).ignored], [200, 'not an order of a Tripwire store']);
});

test('W5 AUTHORIZATION.VOIDED outside Tripwire: the waiting order becomes voided once, even when PayPal sends it twice', async () => {
  const h = hook();
  const o = await waitingOrder(h);
  const e = ev('PAYMENT.AUTHORIZATION.VOIDED', { id: o.authorizationId, custom_id: ROUTE });
  assert.equal((await (await h.send(e)).json()).voided, o.id);
  assert.equal(h.store.orders()[0].status, 'voided');
  assert.match(kinds(h.store, 'VOIDED').at(-1).message, /voided outside Tripwire: in PayPal, or it expired/);
  assert.equal((await (await h.send(e)).json()).duplicate, true);
  assert.equal(kinds(h.store, 'VOIDED').length, 1);
  assert.equal(h.paypal.calls.filter((c) => c[0] === 'voidAuthorization').length, 0, 'Tripwire made no PayPal call of its own');
});

test("W6 a void in PayPal while Tripwire's capture is in flight: the failed capture never overwrites the void", async () => {
  const h = hook({ paypal: fakePayPal({ failCapture: true, delayMs: 30 }) });
  await dispatch(h.store, 'swarm', { sku: 'KB-Q1PRO', n: 1, route: ROUTE });
  h.now.advance(25_000);
  const settling = h.store.settle(); // marks it capturing, then waits on PayPal
  await tick(5);
  const o = h.store.orders()[0];
  assert.equal(o.status, 'capturing');
  await h.store.paypalEvent({ id: 'WH-V', type: 'PAYMENT.AUTHORIZATION.VOIDED', resource: { id: o.authorizationId } });
  await settling;
  assert.equal(h.store.orders()[0].status, 'voided');
  assert.equal(kinds(h.store, 'PAYPAL_ERROR').length, 0);
});

test("W7 CAPTURE.COMPLETED: a capture made in PayPal is recorded; one racing Tripwire's own capture is counted once", async () => {
  const h = hook();
  const o = await waitingOrder(h);
  const r = await h.store.paypalEvent({ id: 'WH-C1', type: 'PAYMENT.CAPTURE.COMPLETED', resource: { id: 'CAP-OUT', supplementary_data: { related_ids: { authorization_id: o.authorizationId } } } });
  assert.equal(r.captured, o.id);
  assert.deepEqual([h.store.orders()[0].status, h.store.orders()[0].captureId], ['captured', 'CAP-OUT']);
  assert.match(kinds(h.store, 'CAPTURED')[0].message, /made in PayPal outside Tripwire/);

  const g = hook({ paypal: fakePayPal({ delayMs: 30 }) });
  await dispatch(g.store, 'swarm', { sku: 'KB-Q1PRO', n: 1, route: ROUTE });
  g.now.advance(25_000);
  const settling = g.store.settle();
  await tick(5);
  const p = g.store.orders()[0];
  await g.store.paypalEvent({ id: 'WH-C2', type: 'PAYMENT.CAPTURE.COMPLETED', resource: { id: 'CAP-FAST', supplementary_data: { related_ids: { authorization_id: p.authorizationId } } } });
  await settling;
  assert.equal(g.store.orders()[0].status, 'captured');
  assert.equal(kinds(g.store, 'CAPTURED').length, 1, 'one capture, one event');
  assert.doesNotMatch(kinds(g.store, 'CAPTURED')[0].message, /outside Tripwire/);
});

test('W8 refunds and reversals: a partial then a full refund, a chargeback reversal, and the summary counts', async () => {
  const h = hook();
  const o = await waitingOrder(h);
  captured(h, o, 'CAP-R');
  const refund = (id, value) => h.store.paypalEvent({ id, type: 'PAYMENT.CAPTURE.REFUNDED', resource: { id: `REF-${id}`, amount: { value, currency_code: 'USD' }, links: upLink('CAP-R') } });
  assert.equal((await refund('WH-R1', '50.00')).cents, 5_000);
  assert.deepEqual([h.store.orders()[0].status, h.store.summary().captured.n], ['captured', 1]);
  await refund('WH-R2', '149.00');
  assert.deepEqual([h.store.orders()[0].status, h.store.summary().refunded.n, h.store.summary().captured.n], ['refunded', 1, 0]);
  assert.match(kinds(h.store, 'REFUNDED').at(-1).message, /PayPal refunded \$149\.00 of the \$199\.00/);

  const g = hook();
  const q = await waitingOrder(g);
  captured(g, q, 'CAP-X');
  await g.store.paypalEvent({ id: 'WH-X', type: 'PAYMENT.CAPTURE.REVERSED', resource: { id: 'REV-1', amount: { value: '199.00' }, links: upLink('CAP-X') } });
  assert.deepEqual([g.store.orders()[0].status, g.store.summary().reversed.n], ['reversed', 1]);
  assert.match(kinds(g.store, 'REVERSED')[0].message, /a chargeback or a reversal/);
});

test('W9 HTTP: a refund carries no custom_id, so the router asks PayPal which capture it refunds and routes by that', async () => {
  const h = hook({ captureCustom: ROUTE });
  const o = await waitingOrder(h);
  captured(h, o, 'CAP-9');
  const res = await h.send(ev('PAYMENT.CAPTURE.REFUNDED', { id: 'REF-9', amount: { value: '199.00' }, links: upLink('CAP-9') }));
  assert.equal((await res.json()).refunded, o.id);
  assert.ok(h.verifyCalls.some((c) => c.captureLookup === 'CAP-9'));
  assert.equal(h.store.orders()[0].status, 'refunded');
});

test('W10 CHECKOUT.ORDER.APPROVED: a buyer whose page never came back is authorized after the same price check; a slipped price is not', async () => {
  const h = hook();
  await dispatch(h.store, 'buyerCreateOrder', { sku: 'LEGO-75192', channel: 'paypal', route: ROUTE });
  const o = h.store.orders()[0];
  const r = await h.store.paypalEvent({ id: 'WH-A1', type: 'CHECKOUT.ORDER.APPROVED', resource: { id: o.paypalOrderId } });
  assert.equal(r.approved, true);
  assert.equal(h.store.orders()[0].status, 'authorized');
  assert.equal(kinds(h.store, 'PAYPAL_WEBHOOK').length, 1);
  assert.equal((await h.store.paypalEvent({ id: 'WH-A2', type: 'CHECKOUT.ORDER.APPROVED', resource: { id: o.paypalOrderId } })).unchanged, 'authorized');

  const g = hook();
  await dispatch(g.store, 'buyerCreateOrder', { sku: 'TV-BRAVIA-65', channel: 'paypal', route: ROUTE });
  await g.store.applyPriceChanges([{ sku: 'TV-BRAVIA-65', price: '129.90' }]); // the price slipped after the buyer started
  const p = g.store.orders()[0];
  const b = await g.store.paypalEvent({ id: 'WH-A3', type: 'CHECKOUT.ORDER.APPROVED', resource: { id: p.paypalOrderId } });
  assert.deepEqual([b.approved, b.code, g.store.orders()[0].status], [false, 'HELD', 'blocked']);
  assert.equal(g.paypal.calls.filter((c) => c[0] === 'authorizeOrder').length, 0);
});

test('W11 CAPTURE.DECLINED marks the order failed; events for unknown or reset orders change nothing; reset keeps the token', async () => {
  const h = hook();
  const o = await waitingOrder(h);
  captured(h, o, 'CAP-D');
  assert.equal((await h.store.paypalEvent({ id: 'WH-D', type: 'PAYMENT.CAPTURE.DECLINED', resource: { id: 'CAP-D' } })).declined, o.id);
  assert.equal(h.store.orders()[0].status, 'failed');
  assert.equal((await h.store.paypalEvent({ id: 'WH-U', type: 'PAYMENT.AUTHORIZATION.VOIDED', resource: { id: 'NOPE' } })).ignored, 'unknown authorization');
  await h.store.reset();
  assert.equal(h.store.sql.exec("SELECT v FROM meta WHERE k = 'route'").one().v, ROUTE);
  assert.equal((await h.store.paypalEvent({ id: 'WH-D2', type: 'PAYMENT.CAPTURE.COMPLETED', resource: { id: 'CAP-D' } })).ignored, 'unknown capture');
});

test('W12 PayPal client: verify-webhook-signature gets the transmission fields and the raw event spliced in unchanged', async () => {
  const { createPayPal } = await import('../src/paypal.mjs');
  const sent = [];
  const fetchImpl = async (url, init) => {
    if (url.endsWith('/v1/oauth2/token')) return new Response(JSON.stringify({ access_token: 'T', expires_in: 3600 }), { status: 200 });
    sent.push({ url, init });
    return new Response(JSON.stringify({ verification_status: sent.length === 1 ? 'SUCCESS' : 'FAILURE' }), { status: 200 });
  };
  const pp = createPayPal({ clientId: 'id', clientSecret: 'secret', fetchImpl });
  const rawEvent = '{"id":"WH-1", "event_type":"PAYMENT.CAPTURE.COMPLETED","resource":{"amount":{"value":"10.50"}}}';
  const args = { authAlgo: 'SHA256withRSA', certUrl: 'https://api.sandbox.paypal.com/c', transmissionId: 't1', transmissionSig: 's1', transmissionTime: '2026-11-08T10:00:00Z', webhookId: 'WHID1', rawEvent };
  assert.equal(await pp.verifyWebhook(args), true);
  assert.equal(await pp.verifyWebhook(args), false);
  assert.match(sent[0].url, /\/v1\/notifications\/verify-webhook-signature$/);
  assert.ok(sent[0].init.body.endsWith(`,"webhook_event":${rawEvent}}`), 'the event is sent byte for byte');
  assert.deepEqual(JSON.parse(sent[0].init.body), { auth_algo: 'SHA256withRSA', cert_url: 'https://api.sandbox.paypal.com/c', transmission_id: 't1', transmission_sig: 's1', transmission_time: '2026-11-08T10:00:00Z', webhook_id: 'WHID1', webhook_event: JSON.parse(rawEvent) });
});
