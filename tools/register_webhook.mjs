// Registers Tripwire's PayPal webhook on the sandbox app (or updates its event list), and prints the webhook id to put in
// wrangler.jsonc as vars.PAYPAL_WEBHOOK_ID. Safe to run again: an existing webhook for the same URL is reused.
// Run with the sandbox app's credentials in the environment (they are never printed):
//   powershell -ExecutionPolicy Bypass -File tools/run_sandbox.ps1 -Script tools/register_webhook.mjs
import dns from 'node:dns';
import { WEBHOOK_EVENTS } from '../src/router.mjs';
dns.setDefaultResultOrder('ipv4first');

const BASE = (process.env.TRIPWIRE_BASE || 'https://tripwire-demo.suryakumarisalive.workers.dev').replace(/\/$/, '');
const URL_ = `${BASE}/api/paypal/webhook`;
const PP = 'https://api-m.sandbox.paypal.com';
const ID = process.env.PAYPAL_CLIENT_ID || process.env.DG_ID; const SECRET = process.env.PAYPAL_CLIENT_SECRET || process.env.DG_SECRET;
if (!ID || !SECRET) { console.log('Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET (a PayPal sandbox app) first.'); process.exit(1); }

try {
  const t = await fetch(`${PP}/v1/oauth2/token`, { method: 'POST', redirect: 'error', body: 'grant_type=client_credentials',
    headers: { Authorization: `Basic ${btoa(`${ID}:${SECRET}`)}`, 'Content-Type': 'application/x-www-form-urlencoded' } });
  const token = (await t.json()).access_token;
  if (!token) throw new Error(`PayPal sign-in failed (HTTP ${t.status})`);
  const h = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const list = await (await fetch(`${PP}/v1/notifications/webhooks`, { headers: h, redirect: 'error' })).json();
  const mine = (list.webhooks || []).find((w) => w.url === URL_);
  const types = WEBHOOK_EVENTS.map((name) => ({ name }));
  if (mine) {
    const have = new Set((mine.event_types || []).map((e) => e.name));
    if (WEBHOOK_EVENTS.every((n) => have.has(n)) && have.size === WEBHOOK_EVENTS.length) {
      console.log(`webhook already registered: ${mine.id} -> ${URL_}`);
    } else {
      const r = await fetch(`${PP}/v1/notifications/webhooks/${mine.id}`, { method: 'PATCH', headers: h, redirect: 'error', body: JSON.stringify([{ op: 'replace', path: '/event_types', value: types }]) });
      console.log(`webhook ${mine.id} event types updated: HTTP ${r.status}`);
    }
    console.log(`PAYPAL_WEBHOOK_ID=${mine.id}`);
  } else {
    const r = await fetch(`${PP}/v1/notifications/webhooks`, { method: 'POST', headers: { ...h, 'PayPal-Request-Id': `tripwire-webhook-${Date.now()}` }, redirect: 'error', body: JSON.stringify({ url: URL_, event_types: types }) });
    const j = await r.json();
    if (!r.ok) throw new Error(`create webhook -> HTTP ${r.status} ${j.name || ''} ${(j.details && j.details[0] && j.details[0].issue) || ''} debug_id ${j.debug_id || ''}`);
    console.log(`webhook created: ${j.id} -> ${URL_} (${(j.event_types || []).length} event types)`);
    console.log(`PAYPAL_WEBHOOK_ID=${j.id}`);
  }
} catch (e) { console.log(`register failed: ${e && e.message ? e.message.replace(/A21[\w-]{20,}/g, '[hidden]') : 'unknown error'}`); process.exit(1); }
