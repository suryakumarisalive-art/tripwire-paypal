// Live proof of PayPal webhooks on the DEPLOYED Worker: something happens to a Tripwire order OUTSIDE Tripwire (the
// merchant voids an authorization and refunds a capture directly in PayPal), PayPal sends a signed webhook, and the
// store's order changes to match. Also: a forged webhook is refused, and /api/health shows the last verified delivery.
// The "buyer approved but the page never came back" path needs a person to approve in PayPal; unit tests W10/R1 cover it.
// Run with the sandbox app's credentials in the environment (never printed):
//   powershell -ExecutionPolicy Bypass -File tools/run_sandbox.ps1 -Script tools/webhook_live.mjs
import dns from 'node:dns';
dns.setDefaultResultOrder('ipv4first'); // Node's fetch to *.workers.dev times out on this laptop otherwise

const BASE = (process.env.TRIPWIRE_BASE || 'https://tripwire-demo.suryakumarisalive.workers.dev').replace(/\/$/, '');
const PP = 'https://api-m.sandbox.paypal.com';
const ID = process.env.PAYPAL_CLIENT_ID || process.env.DG_ID; const SECRET = process.env.PAYPAL_CLIENT_SECRET || process.env.DG_SECRET;
if (!ID || !SECRET) { console.log('Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET (a PayPal sandbox app) first.'); process.exit(1); }
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) failures++; };

async function call(path, body) {
  const init = body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: BASE }, body: JSON.stringify(body) };
  const r = await fetch(`${BASE}${path}`, init);
  const j = await r.json().catch(() => ({}));
  if (!r.ok && r.status !== 409) throw new Error(`${path} -> HTTP ${r.status}: ${j.error || ''}`);
  return j;
}
let token = null;
async function paypal(method, path, body) {
  if (!token) {
    const t = await fetch(`${PP}/v1/oauth2/token`, { method: 'POST', redirect: 'error', body: 'grant_type=client_credentials',
      headers: { Authorization: `Basic ${btoa(`${ID}:${SECRET}`)}`, 'Content-Type': 'application/x-www-form-urlencoded' } });
    token = (await t.json()).access_token;
    if (!token) throw new Error(`PayPal sign-in failed (HTTP ${t.status})`);
  }
  const r = await fetch(`${PP}${path}`, { method, redirect: 'error', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'PayPal-Request-Id': `webhook-live-${Date.now()}-${Math.random()}` }, body: body === undefined ? undefined : JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`PayPal ${method} ${path.split('/').slice(0, 4).join('/')} -> HTTP ${r.status} ${j.name || ''} debug_id ${j.debug_id || ''}`);
  return j;
}
// Polls the store until test(order) holds for the order with this authorization, up to ms.
async function until(S, authId, test, ms = 300_000) {
  const end = Date.now() + ms;
  for (;;) {
    const st = await call(`/api/store/state${S}`);
    const o = st.orders.find((x) => x.authorizationId === authId);
    if (o && test(o)) return { o, st };
    if (Date.now() > end) return { o, st, timedOut: true };
    await wait(5000);
  }
}

