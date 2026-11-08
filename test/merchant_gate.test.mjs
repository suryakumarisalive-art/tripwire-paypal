// The merchant gate (docs/GATE.md): a real merchant's own server asks Tripwire before it creates a PayPal order
// (/api/v1/check) and before it captures (/api/v1/capture-check). Tests G (check), C (capture-check), H (HTTP and keys).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeStore, fakeAi, verdict, clock } from './helpers.mjs';
import { route, dispatch, createStoreIds } from '../src/router.mjs';

const kinds = (store, kind) => store.timeline(0, 500).filter((e) => e.kind === kind);
const checksCount = (store) => store.sql.exec('SELECT COUNT(*) AS n FROM checks').one().n;
const item = (store, sku) => store.catalog().find((c) => c.sku === sku);
const KB = { sku: 'KB-Q1PRO', priceCents: 19900 };

// An AI whose answers wait until the test releases them, so a test can act while a check is "thinking".
function gatedAi(answer) {
  const gates = [];
  const fn = async (rows) => {
    fn.calls.push(rows);
    let release; const g = new Promise((r) => { release = r; }); gates.push(release); await g;
    const verdicts = new Map(); for (const r of rows) { const v = answer(r); if (v) verdicts.set(r.sku, v); }
    return { ok: true, verdicts };
  };
  fn.calls = []; fn.gates = gates;
  return fn;
}
const until = async (cond) => { for (let i = 0; i < 50 && !cond(); i++) await new Promise((r) => setImmediate(r)); assert.ok(cond(), 'condition never became true'); };

// ---------- G: /check ----------

test('G1 API check: a known live price is allowed with a check id; no order, no PayPal call, no AI call', async () => {
  const { store, paypal, reviewAi } = makeStore();
  const r = await store.apiCheck(KB);
  assert.equal(r.decision, 'allow'); assert.equal(r.code, 'ALLOWED'); assert.match(r.checkId, /^chk_/); assert.equal(r.priceCents, 19900);
  assert.equal(store.orders().length, 0); assert.equal(paypal.calls.length, 0); assert.equal(reviewAi.calls.length, 0);
  assert.equal(kinds(store, 'API_ALLOWED').length, 1);
});

test('G2 API check: a decimal slip is held by code before any PayPal order', async () => {
  const { store, paypal } = makeStore();
  const r = await store.apiCheck({ sku: 'TV-BRAVIA-65', priceCents: 12990 });
  assert.deepEqual([r.decision, r.code, r.checkId], ['hold', 'HELD', null]);
  assert.ok(item(store, 'TV-BRAVIA-65').reasons.some((x) => x.code === 'DECIMAL_SHIFT'));
  const refused = kinds(store, 'CHECKOUT_REFUSED');
  assert.equal(refused.length, 1); assert.match(refused[0].message, /^API checkout for .* at \$129\.90 refused before PayPal/);
  assert.equal(store.summary().refusedCheckouts, 1); assert.equal(store.summary().lossPreventedCents, 116910);
  assert.equal(paypal.calls.length, 0); assert.equal(checksCount(store), 0);
});

test('G3 API check: a brand-new SKU waits for the AI, is allowed when the AI vouches, and the next check skips the AI', async () => {
  const ai = fakeAi(() => verdict('ok', 9999, 14999, 'Typical price $100-$150.'));
  const { store } = makeStore({ reviewAi: ai });
  const a = await store.apiCheck({ sku: 'MX-ANKER-737', name: 'Anker 737 Power Bank', priceCents: 10999 });
  assert.equal(a.decision, 'allow'); assert.equal(ai.calls.length, 1);
  const b = await store.apiCheck({ sku: 'MX-ANKER-737', priceCents: 10999 });
  assert.equal(b.decision, 'allow'); assert.notEqual(b.checkId, a.checkId); assert.equal(ai.calls.length, 1);
});

test('G4 API check: with the AI down a new SKU is held and a known price still sells', async () => {
  const { store } = makeStore({ reviewAi: fakeAi(() => null, { ok: false, error: 'AI check timed out.' }) });
  const r = await store.apiCheck({ sku: 'MX-NEW-1', name: 'Some new gadget', priceCents: 4999 });
  assert.deepEqual([r.decision, r.code], ['hold', 'HELD']);
  assert.ok(item(store, 'MX-NEW-1').reasons.some((x) => x.code === 'UNVERIFIED'));
  assert.equal(kinds(store, 'AI_ERROR').length, 1);
  assert.equal((await store.apiCheck(KB)).decision, 'allow');
});

