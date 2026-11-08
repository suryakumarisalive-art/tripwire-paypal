// "Hold the capture, not the checkout": a soft signal (a steep drop, or an AI "suspicious") keeps the item selling, but
// every order is only authorized and its capture waits for the merchant's one click. Hard signals still refuse checkout.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeStore, fakeAi, fakePayPal, verdict, clock, sqlAdapter, FAKE_AUTH_EXPIRES } from './helpers.mjs';
import { StoreCore } from '../src/store.mjs';
import { combine } from '../src/ai.mjs';
import { checkPrice } from '../src/rules.mjs';

const item = (store, sku) => store.catalog().find((c) => c.sku === sku);
const calls = (paypal, name) => paypal.calls.filter((c) => c[0] === name).length;
const kinds = (store, kind) => store.timeline().filter((e) => e.kind === kind);
// Dyson V15: typical $749.99. $349.99 is 53% below it, so STEEP_DROP fires (a soft signal); no decimal or cost rule.
const DEEP_SALE = [{ sku: 'VAC-DYSON-V15', price: '349.99' }];
const okAi = () => fakeAi(() => verdict('ok', 39900, 74999, 'Dyson V15 often drops to about $400-$500 on Black Friday.'));

test('combine: soft-only signals with an AI answer go to review; any hard signal, or no AI answer, is held', () => {
  const steep = checkPrice({ newCents: 34999, oldCents: 74999, medianCents: 74999 });
  assert.deepEqual(steep.holds.map((h) => h.code), ['STEEP_DROP']);
  const v = (verdict, low) => ({ verdict, marketLowCents: low, marketHighCents: low * 2, explanation: 'x', likelyCause: 'unknown' });
  assert.equal(combine(steep, { ok: true, verdict: v('ok', 39900) }, 34999).status, 'review');
  assert.equal(combine(steep, { ok: true, verdict: v('suspicious', 70000) }, 34999).status, 'review');
  assert.equal(combine(steep, { ok: true, verdict: v('implausible', 70000) }, 34999).status, 'held', 'implausible is hard');
  assert.equal(combine(steep, { ok: false, error: 'down' }, 34999).status, 'held', 'no AI answer: fail closed');
  assert.equal(combine(steep, null, 34999).status, 'held');
  const slip = checkPrice({ newCents: 7499, oldCents: 74999, medianCents: 74999 }); // DECIMAL_SHIFT + STEEP_DROP
  assert.equal(combine(slip, { ok: true, verdict: v('ok', 100) }, 7499).status, 'held', 'a slipped decimal is never review');
  const below = checkPrice({ newCents: 34999, oldCents: 74999, medianCents: 74999, costCents: 40000 }); // BELOW_COST + STEEP
  assert.equal(combine(below, { ok: true, verdict: v('ok', 100) }, 34999).status, 'held');
});

test('a deep genuine sale keeps selling: orders are authorized, never captured, until the merchant confirms', async () => {
  const now = clock();
  const { store, paypal } = makeStore({ reviewAi: okAi(), now });
  const res = await store.applyPriceChanges(DEEP_SALE);
  assert.equal(res[0].status, 'review');
  const v15 = item(store, 'VAC-DYSON-V15');
  assert.equal(v15.status, 'review');
  assert.equal(v15.lastGoodCents, 74999, 'a review price is not a good price yet');
  assert.ok(v15.reasons.some((r) => r.code === 'STEEP_DROP'));
  assert.equal(kinds(store, 'PRICE_REVIEW').length, 1);
  assert.equal(store.publicCatalog().find((p) => p.sku === 'VAC-DYSON-V15').available, true, 'the storefront still sells it');

  for (let i = 0; i < 3; i++) assert.equal((await store.botCheckout('VAC-DYSON-V15')).ok, true);
  assert.equal(calls(paypal, 'createOrder'), 3);
  now.advance(21_000);
  await store.settle();
  assert.equal(calls(paypal, 'captureAuthorization'), 0, 'nothing is captured while the price is under review');
  assert.equal(item(store, 'VAC-DYSON-V15').awaiting, 3);
  assert.match(store.orders()[0].note, /under your review/);

  const out = await store.decideHold('VAC-DYSON-V15', 'confirm'); // the one click
  assert.equal(out.captured, 3);
  assert.equal(calls(paypal, 'captureAuthorization'), 3);
  assert.equal(store.orders().filter((o) => o.status === 'captured').length, 3);
  const after = item(store, 'VAC-DYSON-V15');
  assert.equal(after.status, 'live'); assert.equal(after.lastGoodCents, 34999);
  assert.match(kinds(store, 'MERCHANT_CONFIRMED')[0].message, /Capturing 3 waiting orders/);
});

