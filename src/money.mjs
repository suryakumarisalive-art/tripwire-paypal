// Money is integer cents everywhere in Tripwire. Only these functions turn text into cents and cents into text.

export const MAX_CENTS = 100_000_000; // $1,000,000.00: anything larger is refused as a typo, not priced

export class MoneyError extends Error {}

// Accepts "1299", "1299.00", "1,299.00", "$1,299.00", "129.9", " -5 ". Refuses more than two decimals, junk and huge values.
export function parseMoney(input) {
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) throw new MoneyError('Price is not a number.');
    input = String(input);
  }
  if (typeof input !== 'string') throw new MoneyError('Price is missing.');
  let s = input.trim().replace(/^\$/, '').replace(/^(-?)\$/, '$1').trim();
  if (/^-?\d{1,3}(,\d{3})+(\.\d*)?$/.test(s)) s = s.replace(/,/g, '');
  const m = /^(-?)(\d+)(?:\.(\d{0,2}))?$/.exec(s);
  if (!m) throw new MoneyError(`"${input.trim().slice(0, 40)}" is not a price.`);
  const cents = Number(m[2]) * 100 + Number((m[3] || '').padEnd(2, '0'));
  if (!Number.isSafeInteger(cents) || cents > MAX_CENTS) throw new MoneyError('Price is too large.');
  return m[1] === '-' ? -cents : cents;
}

// Whole cents from a JSON caller (the checkout API). Refuses strings, fractions and anything beyond MAX_CENTS, so
// "129.90" or 129.9 can never be read as cents.
export function parseCents(v) {
  if (typeof v !== 'number' || !Number.isSafeInteger(v)) throw new MoneyError('Amounts are whole numbers of cents (129900 for $1,299.00).');
  if (Math.abs(v) > MAX_CENTS) throw new MoneyError('Price is too large.');
  return v;
}

// "1299.00": the exact string PayPal's amount.value expects.
export function toPayPalValue(cents) {
  if (!Number.isSafeInteger(cents) || cents <= 0) throw new MoneyError('Amount must be a positive whole number of cents.');
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
}

export function fromPayPalValue(value) {
  const cents = parseMoney(String(value));
  if (cents <= 0) throw new MoneyError('PayPal returned a non-positive amount.');
  return cents;
}

// "$1,299.00" for people.
export function formatUsd(cents) {
  if (!Number.isSafeInteger(cents)) return '—';
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${sign}$${dollars}.${String(abs % 100).padStart(2, '0')}`;
}

export function median(values) {
  const v = values.filter(Number.isSafeInteger).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = v.length >> 1;
  return v.length % 2 ? v[mid] : Math.round((v[mid - 1] + v[mid]) / 2);
}
