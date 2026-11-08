// PayPal REST client for the sandbox: Orders v2 (AUTHORIZE) and Payments v2 (capture, void, refund).
// Every POST carries a PayPal-Request-Id, so a retried request can never create a second order or capture twice.
// 429 and 5xx are retried with backoff using the same request id; redirects are refused; debug_id is kept on errors.
import { toPayPalValue } from './money.mjs';

export const SANDBOX_HOST = 'api-m.sandbox.paypal.com';

export class PayPalError extends Error {
  constructor(status, name, issue, debugId, message) {
    super(message || `PayPal ${status}${name ? ` ${name}` : ''}${issue ? ` (${issue})` : ''}`);
    this.status = status; this.paypalName = name || ''; this.issue = issue || ''; this.debugId = debugId || '';
  }
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));
const newRequestId = () => crypto.randomUUID();

export function createPayPal({ clientId, clientSecret, fetchImpl = globalThis.fetch, host = SANDBOX_HOST, sleep = defaultSleep, now = Date.now, maxRetries = 3 }) {
  if (!clientId || !clientSecret) throw new Error('PayPal credentials are not configured.');
  if (host !== SANDBOX_HOST) throw new Error('Tripwire only talks to the PayPal sandbox.');
  let cached = null; // { token, expiresAt }

  async function token(force = false) {
    if (!force && cached && cached.expiresAt > now()) return cached.token;
    for (let attempt = 0; ; attempt++) {
      let r;
      try {
        r = await fetchImpl(`https://${host}/v1/oauth2/token`, {
          method: 'POST', redirect: 'error',
          headers: { Authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`, 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'grant_type=client_credentials',
        });
      } catch {
        if (attempt < maxRetries) { await sleep(backoff(attempt)); continue; }
        throw new PayPalError(0, 'NETWORK', '', '', 'PayPal could not be reached.');
      }
      if ((r.status === 429 || r.status >= 500) && attempt < maxRetries) { await sleep(backoff(attempt)); continue; }
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.access_token) throw new PayPalError(r.status, j.error || 'AUTH', '', r.headers.get('paypal-debug-id'), 'PayPal sign-in failed.');
      cached = { token: j.access_token, expiresAt: now() + Math.max(60, Number(j.expires_in) - 300) * 1000 };
      return cached.token;
    }
  }

  // rawJson: the body as an exact JSON string, sent byte for byte (webhook verification needs the event as received)
  async function call(method, path, body, requestId = method === 'POST' ? newRequestId() : null, { rawJson = null } = {}) {
    let refreshed = false;
    for (let attempt = 0; ; attempt++) {
      const headers = { Authorization: `Bearer ${await token()}`, 'Content-Type': 'application/json', Prefer: 'return=representation' };
      if (requestId) headers['PayPal-Request-Id'] = requestId;
      let r;
      try {
        r = await fetchImpl(`https://${host}${path}`, { method, redirect: 'error', headers, body: rawJson ?? (body === undefined ? undefined : JSON.stringify(body)) });
      } catch (e) {
        if (attempt < maxRetries) { await sleep(backoff(attempt)); continue; }
        throw new PayPalError(0, 'NETWORK', '', '', 'PayPal could not be reached.');
      }
      const debugId = r.headers.get('paypal-debug-id') || '';
      const text = await r.text();
      let j = {};
      try { j = text ? JSON.parse(text) : {}; } catch { j = {}; }
      if (r.ok) return { status: r.status, body: j, debugId };
      if (r.status === 401 && !refreshed) { refreshed = true; await token(true); continue; }
      if ((r.status === 429 || r.status >= 500) && attempt < maxRetries) {
        const retryAfter = Number(r.headers.get('retry-after'));
        await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 8000) : backoff(attempt));
        continue;
      }
      const issue = Array.isArray(j.details) && j.details[0] ? j.details[0].issue : '';
      throw new PayPalError(r.status, j.name, issue, j.debug_id || debugId);
    }
  }

  // customId: the store's webhook route token (so PayPal's webhooks find this store); the local order id when there is none
  function purchaseUnit({ amountCents, currency = 'USD', sku, name, localOrderId, customId }) {
    return {
      reference_id: String(sku).slice(0, 256),
      custom_id: String(customId || localOrderId).slice(0, 127),
      description: String(name).slice(0, 127),
      amount: { currency_code: currency, value: toPayPalValue(amountCents), breakdown: { item_total: { currency_code: currency, value: toPayPalValue(amountCents) } } },
      items: [{ name: String(name).slice(0, 127), sku: String(sku).slice(0, 127), quantity: '1', unit_amount: { currency_code: currency, value: toPayPalValue(amountCents) } }],
    };
  }

  return {
    // paymentSource: undefined for buyer checkout (the buyer approves in PayPal or Venmo), or { card } for the sandbox bots.
    async createOrder({ amountCents, currency, sku, name, localOrderId, customId, paymentSource, requestId }) {
      const body = { intent: 'AUTHORIZE', purchase_units: [purchaseUnit({ amountCents, currency, sku, name, localOrderId, customId })] };
      if (paymentSource) body.payment_source = paymentSource;
      return call('POST', '/v2/checkout/orders', body, requestId || newRequestId());
    },
    async authorizeOrder(orderId, requestId) { return call('POST', `/v2/checkout/orders/${encodeURIComponent(orderId)}/authorize`, {}, requestId || newRequestId()); },
    async getOrder(orderId) { return call('GET', `/v2/checkout/orders/${encodeURIComponent(orderId)}`); },
    async captureAuthorization(authorizationId, requestId) {
      return call('POST', `/v2/payments/authorizations/${encodeURIComponent(authorizationId)}/capture`, { final_capture: true }, requestId || newRequestId());
    },
    async voidAuthorization(authorizationId, requestId) { return call('POST', `/v2/payments/authorizations/${encodeURIComponent(authorizationId)}/void`, undefined, requestId || newRequestId()); },
    async refundCapture(captureId, requestId) { return call('POST', `/v2/payments/captures/${encodeURIComponent(captureId)}/refund`, {}, requestId || newRequestId()); },
    async getCapture(captureId) { return call('GET', `/v2/payments/captures/${encodeURIComponent(captureId)}`); },
    // A webhook delivery is PayPal's only if PayPal says so: POST /v1/notifications/verify-webhook-signature with the
    // transmission headers and the event exactly as received (spliced in raw: re-serialising the JSON can change bytes
    // and fail a genuine signature). Returns true only on SUCCESS; throws PayPalError when PayPal cannot answer.
    async verifyWebhook({ authAlgo, certUrl, transmissionId, transmissionSig, transmissionTime, webhookId, rawEvent }) {
      const head = JSON.stringify({ auth_algo: authAlgo, cert_url: certUrl, transmission_id: transmissionId, transmission_sig: transmissionSig, transmission_time: transmissionTime, webhook_id: webhookId });
      const r = await call('POST', '/v1/notifications/verify-webhook-signature', undefined, newRequestId(), { rawJson: `${head.slice(0, -1)},"webhook_event":${rawEvent}}` });
      return r.body?.verification_status === 'SUCCESS';
    },
  };
}

function backoff(attempt) { return Math.min(4000, 400 * 2 ** attempt) + Math.floor(Math.random() * 200); }

// The first authorization on an order response, or null.
export function authorizationOf(orderBody) {
  const a = orderBody?.purchase_units?.[0]?.payments?.authorizations?.[0];
  return a && a.id ? { id: a.id, status: a.status, expiresAt: a.expiration_time || null } : null;
}

// The capture a refund or reversal belongs to: its "up" link (/v2/payments/captures/{id}), or null.
export function captureIdOf(resource) {
  const up = Array.isArray(resource?.links) ? resource.links.find((l) => l && l.rel === 'up' && /\/v2\/payments\/captures\/[A-Za-z0-9-]+$/.test(String(l.href))) : null;
  return up ? String(up.href).split('/').pop() : null;
}

// A PayPal sandbox test card for the bot swarm (public sandbox test data; it never works outside the sandbox).
export const SANDBOX_BOT_CARD = Object.freeze({
  card: {
    number: '4032039317984658', expiry: '2030-12', security_code: '123', name: 'Swarm Bot',
    billing_address: { address_line_1: '1 Main St', admin_area_2: 'San Jose', admin_area_1: 'CA', postal_code: '95131', country_code: 'US' },
  },
});