test('fixing a price under review restores it and voids every order taken at it, cooling or waiting', async () => {
  const now = clock();
  const { store, paypal } = makeStore({ reviewAi: okAi(), now });
  await store.applyPriceChanges(DEEP_SALE);
  await store.botCheckout('VAC-DYSON-V15'); await store.botCheckout('VAC-DYSON-V15');
  now.advance(21_000); await store.settle(); // these two now wait for the merchant
  await store.botCheckout('VAC-DYSON-V15'); // this one is still cooling
  const out = await store.decideHold('VAC-DYSON-V15', 'fix');
  assert.equal(out.voided, 3);
  assert.equal(calls(paypal, 'voidAuthorization'), 3);
  assert.equal(calls(paypal, 'captureAuthorization'), 0);
  const v15 = item(store, 'VAC-DYSON-V15');
  assert.equal(v15.status, 'live'); assert.equal(v15.priceCents, 74999);
  now.advance(21_000); await store.settle();
  assert.equal(calls(paypal, 'captureAuthorization'), 0, 'nothing at the mistaken price is ever captured');
});

test('an item under review takes at most reviewMax orders, then refuses before PayPal', async () => {
  const now = clock();
  const { store, paypal } = makeStore({ reviewAi: okAi(), now, config: { reviewMax: 3, maxPerWindow: 100 } });
  await store.applyPriceChanges(DEEP_SALE);
  for (let i = 0; i < 3; i++) { assert.equal((await store.botCheckout('VAC-DYSON-V15')).ok, true); now.advance(1000); }
  const fourth = await store.botCheckout('VAC-DYSON-V15');
  assert.deepEqual([fourth.ok, fourth.code], [false, 'REVIEW_FULL']);
  assert.equal(calls(paypal, 'createOrder'), 3, 'the refused checkout never reached PayPal');
  assert.equal(item(store, 'VAC-DYSON-V15').status, 'review', 'the item stays under review for the merchant');
});

test('a bot rush on an item under review still trips the breaker, and resuming returns it to review, not live', async () => {
  const now = clock();
  const { store, paypal } = makeStore({ reviewAi: okAi(), now });
  await store.applyPriceChanges(DEEP_SALE);
  const swarm = await store.swarm('VAC-DYSON-V15', 25);
  assert.deepEqual([swarm.authorized, swarm.refused], [5, 20]);
  const tripped = item(store, 'VAC-DYSON-V15');
  assert.equal(tripped.status, 'tripped');
  assert.deepEqual(tripped.reasons.map((r) => r.code), ['VELOCITY', 'STEEP_DROP']);
  store.resume('VAC-DYSON-V15');
  const back = item(store, 'VAC-DYSON-V15');
  assert.equal(back.status, 'review'); assert.deepEqual(back.reasons.map((r) => r.code), ['STEEP_DROP']);
  now.advance(21_000); await store.settle();
  assert.equal(calls(paypal, 'captureAuthorization'), 0, 'resuming re-arms the breaker; it does not vouch for the price');
});

test('a steep drop with the AI down, or called implausible, is still refused at checkout', async () => {
  const down = makeStore({ reviewAi: fakeAi(() => null, { ok: false, error: 'AI check timed out.' }) });
  await down.store.applyPriceChanges(DEEP_SALE);
  assert.equal(item(down.store, 'VAC-DYSON-V15').status, 'held');
  assert.equal((await down.store.botCheckout('VAC-DYSON-V15')).code, 'HELD');
  const no = makeStore({ reviewAi: fakeAi(() => verdict('implausible', 60000, 80000, 'Far too cheap for a V15.')) });
  await no.store.applyPriceChanges(DEEP_SALE);
  assert.equal(item(no.store, 'VAC-DYSON-V15').status, 'held');
  assert.equal(calls(down.paypal, 'createOrder') + calls(no.paypal, 'createOrder'), 0);
});

