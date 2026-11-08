// Test harness: the same SQL as production, run on node:sqlite through an adapter shaped like a Durable Object's
// SqlStorage (exec(query, ...bindings) -> cursor with toArray() and one()).
import { DatabaseSync } from 'node:sqlite';
import { StoreCore } from '../src/store.mjs';

export function sqlAdapter() {
  const db = new DatabaseSync(':memory:');
  return {
    exec(query, ...bindings) {
      const stmt = db.prepare(query);
      const returnsRows = /^\s*(SELECT|WITH)\b/i.test(query) || /\bRETURNING\b/i.test(query);
      const rows = returnsRows ? stmt.all(...bindings).map((r) => ({ ...r })) : (stmt.run(...bindings), []);
      return {
        toArray: () => rows,
        one: () => { if (rows.length !== 1) throw new Error(`expected exactly one row, got ${rows.length}`); return rows[0]; },
      };
    },
  };
}

export function clock(start = Date.UTC(2026, 10, 6, 12, 0, 0)) {
  let t = start;
  const now = () => t;
  now.advance = (ms) => { t += ms; };
  return now;
}

let seq = 0;
export const FAKE_AUTH_EXPIRES = '2026-12-05T12:00:00Z'; // sandbox authorizations carry expiration_time (29 days)
// A fake PayPal that behaves like the sandbox responses verified on 6 Nov 2026, and records every call.
// orderStatus(orderId): what GET /v2/checkout/orders/{id} answers ('CREATED' by default); throw a PayPalError for a 404.
export function fakePayPal({ failCreate = false, failCapture = false, delayMs = 0, orderStatus = () => 'CREATED' } = {}) {
  const calls = [];
  const tick = () => new Promise((r) => setTimeout(r, delayMs));
  const id = (p) => `${p}${String(++seq).padStart(6, '0')}`;
  return {
    calls,
    async createOrder(args) {
      calls.push(['createOrder', args]); await tick();
      if (failCreate) { const { PayPalError } = await import('../src/paypal.mjs'); throw new PayPalError(422, 'UNPROCESSABLE_ENTITY', 'INSTRUMENT_DECLINED', 'dbg123'); }
      const orderId = id('ORD');
      if (args.paymentSource) return { status: 201, body: { id: orderId, status: 'COMPLETED', purchase_units: [{ payments: { authorizations: [{ id: id('AUTH'), status: 'CREATED', expiration_time: FAKE_AUTH_EXPIRES }] } }] } };
      return { status: 201, body: { id: orderId, status: 'CREATED' } };
    },
    async authorizeOrder(orderId, requestId) {
      calls.push(['authorizeOrder', orderId, requestId]); await tick();
      return { status: 201, body: { id: orderId, status: 'COMPLETED', purchase_units: [{ payments: { authorizations: [{ id: id('AUTH'), status: 'CREATED', expiration_time: FAKE_AUTH_EXPIRES }] } }] } };
    },
    async captureAuthorization(authId, requestId) {
      calls.push(['captureAuthorization', authId, requestId]); await tick();
      if (failCapture) { const { PayPalError } = await import('../src/paypal.mjs'); throw new PayPalError(422, 'UNPROCESSABLE_ENTITY', 'AUTHORIZATION_VOIDED', 'dbg456'); }
      return { status: 201, body: { id: id('CAP'), status: 'COMPLETED' } };
    },
    async voidAuthorization(authId, requestId) { calls.push(['voidAuthorization', authId, requestId]); await tick(); return { status: 200, body: { id: authId, status: 'VOIDED' } }; },
    async refundCapture(capId) { calls.push(['refundCapture', capId]); return { status: 201, body: { id: id('REF'), status: 'COMPLETED' } }; },
    async getOrder(orderId) { calls.push(['getOrder', orderId]); await tick(); const st = orderStatus(orderId); return { status: 200, body: typeof st === 'object' ? st : { id: orderId, status: st } }; },
  };
}

// An AI stub: answer(row) returns a verdict object, or null to stay silent for that row.
export function fakeAi(answer = () => null, { ok = true, error = '' } = {}) {
  const calls = [];
  const fn = async (rows) => {
    calls.push(rows);
    if (!ok) return { ok: false, error, verdicts: new Map() };
    const verdicts = new Map();
    for (const r of rows) { const v = answer(r); if (v) verdicts.set(r.sku, v); }
    return { ok: true, verdicts };
  };
  fn.calls = calls;
  return fn;
}

export const verdict = (v, low = 0, high = 0, explanation = 'Test explanation.') => ({ verdict: v, marketLowCents: low, marketHighCents: high, likelyCause: 'unknown', explanation });

export function makeStore({ paypal = fakePayPal(), reviewAi = fakeAi(), market = null, matchAi = null, config = {}, now = clock() } = {}) {
  const alarms = [];
  let n = 0;
  const store = new StoreCore({ sql: sqlAdapter(), paypal, reviewAi, market, matchAi, now, newId: () => `o${++n}`, scheduleAlarm: async (at) => { alarms.push(at); }, config });
  store.init();
  return { store, paypal, reviewAi, now, alarms };
}