test('G5 API check: a second check during the first one\'s AI check is held as CHECKING', async () => {
  const ai = gatedAi(() => verdict('ok', 9999, 14999, 'Fine.'));
  const { store } = makeStore({ reviewAi: ai });
  const p1 = store.apiCheck({ sku: 'MX-ANKER-737', name: 'Anker 737 Power Bank', priceCents: 10999 });
  await until(() => ai.gates.length === 1);
  const second = await store.apiCheck({ sku: 'MX-ANKER-737', priceCents: 10999 });
  assert.deepEqual([second.decision, second.code], ['hold', 'CHECKING']);
  ai.gates[0]();
  assert.equal((await p1).decision, 'allow');
});

test('G6 API check: a price changed during the AI check is allowed at neither price', async () => {
  const ai = gatedAi(() => verdict('ok', 24900, 34999, 'A normal sale.'));
  const { store } = makeStore({ reviewAi: ai });
  const p = store.apiCheck({ sku: 'HP-SONY-XM5', priceCents: 25999 }); // 26% below: needs the AI
  await until(() => ai.gates.length === 1);
  store.resolveHold('HP-SONY-XM5', 'fix'); // the merchant restores $349.99 meanwhile
  ai.gates[0]();
  const r = await p;
  assert.deepEqual([r.decision, r.code], ['hold', 'SUPERSEDED']);
  assert.equal(checksCount(store), 0); assert.equal(item(store, 'HP-SONY-XM5').priceCents, 34999);
});

test('G7 API check: a reset during the AI check answers RESET and leaves nothing behind', async () => {
  const ai = gatedAi(() => verdict('ok', 9999, 14999, 'Fine.'));
  const { store } = makeStore({ reviewAi: ai });
  const p = store.apiCheck({ sku: 'MX-ANKER-737', name: 'Anker 737 Power Bank', priceCents: 10999 });
  await until(() => ai.gates.length === 1);
  await store.reset();
  ai.gates[0]();
  const r = await p;
  assert.deepEqual([r.decision, r.code], ['hold', 'RESET']);
  assert.equal(item(store, 'MX-ANKER-737'), undefined); assert.equal(checksCount(store), 0);
});

test('G8 API check: 25 concurrent checks with a limit of 5 allow exactly 5 and trip once', async () => {
  const { store, paypal } = makeStore();
  const rs = await Promise.all(Array.from({ length: 25 }, () => store.apiCheck({ sku: 'LEGO-75192', priceCents: 84999 })));
  assert.equal(rs.filter((r) => r.decision === 'allow').length, 5);
  assert.equal(rs.filter((r) => r.code === 'TRIPPED').length, 20);
  assert.equal(kinds(store, 'BREAKER_TRIPPED').length, 1);
  assert.equal(store.orders().length, 0); assert.equal(paypal.calls.length, 0); assert.equal(checksCount(store), 5);
});

test('G9 API check: velocity counts API and demo checkouts in one window', async () => {
  const { store, paypal } = makeStore();
  for (let i = 0; i < 3; i++) assert.equal((await store.apiCheck(KB)).decision, 'allow');
  for (let i = 0; i < 2; i++) assert.equal((await store.botCheckout('KB-Q1PRO')).ok, true);
  const sixth = await store.apiCheck(KB);
  assert.deepEqual([sixth.decision, sixth.code], ['hold', 'TRIPPED']);
  assert.equal(paypal.calls.filter((c) => c[0] === 'createOrder').length, 2);
});

test('G10 API check: the API never releases a trip, at the same price or a new one', async () => {
  const { store } = makeStore();
  await store.swarm('LEGO-75192', 25);
  assert.equal(item(store, 'LEGO-75192').status, 'tripped');
  for (const priceCents of [84999, 79999]) {
    const r = await store.apiCheck({ sku: 'LEGO-75192', priceCents });
    assert.deepEqual([r.decision, r.code], ['hold', 'TRIPPED']);
  }
  const s = item(store, 'LEGO-75192');
  assert.equal(s.status, 'tripped'); assert.equal(s.priceCents, 84999); assert.equal(kinds(store, 'RESUMED').length, 0);
});