test('a real buyer can pay for an item under review; the money is only reserved', async () => {
  const now = clock();
  const { store, paypal } = makeStore({ reviewAi: okAi(), now });
  await store.applyPriceChanges(DEEP_SALE);
  const c = await store.buyerCreateOrder('VAC-DYSON-V15', 'paypal');
  assert.equal(c.ok, true);
  const a = await store.buyerApprove(c.paypalOrderId);
  assert.equal(a.ok, true); assert.ok(a.authorizationId);
  now.advance(21_000); await store.settle();
  assert.equal(calls(paypal, 'captureAuthorization'), 0);
  assert.equal(store.orders()[0].status, 'awaiting_merchant');
});

test('orders show the capture deadline: PayPal honor period (3 days) and the authorization expiry', async () => {
  const now = clock();
  const { store } = makeStore({ reviewAi: okAi(), now });
  await store.applyPriceChanges(DEEP_SALE);
  await store.botCheckout('VAC-DYSON-V15');
  const o = store.orders()[0];
  assert.equal(o.authorizedAt, now());
  assert.equal(o.honorUntil, now() + 3 * 86_400_000);
  assert.equal(o.expiresAt, FAKE_AUTH_EXPIRES);
});

test('checkout API: a price under review is allowed (REVIEW); capture-check waits, then captures on confirm or voids on fix', async () => {
  const now = clock();
  const { store } = makeStore({ reviewAi: okAi(), now });
  await store.applyPriceChanges(DEEP_SALE);
  const other = await store.apiCheck({ sku: 'VAC-DYSON-V15', priceCents: 29999 });
  assert.deepEqual([other.decision, other.code], ['hold', 'UNDER_REVIEW'], 'the API never reprices an item under review');
  const a = await store.apiCheck({ sku: 'VAC-DYSON-V15', priceCents: 34999 });
  assert.deepEqual([a.decision, a.code], ['allow', 'REVIEW']);
  const b = await store.apiCheck({ sku: 'VAC-DYSON-V15', priceCents: 34999 });
  now.advance(21_000);
  assert.deepEqual([store.captureCheck(a.checkId, 34999, 'AUTH-A').decision, store.captureCheck(a.checkId, 34999, 'AUTH-A').reason], ['wait', 'REVIEW']);
  assert.equal(store.captureCheck(b.checkId, 34999, 'AUTH-B').decision, 'wait');
  await store.decideHold('VAC-DYSON-V15', 'confirm');
  assert.equal(store.captureCheck(a.checkId, 34999, 'AUTH-A').decision, 'capture');
  // a second review, then a fix: the merchant's own checkout is told to void
  await store.applyPriceChanges([{ sku: 'VAC-DYSON-V15', price: '149.99' }]);
  assert.equal(item(store, 'VAC-DYSON-V15').status, 'review');
  const c = await store.apiCheck({ sku: 'VAC-DYSON-V15', priceCents: 14999 });
  await store.decideHold('VAC-DYSON-V15', 'fix');
  now.advance(21_000);
  const v = store.captureCheck(c.checkId, 14999, 'AUTH-C');
  assert.deepEqual([v.decision, v.reason], ['void', 'PRICE_CHANGED']);
});

