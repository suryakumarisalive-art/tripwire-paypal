import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMoney, toPayPalValue, formatUsd, median, MoneyError, fromPayPalValue } from '../src/money.mjs';
import { checkPrice } from '../src/rules.mjs';

test('parseMoney reads the price formats a CSV actually contains, in integer cents (AC6)', () => {
  assert.equal(parseMoney('1299'), 129900);
  assert.equal(parseMoney('1299.00'), 129900);
  assert.equal(parseMoney('1,299.00'), 129900);
  assert.equal(parseMoney('$1,299.00'), 129900);
  assert.equal(parseMoney(' 129.9 '), 12990);
  assert.equal(parseMoney('0.07'), 7);
  assert.equal(parseMoney('-5'), -500);
  assert.equal(parseMoney('-$5.50'), -550);
  assert.equal(parseMoney(19.99), 1999);
});

test('parseMoney refuses junk, three decimals, bad grouping and absurd values', () => {
  for (const bad of ['', 'abc', '12.345', '1,29.00', '1.2.3', '$', '1e5', '10000000.01', '∞', null, undefined, NaN]) {
    assert.throws(() => parseMoney(bad), MoneyError, String(bad));
  }
});

test('toPayPalValue formats cents exactly as PayPal expects and refuses non-positive or fractional cents (AC6)', () => {
  assert.equal(toPayPalValue(129900), '1299.00');
  assert.equal(toPayPalValue(12990), '129.90');
  assert.equal(toPayPalValue(7), '0.07');
  assert.equal(toPayPalValue(100), '1.00');
  for (const bad of [0, -1, 1.5, NaN, '100']) assert.throws(() => toPayPalValue(bad), MoneyError);
  assert.equal(fromPayPalValue('129.90'), 12990);
  assert.throws(() => fromPayPalValue('0.00'), MoneyError);
});

test('formatUsd and median', () => {
  assert.equal(formatUsd(129900), '$1,299.00');
  assert.equal(formatUsd(-550), '-$5.50');
  assert.equal(formatUsd(7), '$0.07');
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([1, 2, 3, 4]), 3);
  assert.equal(median([]), null);
});

test('a slipped decimal is held by code: $1,299.00 -> $129.90', () => {
  const r = checkPrice({ newCents: 12990, oldCents: 129900, costCents: null, medianCents: 129900 });
  assert.ok(r.holds.some((h) => h.code === 'DECIMAL_SHIFT'));
  assert.ok(r.holds.some((h) => h.code === 'STEEP_DROP'));
  assert.equal(r.needsAi, false);
});

test('x100 and x1000 slips are held too; a 9x drop is not called a decimal slip', () => {
  assert.ok(checkPrice({ newCents: 1299, oldCents: 129900 }).holds.some((h) => h.code === 'DECIMAL_SHIFT'));
  assert.ok(checkPrice({ newCents: 130, oldCents: 129900 }).holds.some((h) => h.code === 'DECIMAL_SHIFT'));
  assert.ok(!checkPrice({ newCents: 14433, oldCents: 129900 }).holds.some((h) => h.code === 'DECIMAL_SHIFT'));
});

test('below cost, zero and negative prices are held', () => {
  assert.ok(checkPrice({ newCents: 90000, oldCents: 129900, costCents: 98000 }).holds.some((h) => h.code === 'BELOW_COST'));
  assert.ok(checkPrice({ newCents: 0, oldCents: 129900 }).holds.some((h) => h.code === 'NON_POSITIVE'));
  assert.ok(checkPrice({ newCents: -500, oldCents: 129900 }).holds.some((h) => h.code === 'NON_POSITIVE'));
});

test('a small change goes live without the AI; a big drop or an unknown item needs the AI', () => {
  assert.deepEqual(checkPrice({ newCents: 18900, oldCents: 19900, medianCents: 19900, costCents: 12000 }), { holds: [], needsAi: false, reference: 19900 });
  assert.equal(checkPrice({ newCents: 25999, oldCents: 34999, medianCents: 34999 }).needsAi, true); // -26%
  assert.equal(checkPrice({ newCents: 2490 }).needsAi, true); // new item, no history, no cost
  assert.equal(checkPrice({ newCents: 2490, costCents: 1000 }).needsAi, false); // cost known and covered
  assert.equal(checkPrice({ newCents: 39999, oldCents: 34999 }).needsAi, false); // price increase
});