test('G11 API check: zero is held as NON_POSITIVE; fractional or string cents are a 400', async () => {
  const { store } = makeStore();
  const r = await store.apiCheck({ sku: 'KB-Q1PRO', priceCents: 0 });
  assert.deepEqual([r.decision, r.code], ['hold', 'HELD']);
  assert.ok(item(store, 'KB-Q1PRO').reasons.some((x) => x.code === 'NON_POSITIVE'));
  for (const priceCents of [199.5, '19900', NaN, -1, -100000000]) await assert.rejects(store.apiCheck({ sku: 'KB-Q1PRO', priceCents }), (e) => e.status === 400);
});

// ---------- C: /capture-check ----------

test('C1 capture-check: waits through cooling, then captures only while live at exactly the checked price', async () => {
  const { store, paypal, now } = makeStore();
  const { checkId } = await store.apiCheck(KB);
  const w = store.captureCheck(checkId, 19900, 'AUTH123');
  assert.deepEqual([w.decision, w.reason, w.retryAfterMs], ['wait', 'COOLING', 20000]);
  now.advance(21_000);
  const c = store.captureCheck(checkId, 19900, 'AUTH123');
  assert.deepEqual([c.decision, c.reason, c.repeat], ['capture', 'LIVE', false]);
  const ev = kinds(store, 'API_CAPTURE'); assert.equal(ev.length, 1); assert.equal(ev[0].paypalId, 'AUTH123');
  assert.equal(paypal.calls.length, 0);
});

test('C2 capture-check: an amount other than the checked price is void, and the check stays void', async () => {
  const { store } = makeStore();
  const { checkId } = await store.apiCheck(KB);
  const v = store.captureCheck(checkId, 19800, 'AUTH-1');
  assert.deepEqual([v.decision, v.reason], ['void', 'AMOUNT_MISMATCH']);
  const again = store.captureCheck(checkId, 19900, 'AUTH-1');
  assert.deepEqual([again.decision, again.reason, again.repeat], ['void', 'AMOUNT_MISMATCH', true]);
});

test('C3 capture-check: a repeat after capture answers capture again with no second event', async () => {
  const { store, now } = makeStore();
  const { checkId } = await store.apiCheck(KB);
  now.advance(21_000);
  assert.equal(store.captureCheck(checkId, 19900, 'AUTH-1').decision, 'capture');
  const r = store.captureCheck(checkId, 19900, 'AUTH-1');
  assert.deepEqual([r.decision, r.repeat], ['capture', true]);
  assert.equal(kinds(store, 'API_CAPTURE').length, 1);
  assert.equal(store.captureCheck(checkId, 100, 'AUTH-1').decision, 'void'); // a different amount is never cleared
  assert.equal(store.captureCheck(checkId, 19900, 'AUTH-1').decision, 'capture'); // and the stored capture stays
});

test('C4 capture-check: a price changed after the check is void once the item is live at the new price', async () => {
  const { store } = makeStore();
  const first = await store.apiCheck(KB);
  assert.equal((await store.apiCheck({ sku: 'KB-Q1PRO', priceCents: 18900 })).decision, 'allow'); // a 5% sale goes live
  const r = store.captureCheck(first.checkId, 19900, 'AUTH-1');
  assert.deepEqual([r.decision, r.reason], ['void', 'PRICE_CHANGED']);
  assert.match(r.message, /\$189\.00/);
  assert.equal(kinds(store, 'API_VOID').length, 1);
});

test('C5 capture-check: a slip held after the sale means wait; fixing back captures', async () => {
  const { store, now } = makeStore();
  const { checkId } = await store.apiCheck({ sku: 'TV-BRAVIA-65', priceCents: 129900 });
  assert.equal((await store.apiCheck({ sku: 'TV-BRAVIA-65', priceCents: 12990 })).decision, 'hold');
  now.advance(21_000);
  const w = store.captureCheck(checkId, 129900, 'AUTH-1');
  assert.deepEqual([w.decision, w.reason], ['wait', 'HELD']);
  assert.equal(item(store, 'TV-BRAVIA-65').apiWaiting, 1);
  store.resolveHold('TV-BRAVIA-65', 'fix');
  assert.equal(store.captureCheck(checkId, 129900, 'AUTH-1').decision, 'capture');
  assert.equal(item(store, 'TV-BRAVIA-65').apiWaiting, 0);
});