test('a store created before review existed is migrated: rows kept, and review becomes a valid status', () => {
  const sql = sqlAdapter();
  // the sku table exactly as the first deploys created it (no 'review' in the CHECK), with one item and the old meta
  sql.exec(`CREATE TABLE sku (
     sku TEXT PRIMARY KEY, name TEXT NOT NULL, category TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '',
     price_cents INTEGER NOT NULL, last_good_cents INTEGER, cost_cents INTEGER,
     status TEXT NOT NULL CHECK (status IN ('live','checking','held','tripped')),
     reasons TEXT NOT NULL DEFAULT '[]', ai TEXT, version INTEGER NOT NULL DEFAULT 1,
     window_start INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL)`);
  sql.exec('ALTER TABLE sku ADD COLUMN restore_cents INTEGER');
  sql.exec("INSERT INTO sku (sku, name, price_cents, last_good_cents, status, updated_at, restore_cents) VALUES ('OLD-1', 'Old item', 1000, 1000, 'live', 1, 900)");
  sql.exec('CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)');
  sql.exec("INSERT INTO meta (k, v) VALUES ('seeded', '1')");
  assert.throws(() => sql.exec("UPDATE sku SET status = 'review' WHERE sku = 'OLD-1'"), /CHECK/);
  const store = new StoreCore({ sql, paypal: null, reviewAi: async () => ({ ok: false, verdicts: new Map() }), now: clock() });
  store.init();
  const old = item(store, 'OLD-1');
  assert.deepEqual([old.name, old.priceCents, old.restoreCents], ['Old item', 1000, 900]);
  sql.exec("UPDATE sku SET status = 'review' WHERE sku = 'OLD-1'");
  assert.equal(item(store, 'OLD-1').status, 'review');
  store.init(); // a second start does not rebuild again or lose rows
  assert.equal(item(store, 'OLD-1').status, 'review');
});

// ---------- regressions from the independent review of 7 Nov ----------
const suspiciousAi = () => fakeAi(() => verdict('suspicious', 40000, 50000, 'Far below the usual $400-$500.'));

test('R-HIGH: a same-price re-import with a cost cannot release a price under review; its orders and checks stay uncaptured', async () => {
  const now = clock();
  const ai = suspiciousAi();
  const { store, paypal } = makeStore({ reviewAi: ai, now });
  await store.applyPriceChanges([{ sku: 'NEW-X', name: 'New gadget', price: '49.99' }]);
  assert.equal(item(store, 'NEW-X').status, 'review');
  await store.botCheckout('NEW-X'); await store.botCheckout('NEW-X');
  const chk = await store.apiCheck({ sku: 'NEW-X', priceCents: 4999 });
  assert.equal(chk.code, 'REVIEW');
  const res = await store.applyPriceChanges([{ sku: 'NEW-X', price: '49.99', cost: '30.00' }]); // a supplier cost sheet
  assert.equal(res[0].status, 'review'); assert.equal(item(store, 'NEW-X').costCents, 3000, 'the cost is still stored');
  assert.equal(ai.calls.length, 1, 'the AI is not asked again about the same price');
  now.advance(21_000); await store.settle();
  assert.equal(calls(paypal, 'captureAuthorization'), 0);
  assert.equal(store.captureCheck(chk.checkId, 4999, 'AUTH-1').decision, 'wait');
  // a cost above the price makes it a hard hold (tightening is allowed)
  await store.applyPriceChanges([{ sku: 'NEW-X', price: '49.99', cost: '60.00' }]);
  assert.equal(item(store, 'NEW-X').status, 'held');
  assert.ok(item(store, 'NEW-X').reasons.some((r) => r.code === 'BELOW_COST'));
});

test('R-HIGH: an item tripped while under review is not released by re-importing the same price', async () => {
  const ai = okAi();
  const { store } = makeStore({ reviewAi: ai });
  await store.applyPriceChanges(DEEP_SALE);
  await store.swarm('VAC-DYSON-V15', 25);
  assert.equal(item(store, 'VAC-DYSON-V15').status, 'tripped');
  await store.applyPriceChanges(DEEP_SALE);
  assert.equal(item(store, 'VAC-DYSON-V15').status, 'tripped');
  assert.equal(ai.calls.length, 1);
});

test('R-HIGH: an order taken under review is never captured by settlement, even if the item is live at that price', async () => {
  const now = clock();
  const { store, paypal } = makeStore({ reviewAi: okAi(), now });
  await store.applyPriceChanges(DEEP_SALE);
  await store.botCheckout('VAC-DYSON-V15');
  store.sql.exec("UPDATE sku SET status = 'live' WHERE sku = 'VAC-DYSON-V15'"); // a route around the confirm, forced
  now.advance(21_000); await store.settle();
  assert.equal(calls(paypal, 'captureAuthorization'), 0);
  assert.equal(store.orders()[0].status, 'awaiting_merchant');
});

