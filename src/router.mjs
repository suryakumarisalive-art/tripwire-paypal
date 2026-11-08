// HTTP routing for /api/*. Pure: it is handed getStore(storeId) -> an object with call(method, args), so it runs the same
// in the Worker (a Durable Object stub) and in tests (a StoreCore on node:sqlite).
// config: { paypalClientId, paypalReady, aiReady, storeIds: createStoreIds(key), limit: async (bucket, key) => boolean }
import { parseCsv, CsvError, MAX_CSV_BYTES } from './csv.mjs';
import { DEMO_IMPORTS } from './seed.mjs';
import { mcpRespond, MCP_VERSIONS } from './mcp.mjs';
import { captureIdOf } from './paypal.mjs';

const MAX_BODY = MAX_CSV_BYTES + 4096;

export class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }

const HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin' };
export const json = (status, body) => new Response(JSON.stringify(body), { status, headers: HEADERS });

const hex = (bytes) => [...bytes].map((x) => x.toString(16).padStart(2, '0')).join('');

// Constant-time comparison of two hex strings.
const same = (a, b) => { if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; };

// Store ids are issued by /api/session and signed: 24 random hex characters plus an 8-character HMAC tag. A made-up id
// is refused before it can create (and seed) a Durable Object, so nobody can mint stores by guessing.
// The store id is the console credential. A store's checkout API key (docs/GATE.md) is the store id encrypted with
// AES-GCM under a separate key, with a synthetic IV (an HMAC of the store id, so the key is the same every time the
// console shows it). It reveals nothing about the store id, it cannot be forged or altered, and it opens only /api/v1
// for that store, never the console.
const bytes = (h) => Uint8Array.from(h.match(/../g), (x) => Number.parseInt(x, 16));
export function createStoreIds(keyMaterial) {
  if (!keyMaterial) throw new Error('Store id signing key is missing.');
  const derive = (label) => crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${label}:${keyMaterial}`));
  const hmacKey = (label) => derive(label).then((raw) => crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']));
  const idKey = hmacKey('tripwire-store-ids'); const ivKey = hmacKey('tripwire-api-keys');
  const aesKey = (label) => derive(label).then((raw) => crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']));
  const encKey = aesKey('tripwire-api-keys-enc');
  // The webhook route token (custom_id on every PayPal order a store creates) is built the same way under its own keys:
  // it tells a verified PayPal webhook which store to wake, reveals nothing, and opens nothing (it is not an API key).
  const routeIvKey = hmacKey('tripwire-route-iv'); const routeEncKey = aesKey('tripwire-route-enc');
  const seal = async (storeId, ivK, encK, prefix) => {
    const iv = await mac(ivK, storeId, 24);
    return `${prefix}${iv}${hex(new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: bytes(iv) }, await encK, bytes(storeId))))}`;
  };
  const open = async (token, ivK, encK, prefix) => {
    const m = typeof token === 'string' && token.startsWith(prefix) ? /^([a-f0-9]{24})([a-f0-9]{64})$/.exec(token.slice(prefix.length)) : null;
    if (!m) return null;
    let storeId;
    try { storeId = hex(new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes(m[1]) }, await encK, bytes(m[2])))); } catch { return null; }
    if (!(await verify(storeId))) return null;
    return same(await mac(ivK, storeId, 24), m[1]) ? storeId : null;
  };
  const mac = async (key, body, n) => hex(new Uint8Array(await crypto.subtle.sign('HMAC', await key, new TextEncoder().encode(body)))).slice(0, n);
  const verify = async (id) => typeof id === 'string' && /^[a-f0-9]{32}$/.test(id) && same(await mac(idKey, id.slice(0, 24), 8), id.slice(24));
  return {
    async issue() { const b = new Uint8Array(12); crypto.getRandomValues(b); const body = hex(b); return body + await mac(idKey, body, 8); },
    verify,
    async apiKeyFor(storeId) { // storeId must already be verified
      const iv = await mac(ivKey, storeId, 24);
      const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: bytes(iv) }, await encKey, bytes(storeId)));
      return `twk_${iv}${hex(ct)}`;
    },
    async storeForApiKey(key) {
      const m = typeof key === 'string' ? /^twk_([a-f0-9]{24})([a-f0-9]{64})$/.exec(key) : null;
      if (!m) return null;
      let storeId;
      try { storeId = hex(new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes(m[1]) }, await encKey, bytes(m[2])))); } catch { return null; }
      if (!(await verify(storeId))) return null;
      return same(await mac(ivKey, storeId, 24), m[1]) ? storeId : null; // the one key the console shows, no other
    },
    routeFor: (storeId) => seal(storeId, routeIvKey, routeEncKey, 'twr_'), // storeId must already be verified; 92 chars
    storeForRoute: (token) => open(token, routeIvKey, routeEncKey, 'twr_'),
  };
}

// Reads at most max bytes of a JSON body even when the client sends no Content-Length (a chunked body).
async function readText(req, max = MAX_BODY) {
  if (!(req.headers.get('content-type') || '').toLowerCase().startsWith('application/json')) throw new HttpError(415, 'Send JSON.');
  if (Number(req.headers.get('content-length') || 0) > max) throw new HttpError(413, 'Request body too large.');
  let text = '';
  if (req.body) {
    const reader = req.body.getReader(); const dec = new TextDecoder(); let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) { await reader.cancel().catch(() => {}); throw new HttpError(413, 'Request body too large.'); }
      text += dec.decode(value, { stream: true });
    }
    text += dec.decode();
  }
  return text;
}

// allowArray: an MCP batch (a JSON array of messages) is accepted where the caller asks for it.
async function readJson(req, { allowArray = false } = {}) {
  const text = await readText(req);
  try { const v = JSON.parse(text); if (!v || typeof v !== 'object' || (Array.isArray(v) && !allowArray)) throw 0; return v; } catch { throw new HttpError(400, 'Body is not a JSON object.'); }
}

// A short hash of the caller's network (Cloudflare's connecting IP) for the shared AI budget's per-network cap. The IP
// itself is never stored or passed on.
async function ipKey(req) {
  const ip = req.headers.get('cf-connecting-ip');
  if (!ip) return '';
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`tripwire-ip:${ip}`)))).slice(0, 16);
}

// A POST must come from this site: same Origin when the browser sends one, and never a cross-site fetch.
function assertSameSite(req, url) {
  const origin = req.headers.get('origin');
  if (origin && origin !== url.origin) throw new HttpError(403, 'Cross-site request refused.');
  const site = req.headers.get('sec-fetch-site');
  if (site && site !== 'same-origin' && site !== 'none') throw new HttpError(403, 'Cross-site request refused.');
}

const str = (v, n = 200) => (typeof v === 'string' ? v.slice(0, n) : '');
const num = (v) => (typeof v === 'number' ? v : NaN); // the checkout API takes JSON numbers only, never "129.90"
const allow = async () => true;

// Calls one store method and turns a store error into an HTTP error.
const storeCaller = (store) => async (m, args) => {
  const r = await store.call(m, args);
  if (r && r.__error) throw new HttpError(r.__error.status, r.__error.message);
  return r;
};

// The checkout API (docs/GATE.md): server to server, authorized by the store's API key. There are no cookies and no
// CORS headers, and every method but POST (including a browser's preflight) is refused, so no web page can call it.
async function checkoutApi(req, path, { getStore, config, limit }) {
  const action = path.slice('/api/v1/'.length);
  if (action !== 'check' && action !== 'capture-check') throw new HttpError(404, 'Unknown route.');
  if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed. The checkout API takes POST from your server.');
  const m = /^Bearer +(\S{1,128})$/i.exec(req.headers.get('authorization') || ''); // the auth scheme is case-insensitive
  const storeId = m ? await config.storeIds.storeForApiKey(m[1]) : null;
  if (!storeId) throw new HttpError(401, 'Missing or invalid API key. Send Authorization: Bearer <the key from your Tripwire console>.');
  if (!(await limit('api', storeId))) throw new HttpError(429, 'Slow down: too many checkout API calls for this store. Try again in a few seconds.');
  const b = await readJson(req);
  if (b.currency !== undefined && b.currency !== null && b.currency !== 'USD') throw new HttpError(400, 'Tripwire checks USD prices only. Send currency "USD" or leave it out.');
  const call = storeCaller(getStore(storeId));
  if (action === 'check') {
    return json(200, await call('apiCheck', {
      sku: str(b.sku, 41), name: str(b.name, 120), priceCents: num(b.priceCents),
      costCents: b.costCents === undefined || b.costCents === null ? null : num(b.costCents), category: str(b.category, 60), description: str(b.description, 300),
      quantity: b.quantity === undefined || b.quantity === null ? 1 : num(b.quantity), ip: await ipKey(req),
    }));
  }
  return json(200, await call('captureCheck', {
    checkId: str(b.checkId, 80), amountCents: num(b.amountCents),
    authorizationId: b.authorizationId === undefined || b.authorizationId === null ? null : str(b.authorizationId, 65),
  }));
}

// The store's webhook route token (custom_id on its PayPal orders), or undefined when this deployment has no keys for it.
const routeOf = async (config, storeId) => (config.storeIds?.routeFor ? config.storeIds.routeFor(storeId) : undefined);

// The PayPal events Tripwire subscribes to (tools/register_webhook.mjs) and applies (StoreCore.paypalEvent).
export const WEBHOOK_EVENTS = Object.freeze(['CHECKOUT.ORDER.APPROVED', 'PAYMENT.AUTHORIZATION.VOIDED', 'PAYMENT.CAPTURE.COMPLETED',
  'PAYMENT.CAPTURE.PENDING', 'PAYMENT.CAPTURE.DENIED', 'PAYMENT.CAPTURE.DECLINED', 'PAYMENT.CAPTURE.REFUNDED', 'PAYMENT.CAPTURE.REVERSED']);
const MAX_WEBHOOK = 64 * 1024;

// PayPal webhooks (POST /api/paypal/webhook). Server to server from PayPal, so no Origin check; instead every event is
// verified with PayPal itself (config.verifyWebhook: /v1/notifications/verify-webhook-signature) before anything acts on
// it. Cheap checks first, so junk costs no PayPal call. The event then goes to the store named by the route token in
// custom_id (for a refund, the custom_id of the capture it refunds). Answers: 200 applied or ignored, 400 not a PayPal
// webhook, 401 signature refused, 503 PayPal or the store could not answer (PayPal retries non-2xx deliveries).
async function paypalWebhook(req, { getStore, config, limit }) {
  if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed. PayPal webhooks are POSTed.');
  if (!config.verifyWebhook) throw new HttpError(503, 'PayPal webhooks are not configured on this deployment.');
  if (!(await limit('webhook', req.headers.get('cf-connecting-ip') || 'local'))) throw new HttpError(429, 'Slow down: too many webhook deliveries. PayPal retries later.');
  const h = (n) => req.headers.get(n) || '';
  const fields = { authAlgo: h('paypal-auth-algo'), certUrl: h('paypal-cert-url'), transmissionId: h('paypal-transmission-id'), transmissionSig: h('paypal-transmission-sig'), transmissionTime: h('paypal-transmission-time') };
  if (Object.values(fields).some((v) => !v || v.length > 500)) throw new HttpError(400, 'Not a PayPal webhook: the PayPal transmission headers are missing.');
  let cert = null; try { cert = new URL(fields.certUrl); } catch { /* refused below */ }
  if (!cert || cert.protocol !== 'https:' || !/(^|\.)paypal\.com$/i.test(cert.hostname)) throw new HttpError(400, 'Not a PayPal webhook: its certificate is not on paypal.com.');
  const raw = await readText(req, MAX_WEBHOOK);
  let event = null; try { event = JSON.parse(raw); } catch { /* refused below */ }
  if (!event || typeof event !== 'object' || Array.isArray(event) || typeof event.id !== 'string' || typeof event.event_type !== 'string') throw new HttpError(400, 'Not a PayPal webhook event.');
  if (!WEBHOOK_EVENTS.includes(event.event_type)) return json(200, { ok: true, ignored: 'event type not used by Tripwire' });
  let verified;
  try { verified = await config.verifyWebhook({ ...fields, rawEvent: raw }); } catch (e) {
    // PayPal refusing the verification request itself (a 4xx: a bad cert URL, malformed fields) means it is not a genuine
    // delivery; only PayPal being unreachable or failing (network, 5xx, 429) is worth PayPal's retry.
    if (e && e.status >= 400 && e.status < 500 && e.status !== 429) throw new HttpError(401, 'PayPal refused to verify this webhook.');
    throw new HttpError(503, 'PayPal could not be reached to verify this webhook. PayPal retries it later.');
  }
  if (!verified) throw new HttpError(401, 'The webhook signature did not verify with PayPal.');
  const res = event.resource && typeof event.resource === 'object' && !Array.isArray(event.resource) ? event.resource : {};
  let storeId = null;
  for (const t of [res.custom_id, res.purchase_units?.[0]?.custom_id]) if (!storeId && typeof t === 'string') storeId = await config.storeIds.storeForRoute(t);
  const capture = !storeId && config.captureCustomId ? captureIdOf(res) : null; // a refund carries no custom_id: ask its capture
  if (capture) {
    let t;
    try { t = await config.captureCustomId(capture); } catch { throw new HttpError(503, 'PayPal could not be reached to look up the refunded capture. PayPal retries later.'); }
    if (typeof t === 'string') storeId = await config.storeIds.storeForRoute(t);
  }
  if (!storeId) return json(200, { ok: true, ignored: 'not an order of a Tripwire store' });
  const r = await storeCaller(getStore(storeId))('paypalEvent', { id: event.id.slice(0, 100), type: event.event_type, resource: res });
  return json(200, { ok: true, ...r });
}

// MCP (src/mcp.mjs): the same gate for AI agents and agentic checkouts, over Streamable HTTP. POST only (a GET would
// open a server-sent stream, which this stateless server does not offer: 405), the store's API key, no browser origin
// but this site's (the MCP spec requires servers to check Origin), and the checkout API's rate limit.
async function mcpApi(req, url, { getStore, config, limit }) {
  if (req.method !== 'POST') return new Response(JSON.stringify({ error: 'Method not allowed. The Tripwire MCP server takes POST (JSON-RPC), and offers no event stream.' }), { status: 405, headers: { ...HEADERS, Allow: 'POST' } });
  const origin = req.headers.get('origin');
  if (origin && origin !== url.origin) throw new HttpError(403, 'Cross-site request refused.');
  const version = req.headers.get('mcp-protocol-version');
  if (version && !MCP_VERSIONS.includes(version)) throw new HttpError(400, `Unsupported MCP-Protocol-Version. Supported: ${MCP_VERSIONS.join(', ')}.`);
  const m = /^Bearer +(\S{1,128})$/i.exec(req.headers.get('authorization') || '');
  const storeId = m ? await config.storeIds.storeForApiKey(m[1]) : null;
  if (!storeId) return new Response(JSON.stringify({ error: 'Missing or invalid API key. Send Authorization: Bearer <the key from your Tripwire console>.' }), { status: 401, headers: { ...HEADERS, 'WWW-Authenticate': 'Bearer' } });
  if (!(await limit('api', storeId))) throw new HttpError(429, 'Slow down: too many calls for this store. Try again in a few seconds.');
  let msg;
  try { msg = await readJson(req, { allowArray: true }); } catch (e) {
    if (e instanceof HttpError && e.status === 400) return json(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error: send one JSON-RPC 2.0 message as a JSON object.' } });
    throw e;
  }
  const call = storeCaller(getStore(storeId));
  const ip = await ipKey(req);
  const one = async (m) => {
    try { return await mcpRespond(m, { call, ip }); } catch (e) {
      if (!(e instanceof HttpError)) throw e;
      return { jsonrpc: '2.0', id: m && (typeof m.id === 'string' || Number.isInteger(m.id)) ? m.id : null, error: { code: -32000, message: e.message } };
    }
  };
  const accepted = () => new Response(null, { status: 202, headers: { 'Cache-Control': 'no-store' } });
  // A batch (the 2025-03-26 transport allows one): each message answered in order; notifications and responses drop out.
  if (Array.isArray(msg)) {
    if (!msg.length || msg.length > 20) return json(400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request: a batch holds 1-20 messages.' } });
    const out = [];
    for (const m of msg) { const r = await one(m); if (r !== null) out.push(r); }
    return out.length ? json(200, out) : accepted();
  }
  const res = await one(msg);
  return res === null ? accepted() : json(200, res);
}

export async function route(req, { getStore, config = {} }) {
  const url = new URL(req.url);
  const path = url.pathname;
  const method = req.method;
  const limit = config.limit || allow;
  try {
    if (method === 'GET' && path === '/api/health') {
      // paypal/ai: configured. checks: when each outside service last worked or failed, and today's shared AI use.
      let checks = null; try { checks = config.status ? await config.status() : null; } catch { /* health never fails on its own */ }
      return json(200, { ok: true, paypal: Boolean(config.paypalReady), ai: Boolean(config.aiReady), environment: 'PayPal sandbox', ...(checks ? { checks } : {}) });
    }
    if (method === 'GET' && path === '/api/config') return json(200, { paypalClientId: config.paypalClientId || '', environment: 'sandbox' });
    if (method === 'GET' && path === '/api/presets') return json(200, { presets: Object.entries(DEMO_IMPORTS).map(([id, p]) => ({ id, title: p.title, csv: p.csv })) });
    if (method === 'POST' && path === '/api/session') {
      assertSameSite(req, url);
      if (!(await limit('session', req.headers.get('cf-connecting-ip') || 'local'))) throw new HttpError(429, 'Too many new demo stores from here. Try again in a minute.');
      return json(200, { storeId: await config.storeIds.issue() });
    }
    if (path === '/api/paypal/webhook') return await paypalWebhook(req, { getStore, config, limit });
    if (path.startsWith('/api/v1/')) return await checkoutApi(req, path, { getStore, config, limit });
    if (path === '/api/mcp') return await mcpApi(req, url, { getStore, config, limit });
    if (!path.startsWith('/api/store/')) throw new HttpError(404, 'Unknown route.');

    const storeId = url.searchParams.get('store') || '';
    if (!(await config.storeIds.verify(storeId))) throw new HttpError(400, 'Missing or invalid store id. Open the console to start a demo store.');
    if (!(await limit(method === 'GET' ? 'read' : 'write', storeId))) throw new HttpError(429, 'Slow down: too many requests for this store. Try again in a few seconds.');
    const call = storeCaller(getStore(storeId));
    const action = path.slice('/api/store/'.length);

    if (method === 'GET') {
      if (action === 'state') return json(200, await call('state', { after: Number(url.searchParams.get('after')) || 0 }));
      if (action === 'products') return json(200, await call('products', {}));
      if (action === 'apikey') return json(200, { apiKey: await config.storeIds.apiKeyFor(storeId) });
      throw new HttpError(404, 'Unknown route.');
    }
    if (method !== 'POST') throw new HttpError(405, 'Method not allowed.');
    assertSameSite(req, url);
    const b = await readJson(req);
    switch (action) {
      case 'import': {
        let parsed;
        try { parsed = parseCsv(str(b.csv, MAX_CSV_BYTES + 1)); } catch (e) { if (e instanceof CsvError) throw new HttpError(400, e.message); throw e; }
        return json(200, { results: await call('applyPriceChanges', { rows: parsed.rows, source: 'import', ip: await ipKey(req) }) });
      }
      case 'price': return json(200, { results: await call('applyPriceChanges', { rows: [{ sku: str(b.sku, 40), price: str(String(b.price ?? ''), 32) }], source: 'edit', ip: await ipKey(req) }) });
      // priceCents: the price the merchant saw; a decision on a price that changed since is refused (409)
      // priceCents: the price the merchant saw (a decision on a price that changed since is a 409). It is optional only
      // so a console that predates it keeps working; when sent, it must be whole cents.
      case 'hold':
        if (b.priceCents !== undefined && !Number.isSafeInteger(b.priceCents)) return json(400, { error: 'priceCents must be the price you are deciding on, in whole cents.' });
        return json(200, await call('resolveHold', { sku: str(b.sku, 40), action: str(b.action, 10), priceCents: b.priceCents ?? null }));
      case 'resume': return json(200, await call('resume', { sku: str(b.sku, 40) }));
      case 'decide': {
        const waitReason = str(b.waitReason, 20) || null;
        if (waitReason && !WAIT_REASONS.includes(waitReason)) return json(400, { error: `waitReason must be one of ${WAIT_REASONS.join(', ')}.` });
        return json(200, await call('decideOrders', { sku: str(b.sku, 40), action: str(b.action, 10), waitReason }));
      }
      case 'swarm': return json(200, await call('swarm', { sku: str(b.sku, 40), n: Number(b.n) || 25, route: await routeOf(config, storeId) }));
      case 'settle': return json(200, await call('settle', {}));
      case 'reset': return json(200, await call('reset', {}));
      case 'checkout': {
        const r = await call('buyerCreateOrder', { sku: str(b.sku, 40), channel: str(b.channel, 10), route: await routeOf(config, storeId) });
        return json(r.ok ? 200 : 409, r);
      }
      case 'approve': {
        const r = await call('buyerApprove', { paypalOrderId: str(b.paypalOrderId, 64) });
        return json(r.ok ? 200 : 409, r);
      }
      default: throw new HttpError(404, 'Unknown route.');
    }
  } catch (e) {
    if (e instanceof HttpError) return json(e.status, { error: e.message });
    console.error('tripwire error', e && e.name, e && String(e.message).slice(0, 200)); // no request data, no secrets
    return json(500, { error: 'Tripwire hit an unexpected error.' });
  }
}

// Why an order can be waiting for the merchant (orders.wait_reason).
const WAIT_REASONS = ['review', 'tripped', 'held', 'price', 'gone', 'pending', 'paypal_error'];

// The RPC surface of a store. Only these methods can be called from the router, with these argument shapes.
export async function dispatch(core, method, args) {
  switch (method) {
    case 'state': return { catalog: core.catalog(), summary: core.summary(), orders: core.orders(60), timeline: core.timeline(args.after) };
    case 'products': return { products: core.publicCatalog() };
    case 'applyPriceChanges': return core.applyPriceChanges(args.rows, args.source === 'edit' ? 'edit' : 'import', { ip: typeof args.ip === 'string' ? args.ip.slice(0, 16) : '' });
    case 'resolveHold': return core.decideHold(args.sku, args.action, Number.isSafeInteger(args.priceCents) ? args.priceCents : null); // the decision plus the PayPal calls it settles
    case 'resume': return core.resume(args.sku);
    case 'decideOrders': return core.decideOrders(args.sku, args.action, WAIT_REASONS.includes(args.waitReason) ? args.waitReason : null);
    case 'swarm': core.setRoute(args.route); return core.swarm(args.sku, args.n);
    case 'settle': return core.settle();
    case 'reset': return core.reset();
    case 'buyerCreateOrder': core.setRoute(args.route); return core.buyerCreateOrder(args.sku, args.channel);
    case 'paypalEvent': return core.paypalEvent({ id: args.id, type: args.type, resource: args.resource }); // only from paypalWebhook, after PayPal verified it
    case 'buyerApprove': return core.buyerApprove(args.paypalOrderId);
    case 'apiCheck': return core.apiCheck(args); // reachable only from /api/v1 (checkoutApi), never from /api/store
    case 'captureCheck': return core.captureCheck(args.checkId, args.amountCents, args.authorizationId);
    default: return { __error: { status: 404, message: 'Unknown store method.' } };
  }
}