test('C6 capture-check: a trip means wait; fix voids every waiting check, resume captures them', async () => {
  for (const decision of ['fix', 'resume']) {
    const { store, now } = makeStore();
    await store.applyPriceChanges([{ sku: 'LEGO-75192', price: '84.99' }], 'import'); // a slip, held by code
    store.resolveHold('LEGO-75192', 'confirm'); // confirmed by mistake
    const rs = []; for (let i = 0; i < 6; i++) rs.push(await store.apiCheck({ sku: 'LEGO-75192', priceCents: 8499 }));
    const ids = rs.filter((r) => r.decision === 'allow').map((r) => r.checkId);
    assert.equal(ids.length, 5); assert.equal(rs[5].code, 'TRIPPED');
    now.advance(21_000);
    for (let round = 0; round < 2; round++) for (const id of ids) assert.deepEqual([store.captureCheck(id, 8499, 'AUTH-1').decision, store.captureCheck(id, 8499, 'AUTH-1').reason], ['wait', 'TRIPPED']);
    assert.equal(item(store, 'LEGO-75192').apiWaiting, 5);
    assert.equal(kinds(store, 'API_WAIT').length, 5); // once per check, however often the merchant polls
    if (decision === 'fix') {
      store.resolveHold('LEGO-75192', 'fix'); // back to $849.99
      for (const id of ids) assert.deepEqual([store.captureCheck(id, 8499, 'AUTH-1').decision, store.captureCheck(id, 8499, 'AUTH-1').reason], ['void', 'PRICE_CHANGED']);
    } else {
      store.resume('LEGO-75192'); // the merchant honors $84.99
      for (const id of ids) assert.equal(store.captureCheck(id, 8499, 'AUTH-1').decision, 'capture');
    }
  }
});

test('C7 capture-check: after a reset an old check id is void; malformed input is a 400', async () => {
  const { store } = makeStore();
  const { checkId } = await store.apiCheck(KB);
  await store.reset();
  assert.match(kinds(store, 'RESET').at(-1).message, /1 checkout API check was discarded/);
  const r = store.captureCheck(checkId, 19900, 'AUTH-1');
  assert.deepEqual([r.decision, r.reason], ['void', 'UNKNOWN_CHECK']);
  for (const args of [['nope', 100, 'A-1'], [checkId, 0, 'A-1'], [checkId, -1, 'A-1'], [checkId, 19.9, 'A-1'], [checkId, 19900, 'bad id!'], [checkId, 19900], [checkId, 19900, '']]) {
    assert.throws(() => store.captureCheck(...args), (e) => e.status === 400, JSON.stringify(args));
  }
});

// ---------- H: HTTP and keys ----------

const ORIGIN = 'https://tripwire.example';
const storeIds = createStoreIds('test-signing-key');
const SID = await storeIds.issue();
const KEY = await storeIds.apiKeyFor(SID);

function harness({ limit, now } = {}) {
  const { store } = makeStore(now ? { now } : {});
  const getStore = () => ({ call: (m, a) => dispatch(store, m, a).catch((e) => ({ __error: { status: e.status || 500, message: e.message } })) });
  const config = { paypalClientId: 'x', paypalReady: true, aiReady: true, storeIds, limit };
  const send = (path, { method = 'POST', body, headers = {} } = {}) => route(new Request(`${ORIGIN}${path}`, {
    method, body: body === undefined ? undefined : JSON.stringify(body), headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
  }), { getStore, config });
  const api = (action, body, key = KEY) => send(`/api/v1/${action}`, { body, headers: { authorization: `Bearer ${key}` } });
  return { store, send, api };
}

test('H1 API key: per store, verifies, reveals no part of the console store id, and any changed character fails', async () => {
  assert.match(KEY, /^twk_[a-f0-9]{88}$/);
  // review F3: the key used to carry the store id's first 24 hex (96 of its 128 bits); now no 8-hex run of it appears
  for (let i = 0; i + 8 <= SID.length; i++) assert.ok(!KEY.includes(SID.slice(i, i + 8)), `key contains ${SID.slice(i, i + 8)}`);
  assert.equal(await storeIds.apiKeyFor(SID), KEY); // deterministic: the console shows the same key every time
  for (const pos of [5, 30, KEY.length - 1]) { // flipping a hex digit in the IV or in the ciphertext breaks it
    const flipped = KEY.slice(0, pos) + (KEY[pos] === '0' ? '1' : '0') + KEY.slice(pos + 1);
    assert.equal(await storeIds.storeForApiKey(flipped), null, `flip at ${pos}`);
  }
  assert.equal(await storeIds.storeForApiKey(KEY), SID);
  assert.equal(await createStoreIds('another-key').storeForApiKey(KEY), null);
  assert.equal(await storeIds.storeForApiKey(SID), null);
  assert.notEqual(await storeIds.apiKeyFor(await storeIds.issue()), KEY);
});