test('R-HIGH: a checkout API check taken under review never answers capture without the confirm, even if the item is live', async () => {
  const now = clock();
  const { store } = makeStore({ reviewAi: okAi(), now });
  await store.applyPriceChanges(DEEP_SALE);
  const chk = await store.apiCheck({ sku: 'VAC-DYSON-V15', priceCents: 34999 });
  store.sql.exec("UPDATE sku SET status = 'live' WHERE sku = 'VAC-DYSON-V15'"); // a route around the confirm, forced
  now.advance(21_000);
  assert.deepEqual([store.captureCheck(chk.checkId, 34999, 'AUTH-Z').decision, store.captureCheck(chk.checkId, 34999, 'AUTH-Z').reason], ['wait', 'REVIEW']);
});

test('R-M1: confirm captures only the orders that waited on the review, not a bot rush the breaker stopped', async () => {
  const now = clock();
  const { store, paypal } = makeStore({ reviewAi: okAi(), now });
  await store.applyPriceChanges(DEEP_SALE);
  await store.swarm('VAC-DYSON-V15', 25); // 5 authorized, then the breaker trips
  now.advance(21_000); await store.settle(); // they wait: "its breaker tripped"
  store.resume('VAC-DYSON-V15');
  now.advance(61_000);
  await store.botCheckout('VAC-DYSON-V15'); // one ordinary buyer under review
  now.advance(21_000); await store.settle();
  const out = await store.decideHold('VAC-DYSON-V15', 'confirm');
  assert.equal(out.captured, 1, 'only the review order is captured');
  assert.equal(calls(paypal, 'captureAuthorization'), 1);
  assert.equal(item(store, 'VAC-DYSON-V15').awaiting, 5, 'the rush still waits for an explicit honor or void');
  assert.equal((await store.decideOrders('VAC-DYSON-V15', 'void')).count, 5);
});

test('R-M2: the review cap counts from when the review began, through a trip and a resume', async () => {
  const now = clock();
  const { store, paypal } = makeStore({ reviewAi: okAi(), now }); // reviewMax 10, breaker 5 per minute
  await store.applyPriceChanges(DEEP_SALE);
  await store.swarm('VAC-DYSON-V15', 25); // 5 allowed, trip
  for (let round = 0; round < 3; round++) {
    now.advance(61_000); // time passes before each resume, so a cap counted from the resume would reset
    if (item(store, 'VAC-DYSON-V15').status === 'tripped') store.resume('VAC-DYSON-V15');
    await store.swarm('VAC-DYSON-V15', 25);
  }
  assert.equal(calls(paypal, 'createOrder'), 10, 'never more than reviewMax orders at an unconfirmed price');
});

test('R-M3: a decision on a price that changed since the merchant looked is refused, and nothing moves', async () => {
  const { store, paypal } = makeStore({ reviewAi: okAi() });
  await store.applyPriceChanges(DEEP_SALE);
  await store.botCheckout('VAC-DYSON-V15');
  await assert.rejects(store.decideHold('VAC-DYSON-V15', 'confirm', 29999), (e) => e.status === 409 && /changed to \$349\.99/.test(e.message));
  assert.equal(item(store, 'VAC-DYSON-V15').status, 'review');
  assert.equal(calls(paypal, 'captureAuthorization') + calls(paypal, 'voidAuthorization'), 0);
  assert.equal((await store.decideHold('VAC-DYSON-V15', 'confirm', 34999)).status, 'live');
});

test('R-M4: a slipped decimal off the 30-day typical price is caught after a confirmed sale moved the last good price', async () => {
  const { store } = makeStore({ reviewAi: okAi() });
  await store.applyPriceChanges(DEEP_SALE);
  await store.decideHold('VAC-DYSON-V15', 'confirm'); // last good $349.99, typical still $749.99
  await store.applyPriceChanges([{ sku: 'VAC-DYSON-V15', price: '74.99' }]);
  const v15 = item(store, 'VAC-DYSON-V15');
  assert.equal(v15.status, 'held');
  assert.ok(v15.reasons.some((r) => r.code === 'DECIMAL_SHIFT'));
});

