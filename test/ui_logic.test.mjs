// Regression tests for the console's pure display logic (public/logic.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { shortLabel, tourProgress, swarmReadings } from '../public/logic.js';

const TV = 'TV-BRAVIA-65';
const ev = (seq, kind, sku = TV) => ({ seq, kind, sku });

test('tour: a second slip after closing resets steps 2 and 3 (step 3 must not say "Closed again" while the TV is held)', () => {
  const events = [ev(1, 'PRICE_HELD'), ev(2, 'PRICE_HELD'), ev(3, 'SWARM_DONE'), ev(4, 'MERCHANT_FIXED'), ev(5, 'PRICE_HELD'), ev(6, 'PRICE_HELD')];
  assert.deepEqual(tourProgress(events, TV), { slipped: true, swarmed: false, closed: false });
});

test('tour: the AI\'s own PRICE_HELD after the swarm belongs to the same hold', () => {
  const events = [ev(1, 'PRICE_HELD'), ev(2, 'SWARM_DONE'), ev(3, 'PRICE_HELD')];
  assert.deepEqual(tourProgress(events, TV), { slipped: true, swarmed: true, closed: false });
});

test('tour: the full run is done; other products do not count', () => {
  const events = [ev(1, 'PRICE_HELD'), ev(2, 'SWARM_DONE', 'LEGO-75192'), ev(3, 'SWARM_DONE'), ev(4, 'MERCHANT_FIXED')];
  assert.deepEqual(tourProgress(events, TV), { slipped: true, swarmed: true, closed: true });
  assert.deepEqual(tourProgress([], TV), { slipped: false, swarmed: false, closed: false });
});

test('receipt totals climb with the sparks instead of jumping ahead of the counter', () => {
  const pre = { refused: 0, kept: 0 }; const actual = { refused: 25, kept: 2_922_750 };
  assert.deepEqual(swarmReadings(pre, actual, 2), { refused: 2, kept: 233_820 });
  assert.deepEqual(swarmReadings(pre, actual, 25), actual);
  assert.deepEqual(swarmReadings(pre, actual, 40), actual); // never past what the server confirmed
  assert.deepEqual(swarmReadings(pre, pre, 10), pre); // nothing confirmed yet: hold the old totals
});

test('short labels print in full: brand and model, no ellipsis', () => {
  assert.equal(shortLabel('Sony Bravia 7 65" 4K Mini LED TV'), 'Sony Bravia');
  assert.equal(shortLabel('LEGO Star Wars Millennium Falcon 75192'), 'LEGO Star Wars');
  assert.equal(shortLabel('Herman Miller Aeron Chair, Size B'), 'Herman Miller');
  assert.equal(shortLabel('Apple AirPods Pro 2 (USB-C)'), 'Apple AirPods');
  for (const n of ['DJI Mini 4 Pro Drone', 'Dyson V15 Detect Cordless Vacuum', 'Sony WH-1000XM5 Wireless Headphones']) assert.ok(shortLabel(n).length <= 18, n);
});

test('PayPal terminal keeps its ending after a reload: "0 of 25" and "ready at" come from the events', async () => {
  const { terminalState } = await import('../public/logic.js');
  const done = { seq: 3, kind: 'SWARM_DONE', sku: TV, message: 'Swarm over: 25 refused before PayPal, 0 authorized and waiting. Nothing was captured.' };
  assert.deepEqual(terminalState([]), { reached: null, readyCents: null });
  assert.deepEqual(terminalState([ev(1, 'PRICE_HELD'), done]), { reached: { total: 25, authorized: 0 }, readyCents: null });
  const fixed = { seq: 4, kind: 'MERCHANT_FIXED', sku: TV, amountCents: 129_900 };
  assert.deepEqual(terminalState([ev(1, 'PRICE_HELD'), done, fixed]), { reached: { total: 25, authorized: 0 }, readyCents: 129_900 });
  assert.equal(terminalState([ev(1, 'PRICE_HELD'), done, fixed, ev(5, 'PRICE_HELD')]).readyCents, null); // tripped again: not ready
  const lego = { seq: 7, kind: 'SWARM_DONE', sku: 'LEGO-75192', message: 'Swarm over: 20 refused before PayPal, 5 authorized and waiting. Nothing was captured.' };
  assert.deepEqual(terminalState([done, fixed, lego]).reached, { total: 25, authorized: 5 });
});

test('a review item offers no Capture button: the server refuses honor on review orders (409)', async () => {
  const { waitingActions } = await import('../public/logic.js');
  assert.deepEqual(waitingActions('review'), ['void']);
  assert.deepEqual(waitingActions('tripped'), ['void', 'honor']);
  assert.deepEqual(waitingActions('held'), ['void', 'honor']);
});

test('the bots result prints only real lines: no "null" when nothing failed at PayPal', async () => {
  const { swarmSummary } = await import('../public/logic.js');
  assert.deepEqual(swarmSummary({ refused: 20, count: 25, authorized: 5, failed: 0 }),
    ['20 of 25 refused before PayPal', '5 authorized and waiting; nothing captured.']);
  assert.deepEqual(swarmSummary({ refused: 25, count: 25, authorized: 0, failed: 0 }), ['25 of 25 refused before PayPal', 'Not one PayPal order was created.']);
  assert.equal(swarmSummary({ refused: 23, count: 25, authorized: 1, failed: 1 })[2], '1 failed at PayPal.');
  assert.ok(!swarmSummary({ refused: 20, count: 25, authorized: 5, failed: 0 }).some((l) => l == null));
});