try {
  const health0 = await call('/api/health');
  check(health0.paypal, 'deployment has PayPal configured');
  const { storeId } = await call('/api/session', {});
  const S = `?store=${storeId}`;
  console.log(`store ${storeId}`);

  console.log('--- 1. The merchant voids an authorization in PayPal, outside Tripwire');
  const sw = await call(`/api/store/swarm${S}`, { sku: 'KB-Q1PRO', n: 1 });
  check(sw.authorized === 1, `one bot order authorized (${JSON.stringify(sw)})`);
  const a = (await call(`/api/store/state${S}`)).orders.find((o) => o.sku === 'KB-Q1PRO' && o.authorizationId);
  await paypal('POST', `/v2/payments/authorizations/${a.authorizationId}/void`);
  console.log(`voided ${a.authorizationId} directly in PayPal; waiting for the webhook...`);
  const t0 = Date.now();
  const v = await until(S, a.authorizationId, (o) => o.status === 'voided');
  check(!v.timedOut, `order is voided in Tripwire after ${Math.round((Date.now() - t0) / 1000)} s (status ${v.o && v.o.status})`);
  check(v.st.timeline.some((e) => e.kind === 'VOIDED' && /outside Tripwire/.test(e.message) && e.paypalId === a.authorizationId), 'timeline: "voided outside Tripwire" from the webhook');
  check(!v.st.orders.some((o) => o.authorizationId === a.authorizationId && o.captureId), 'nothing was captured');

  console.log('--- 2. The merchant refunds a capture in PayPal, outside Tripwire');
  await wait(11_000); // the swarm cooldown
  const sw2 = await call(`/api/store/swarm${S}`, { sku: 'KETTLE-STAGG', n: 1 });
  check(sw2.authorized === 1, `one bot order authorized (${JSON.stringify(sw2)})`);
  const b = (await call(`/api/store/state${S}`)).orders.find((o) => o.sku === 'KETTLE-STAGG' && o.authorizationId);
  const c = await until(S, b.authorizationId, (o) => o.status === 'captured' && o.captureId, 120_000);
  check(!c.timedOut, `settlement captured it (capture ${c.o && c.o.captureId})`);
  if (!c.timedOut) {
    await paypal('POST', `/v2/payments/captures/${c.o.captureId}/refund`, {});
    console.log(`refunded ${c.o.captureId} directly in PayPal; waiting for the webhook...`);
    const t1 = Date.now();
    const r = await until(S, b.authorizationId, (o) => o.status === 'refunded');
    check(!r.timedOut, `order is refunded in Tripwire after ${Math.round((Date.now() - t1) / 1000)} s (status ${r.o && r.o.status})`);
    check(r.st.timeline.some((e) => e.kind === 'REFUNDED' && /PayPal refunded \$165\.00 of the \$165\.00/.test(e.message)), 'timeline: "PayPal refunded $165.00 of the $165.00 ..."');
    check(r.st.summary.refunded && r.st.summary.refunded.n === 1, `summary counts it (${JSON.stringify(r.st.summary.refunded)})`);
  }

  console.log('--- 3. A forged webhook is refused');
  const forged = await fetch(`${BASE}/api/paypal/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json',
    'paypal-auth-algo': 'SHA256withRSA', 'paypal-cert-url': 'https://api.sandbox.paypal.com/v1/notifications/certs/CERT-360caa42-fca2a594-a5cafa77',
    'paypal-transmission-id': 'forged-1', 'paypal-transmission-sig': 'Zm9yZ2Vk', 'paypal-transmission-time': new Date().toISOString() },
    body: JSON.stringify({ id: 'WH-FORGED', event_type: 'PAYMENT.AUTHORIZATION.VOIDED', resource: { id: 'X' } }) });
  check(forged.status === 401, `forged signature -> HTTP ${forged.status} (expect 401: PayPal said it did not verify)`);
  const junk = await fetch(`${BASE}/api/paypal/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  check(junk.status === 400, `no PayPal headers -> HTTP ${junk.status} (expect 400, no PayPal call)`);

  const health = await call('/api/health');
  const wh = health.checks && health.checks.services && health.checks.services.webhook;
  check(Boolean(wh && wh.lastOkAt && Date.now() - wh.lastOkAt < 30 * 60_000), `/api/health shows a verified webhook ${wh && wh.lastOkAt ? `${Math.round((Date.now() - wh.lastOkAt) / 1000)} s ago` : '(none)'} (cached up to 30 s)`);
} catch (e) { console.log(`run failed: ${e && e.message ? e.message.replace(/A21[\w-]{20,}/g, '[hidden]') : 'unknown error'}`); failures++; }

console.log(failures ? `WEBHOOKS: ${failures} FAILED` : 'WEBHOOKS: ALL LIVE CHECKS PASSED');
process.exit(failures ? 1 : 0);