test('R-M5: an order still at PayPal when the merchant fixes the price is voided when its authorization lands', async () => {
  const paypal = fakePayPal({ delayMs: 15 });
  const { store } = makeStore({ reviewAi: okAi(), paypal });
  await store.applyPriceChanges(DEEP_SALE);
  const pending = store.botCheckout('VAC-DYSON-V15'); // in flight at PayPal
  await store.decideHold('VAC-DYSON-V15', 'fix');
  const r = await pending;
  assert.equal(r.voided, true);
  assert.equal(store.orders()[0].status, 'voided');
  assert.equal(calls(paypal, 'voidAuthorization'), 1);
});

test('R-M5b: an order in flight when the merchant confirms is captured normally after cooling', async () => {
  const now = clock();
  const paypal = fakePayPal({ delayMs: 15 });
  const { store } = makeStore({ reviewAi: okAi(), paypal, now });
  await store.applyPriceChanges(DEEP_SALE);
  const pending = store.botCheckout('VAC-DYSON-V15');
  await store.decideHold('VAC-DYSON-V15', 'confirm');
  await pending;
  now.advance(21_000); await store.settle();
  assert.equal(store.orders()[0].status, 'captured');
});

test('R-M6: decideHold reports what PayPal did: a failed capture is not counted as captured', async () => {
  const now = clock();
  const { store } = makeStore({ reviewAi: okAi(), paypal: fakePayPal({ failCapture: true }), now });
  await store.applyPriceChanges(DEEP_SALE);
  await store.botCheckout('VAC-DYSON-V15'); await store.botCheckout('VAC-DYSON-V15');
  now.advance(21_000); await store.settle();
  const out = await store.decideHold('VAC-DYSON-V15', 'confirm');
  assert.deepEqual([out.captured, out.failed], [0, 2]);
  assert.ok(store.orders().every((o) => o.status === 'awaiting_merchant'));
});

test('fix leaves orders at any other price alone', async () => {
  const now = clock();
  const { store, paypal } = makeStore({ reviewAi: okAi(), now });
  await store.botCheckout('VAC-DYSON-V15'); // a normal $749.99 order, cooling
  await store.applyPriceChanges(DEEP_SALE); // now under review at $349.99
  now.advance(21_000); await store.settle(); // the $749.99 order waits: "the price is now $349.99"
  await store.decideHold('VAC-DYSON-V15', 'fix'); // back to $749.99
  assert.equal(calls(paypal, 'voidAuthorization'), 0, 'the $749.99 order was not at the mistaken price');
  assert.equal(store.orders()[0].status, 'awaiting_merchant');
});

test('R2-M5: after Confirm or Fix, the merchant\'s own checkout gets a first, documented answer (not a repeat)', async () => {
  const now = clock();
  const { store } = makeStore({ reviewAi: okAi(), now });
  await store.applyPriceChanges(DEEP_SALE);
  const a = await store.apiCheck({ sku: 'VAC-DYSON-V15', priceCents: 34999 });
  await store.decideHold('VAC-DYSON-V15', 'confirm', 34999);
  const early = store.captureCheck(a.checkId, 34999, 'AUTH-A');
  assert.deepEqual([early.decision, early.reason], ['wait', 'COOLING'], 'a confirmed check still cools, like orders do');
  now.advance(21_000);
  const c = store.captureCheck(a.checkId, 34999, 'AUTH-A');
  assert.deepEqual([c.decision, c.reason, c.repeat], ['capture', 'LIVE', false]);
  assert.equal(kinds(store, 'API_CAPTURE').length, 1);
  await store.applyPriceChanges([{ sku: 'VAC-DYSON-V15', price: '149.99' }]); // a new review
  const b = await store.apiCheck({ sku: 'VAC-DYSON-V15', priceCents: 14999 });
  await store.decideHold('VAC-DYSON-V15', 'fix', 14999);
  const v = store.captureCheck(b.checkId, 14999, 'AUTH-B');
  assert.deepEqual([v.decision, v.reason, v.repeat], ['void', 'PRICE_CHANGED', false]);
  assert.equal(kinds(store, 'API_VOID').length, 1);
});