test('H2 HTTP: /api/v1 needs a Bearer key, is POST only, needs no Origin, and is not reachable from /api/store', async () => {
  const { send, api } = harness();
  assert.equal((await send('/api/v1/check', { body: KB })).status, 401);
  assert.equal((await api('check', KB, `twk_${'0'.repeat(88)}`)).status, 401);
  assert.equal((await send('/api/v1/check', { body: KB, headers: { authorization: 'Basic x' } })).status, 401);
  const pre = await send('/api/v1/check', { method: 'OPTIONS', headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' } });
  assert.equal(pre.status, 405); assert.equal(pre.headers.get('access-control-allow-origin'), null);
  assert.equal((await send('/api/v1/check', { method: 'GET', headers: { authorization: `Bearer ${KEY}` } })).status, 405);
  assert.equal((await api('nope', {})).status, 404);
  const ok = await api('check', KB);
  assert.equal(ok.status, 200); assert.equal((await ok.json()).decision, 'allow');
  assert.equal((await send(`/api/store/apiCheck?store=${SID}`, { body: KB, headers: { origin: ORIGIN } })).status, 404);
});

test('H3 HTTP: the console reads its API key; the key is refused as a store id, and a store id as a key', async () => {
  const { send, api } = harness();
  const r = await send(`/api/store/apikey?store=${SID}`, { method: 'GET' });
  assert.equal(r.status, 200); assert.equal((await r.json()).apiKey, KEY);
  assert.equal((await send(`/api/store/state?store=${KEY}`, { method: 'GET' })).status, 400);
  assert.equal((await send(`/api/store/state?store=${KEY.slice(4, 36)}`, { method: 'GET' })).status, 400); // no store id inside the key
  assert.equal((await api('check', KB, SID)).status, 401);
});

test('H4 HTTP: check then capture-check end to end, with the API rate limit separate from the console\'s', async () => {
  const now = clock();
  const { api } = harness({ now });
  const c = await (await api('check', KB)).json();
  assert.equal(c.decision, 'allow');
  const body = { checkId: c.checkId, amountCents: 19900, authorizationId: 'AUTH-1' };
  assert.equal((await (await api('capture-check', body)).json()).reason, 'COOLING');
  now.advance(21_000);
  assert.equal((await (await api('capture-check', body)).json()).decision, 'capture');
  const limited = harness({ limit: async (bucket) => bucket !== 'api' });
  assert.equal((await limited.api('check', KB)).status, 429);
  assert.equal((await limited.send(`/api/store/state?store=${SID}`, { method: 'GET' })).status, 200);
});

test('H5 HTTP: non-USD, fractional or string cents, long SKUs, a nameless new SKU and bad capture input are 400s', async () => {
  const { api } = harness();
  const err = async (action, body, re) => { const r = await api(action, body); assert.equal(r.status, 400, JSON.stringify(body)); assert.match((await r.json()).error, re); };
  await err('check', { ...KB, currency: 'EUR' }, /USD/);
  await err('check', { sku: 'KB-Q1PRO', priceCents: '129.90' }, /whole numbers of cents/);
  await err('check', { sku: 'KB-Q1PRO', priceCents: 129.9 }, /whole numbers of cents/);
  await err('check', { sku: 'A'.repeat(41), name: 'x', priceCents: 100 }, /SKU/);
  await err('check', { sku: 'MX-NONAME', priceCents: 5000 }, /needs a name/);
  await err('capture-check', { checkId: 'x', amountCents: 100 }, /checkId/);
  await err('capture-check', { checkId: 'chk_o1', amountCents: -1 }, /more than zero/);
  await err('capture-check', { checkId: 'chk_o1', amountCents: 100, currency: 'GBP' }, /USD/);
});

// ---------- R: regressions for the independent review of 8df1b1e (7 Nov). Each failed on that commit. ----------

test('R1 (F1) a cost sent by the API never releases a hold: AI-down UNVERIFIED, BELOW_COST and an AI hold all stay held', async () => {
  const down = makeStore({ reviewAi: fakeAi(() => null, { ok: false, error: 'AI down.' }) }).store;
  assert.equal((await down.apiCheck({ sku: 'MX-NEW-1', name: 'New gadget', priceCents: 4999 })).decision, 'hold');
  const again = await down.apiCheck({ sku: 'MX-NEW-1', priceCents: 4999, costCents: 1 });
  assert.deepEqual([again.decision, again.code], ['hold', 'HELD']); assert.equal(item(down, 'MX-NEW-1').status, 'held');

  const { store } = makeStore();
  assert.equal((await store.apiCheck({ sku: 'DRONE-MINI4', priceCents: 60900 })).code, 'HELD'); // below its $610 cost
  assert.equal((await store.apiCheck({ sku: 'DRONE-MINI4', priceCents: 60900, costCents: 1 })).code, 'HELD');
  assert.equal(item(store, 'DRONE-MINI4').costCents, 61000); // the API never overwrites a stored cost

  const ai = fakeAi(() => verdict('implausible', 29900, 34999, 'Far too cheap.'));
  const hp = makeStore({ reviewAi: ai }).store;
  assert.equal((await hp.apiCheck({ sku: 'HP-SONY-XM5', priceCents: 25999 })).code, 'HELD');
  assert.equal((await hp.apiCheck({ sku: 'HP-SONY-XM5', priceCents: 25999, costCents: 0 })).code, 'HELD');
  assert.equal(ai.calls.length, 1); // the same price is never re-asked
});

test('R2 (F1) a concurrent check carrying a cost cannot put an item live while the AI is still deciding', async () => {
  const ai = gatedAi(() => verdict('implausible', 29900, 34999, 'Far too cheap.'));
  const { store } = makeStore({ reviewAi: ai });
  const p = store.apiCheck({ sku: 'HP-SONY-XM5', priceCents: 25999 });
  await until(() => ai.gates.length === 1);
  const second = await store.apiCheck({ sku: 'HP-SONY-XM5', priceCents: 25999, costCents: 100 });
  assert.deepEqual([second.decision, second.code], ['hold', 'CHECKING']);
  ai.gates[0]();
  assert.equal((await p).code, 'HELD'); assert.equal(item(store, 'HP-SONY-XM5').status, 'held');
});

test('R3 (F2) a new SKU always gets the AI check: a consistent units slip ($1.10, cost $0.65) is not vouched for by its cost', async () => {
  const ai = fakeAi(() => verdict('implausible', 9999, 14999, 'A 24000mAh Anker power bank costs about $110.'));
  const { store } = makeStore({ reviewAi: ai });
  const r = await store.apiCheck({ sku: 'MX-ANKER-737', name: 'Anker 737 Power Bank', priceCents: 110, costCents: 65 });
  assert.equal(ai.calls.length, 1);
  assert.deepEqual([r.decision, r.code], ['hold', 'HELD']);
});

test('R4 (F4) the API never reprices an item the merchant is deciding on, even back to its old price', async () => {
  const { store } = makeStore();
  await store.applyPriceChanges([{ sku: 'TV-BRAVIA-65', price: '129.90' }], 'import'); // a slip, held in the console
  const r = await store.apiCheck({ sku: 'TV-BRAVIA-65', priceCents: 129900 });
  assert.deepEqual([r.decision, r.code], ['hold', 'HELD']);
  const tv = item(store, 'TV-BRAVIA-65');
  assert.equal(tv.status, 'held'); assert.equal(tv.priceCents, 12990);
  assert.equal(kinds(store, 'MERCHANT_FIXED').length + kinds(store, 'PRICE_LIVE').length, 0);
});

test('R5 (F5) one check covers one PayPal authorization: another is told to void, and authorizationId is required', async () => {
  const { store, now } = makeStore();
  const { checkId } = await store.apiCheck(KB);
  assert.equal(store.captureCheck(checkId, 19900, 'AUTH-A').reason, 'COOLING'); // binds AUTH-A
  now.advance(21_000);
  assert.deepEqual([store.captureCheck(checkId, 19900, 'AUTH-B').decision, store.captureCheck(checkId, 19900, 'AUTH-B').reason], ['void', 'OTHER_AUTHORIZATION']);
  assert.equal(store.captureCheck(checkId, 19900, 'AUTH-A').decision, 'capture');
  for (let i = 0; i < 10; i++) assert.equal(store.captureCheck(checkId, 19900, `AUTH-${i}`).decision, 'void');
  assert.equal(kinds(store, 'API_CAPTURE').length, 1);
  assert.throws(() => store.captureCheck(checkId, 19900), (e) => e.status === 400);
});

test('R6 (F6) negative cents are refused by the API, and a negative console price cannot inflate loss prevented', async () => {
  const { store } = makeStore();
  await store.applyPriceChanges([{ sku: 'KB-Q1PRO', price: '-100' }], 'import'); // held as NON_POSITIVE
  assert.equal((await store.botCheckout('KB-Q1PRO')).ok, false);
  assert.equal(store.summary().lossPreventedCents, 19900); // the item's $199 at most, not $199 + $100
});

test('R7 (F7) optional fields may be null, and the Bearer scheme is case-insensitive', async () => {
  const { send } = harness();
  const r = await send('/api/v1/check', { body: { ...KB, currency: null }, headers: { authorization: `bearer ${KEY}` } });
  assert.equal(r.status, 200); assert.equal((await r.json()).decision, 'allow');
});

test('R8 (F8) the waiting badge clears as soon as the merchant decides, before the merchant\'s server polls again', async () => {
  const { store, now } = makeStore();
  const { checkId } = await store.apiCheck({ sku: 'TV-BRAVIA-65', priceCents: 129900 });
  await store.apiCheck({ sku: 'TV-BRAVIA-65', priceCents: 12990 });
  now.advance(21_000);
  assert.equal(store.captureCheck(checkId, 129900, 'AUTH-1').decision, 'wait');
  assert.equal(item(store, 'TV-BRAVIA-65').apiWaiting, 1);
  store.resolveHold('TV-BRAVIA-65', 'fix');
  assert.equal(item(store, 'TV-BRAVIA-65').apiWaiting, 0);
});

// ---------- V: regressions for the verification of d854da3 (7 Nov). Each failed on that commit. ----------

test('V1 (X1, X2) a cost sent by the API is never stored, so it can neither vouch for a later console price nor stick', async () => {
  const { store } = makeStore({ reviewAi: fakeAi(() => null, { ok: false, error: 'AI down.' }) });
  assert.equal((await store.apiCheck({ sku: 'MX-ANKER-737', name: 'Anker 737', priceCents: 110, costCents: 65 })).decision, 'hold');
  assert.equal(item(store, 'MX-ANKER-737').costCents, null);
  await store.applyPriceChanges([{ sku: 'MX-ANKER-737', price: '1.15' }], 'edit'); // the merchant edits it in the console
  assert.equal(item(store, 'MX-ANKER-737').status, 'held'); // still needs the (down) AI: no stored cost vouches for it
  const lego = makeStore().store;
  await lego.apiCheck({ sku: 'LEGO-75192', priceCents: 79999, costCents: 99_999_999 });
  assert.equal(item(lego, 'LEGO-75192').costCents, null);
});

test('V2 (X4) an item stuck in checking (its AI check lost to a restart) is held after checkingStuckMs, not CHECKING forever', async () => {
  const { store, now } = makeStore();
  store.sql.exec("UPDATE sku SET status = 'checking', updated_at = ? WHERE sku = 'KB-Q1PRO'", now());
  assert.equal((await store.apiCheck(KB)).code, 'CHECKING'); // a fresh check is still running
  now.advance(300_001);
  const r = await store.apiCheck(KB);
  // the lost check is marked unverified, then retried at once: $199.00 is the item's own last good price, so it sells
  assert.ok(kinds(store, 'PRICE_HELD').some((e) => /AI check never finished/.test(e.message)));
  assert.deepEqual([r.decision, r.code], ['allow', 'ALLOWED']);
  assert.equal(item(store, 'KB-Q1PRO').status, 'live');
  // a lost check on a price that still needs the AI, with the AI down, stays held (fail closed), never CHECKING forever
  const down = makeStore({ reviewAi: fakeAi(() => null, { ok: false, error: 'AI check timed out.' }) });
  down.store.sql.exec("UPDATE sku SET status = 'checking', price_cents = 15000, updated_at = ? WHERE sku = 'HP-SONY-XM5'", down.now()); // 57% off, no cost
  down.now.advance(300_001);
  const h = await down.store.apiCheck({ sku: 'HP-SONY-XM5', priceCents: 15000 });
  assert.deepEqual([h.decision, h.code], ['hold', 'HELD']);
  const xm5 = item(down.store, 'HP-SONY-XM5');
  assert.equal(xm5.status, 'held'); assert.ok(xm5.reasons.some((x) => x.code === 'UNVERIFIED'));
});

test('V3 (P1) a second authorization on one check is told void, and the merchant sees why on the timeline', async () => {
  const { store } = makeStore();
  const { checkId } = await store.apiCheck(KB);
  store.captureCheck(checkId, 19900, 'AUTH-REAL');
  assert.equal(store.captureCheck(checkId, 19900, 'AUTH-OTHER').reason, 'OTHER_AUTHORIZATION');
  const ev = kinds(store, 'API_VOID');
  assert.equal(ev.length, 1); assert.equal(ev[0].paypalId, 'AUTH-OTHER'); assert.match(ev[0].message, /already covers authorization AUTH-REAL/);
});

test('V4 (X5) rapid back-and-forth price changes cannot drag the typical price down and walk a price past the AI', async () => {
  const ai = fakeAi(() => null); // silent: anything that needs the AI stays held
  const { store, now } = makeStore({ reviewAi: ai });
  const step = async (priceCents) => { now.advance(16_000); return store.apiCheck({ sku: 'LEGO-75192', priceCents }); }; // spaced under the breaker
  assert.equal((await step(69000)).decision, 'allow'); // 18.8% below $849.99: under the AI threshold
  for (let i = 0; i < 12; i++) await step(i % 2 ? 69000 : 69001); // pad the history at the new level
  assert.equal(item(store, 'LEGO-75192').typicalCents, 84999); // one history row per day: the typical price holds
  const r = await step(56000); // another 18.8% step: 34% below the typical price, so the AI must vouch
  assert.deepEqual([r.decision, r.code], ['hold', 'HELD']);
  assert.equal(ai.calls.length, 1);
});

// ---------- S: the console's money tiles count the merchant's own checkout (browser check, 7 Nov) ----------

test('S1 summary counts sales cleared, voided and waiting on the merchant\'s own checkout, apart from Tripwire\'s orders', async () => {
  const { store, now } = makeStore();
  const a = await store.apiCheck(KB);                                        // will be cleared: $199.00
  const b = await store.apiCheck({ sku: 'KETTLE-STAGG', priceCents: 16500 }); // will be voided: $165.00
  const c = await store.apiCheck({ sku: 'TV-BRAVIA-65', priceCents: 129900 }); // will wait on a held price
  now.advance(21_000);
  assert.equal(store.captureCheck(a.checkId, 19900, 'AUTH-A').decision, 'capture');
  await store.apiCheck({ sku: 'KETTLE-STAGG', priceCents: 14900 });
  assert.equal(store.captureCheck(b.checkId, 16500, 'AUTH-B').decision, 'void');
  await store.apiCheck({ sku: 'TV-BRAVIA-65', priceCents: 12990 });
  assert.equal(store.captureCheck(c.checkId, 129900, 'AUTH-C').decision, 'wait');
  const s = store.summary();
  assert.deepEqual(s.api, { capture: { n: 1, cents: 19900 }, void: { n: 1, cents: 16500 }, waiting: { n: 1, cents: 129900 } });
  assert.deepEqual(s.captured, { n: 0, cents: 0 }); // Tripwire's own orders stay separate
});

test('H-Q /api/v1/check passes quantity through; a string quantity is a 400', async () => {
  const ids = createStoreIds('test-signing-key-q');
  const sid = await ids.issue(); const key = await ids.apiKeyFor(sid);
  const { store } = makeStore();
  const getStore = () => ({ call: (m, a) => dispatch(store, m, a).catch((e) => ({ __error: { status: e.status || 500, message: e.message } })) });
  const post = (body) => route(new Request('https://t.example/api/v1/check', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` } }), { getStore, config: { storeIds: ids } });
  const r = await (await post({ sku: 'KB-Q1PRO', priceCents: 19900, quantity: 3 })).json();
  assert.deepEqual([r.decision, r.quantity, r.amountCents], ['allow', 3, 59700]);
  assert.equal((await post({ sku: 'KB-Q1PRO', priceCents: 19900, quantity: '3' })).status, 400);
});