test('R2-L1: a check taken under review is not stuck when the merchant reprices the item instead of deciding', async () => {
  const now = clock();
  const { store } = makeStore({ reviewAi: fakeAi((r) => (r.newCents === 4999 ? verdict('suspicious', 40000, 50000, 'Far below.') : verdict('ok', 5000, 6000, 'Fine.'))), now });
  await store.applyPriceChanges([{ sku: 'NEW-Y', name: 'New gadget', price: '49.99' }]);
  const chk = await store.apiCheck({ sku: 'NEW-Y', priceCents: 4999 });
  await store.applyPriceChanges([{ sku: 'NEW-Y', price: '55.00' }]); // the merchant reprices: the review is over
  now.advance(21_000);
  const r = store.captureCheck(chk.checkId, 4999, 'AUTH-Y');
  assert.deepEqual([r.decision, r.reason], ['void', 'PRICE_CHANGED']);
});

test('V-L1: a check at a price the merchant fixed is never left waiting, even if that price comes back and goes live', async () => {
  const now = clock();
  const ai = fakeAi((r) => (r.newCents === 34999 && ai.calls.length > 1 ? verdict('ok', 30000, 40000, 'A real sale.') : verdict('ok', 39900, 74999, 'Deep, but possible.')));
  const { store } = makeStore({ reviewAi: ai, now });
  await store.applyPriceChanges(DEEP_SALE); // review
  const chk = await store.apiCheck({ sku: 'VAC-DYSON-V15', priceCents: 34999 });
  await store.decideHold('VAC-DYSON-V15', 'fix', 34999); // back to $749.99; the check is not polled
  store.sql.exec("UPDATE sku SET status = 'live', price_cents = 34999, last_good_cents = 34999 WHERE sku = 'VAC-DYSON-V15'"); // the same price comes back live
  now.advance(21_000);
  assert.notEqual(store.captureCheck(chk.checkId, 34999, 'AUTH-Q').reason, 'REVIEW', 'not stuck waiting on a review that is over');
});

test('R2-M4: Honor never captures an order waiting on a price review; both actions can be scoped to one kind of wait', async () => {
  const now = clock();
  const { store, paypal } = makeStore({ reviewAi: okAi(), now });
  await store.applyPriceChanges(DEEP_SALE);
  await store.swarm('VAC-DYSON-V15', 25); // 5 rush orders, then the trip
  now.advance(21_000); await store.settle();
  store.resume('VAC-DYSON-V15');
  now.advance(61_000);
  await store.botCheckout('VAC-DYSON-V15'); // one buyer under review
  now.advance(21_000); await store.settle();
  const waits = store.orders().filter((o) => o.status === 'awaiting_merchant').map((o) => o.waitReason).sort();
  assert.deepEqual(waits, ['review', 'tripped', 'tripped', 'tripped', 'tripped', 'tripped']);
  const voided = await store.decideOrders('VAC-DYSON-V15', 'void', 'tripped'); // void only the rush
  assert.equal(voided.count, 5);
  await assert.rejects(store.decideOrders('VAC-DYSON-V15', 'honor'), (e) => e.status === 409 && /confirm the price/.test(e.message));
  assert.equal(calls(paypal, 'captureAuthorization'), 0, 'the review buyer is captured only by confirming the price');
  assert.equal((await store.decideHold('VAC-DYSON-V15', 'confirm', 34999)).captured, 1);
});

test('the migration rebuilds once and records the schema version', () => {
  const sql = sqlAdapter();
  const execs = []; const exec = sql.exec.bind(sql); sql.exec = (q, ...b) => { execs.push(q); return exec(q, ...b); };
  const store = new StoreCore({ sql, paypal: null, reviewAi: async () => ({ ok: false, verdicts: new Map() }), now: clock() });
  store.init();
  assert.equal(sql.exec("SELECT v FROM meta WHERE k = 'schema'").one().v, '2');
  const rebuilds = () => execs.filter((q) => /sku_v2/.test(q)).length;
  const first = rebuilds();
  store.init();
  assert.equal(rebuilds(), first, 'a second start does not rebuild');
});
