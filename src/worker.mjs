// Tripwire on Cloudflare Workers. /api/* is routed to one Durable Object per demo store (SQLite storage, alarms for
// settlement); everything else is the static console and storefront. Secrets: PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET
// (a PayPal sandbox app) and GROQ_API_KEY. Var: PAYPAL_WEBHOOK_ID (wrangler.jsonc; tools/register_webhook.mjs prints it).
import { DurableObject } from 'cloudflare:workers';
import { StoreCore, StoreError } from './store.mjs';
import { createPayPal } from './paypal.mjs';
import { reviewPrices, matchListings } from './ai.mjs';
import { route, dispatch, createStoreIds } from './router.mjs';
import { createMarket } from './market.mjs';
import { BudgetCore, gatedAiCall } from './budget.mjs';

let storeIds = null; let storeIdsKey = '';
function storeIdsFor(env) { // signing key derived from a secret the Worker already holds; cached per isolate
  const key = clean(env.PAYPAL_CLIENT_SECRET) || 'tripwire-unconfigured';
  if (!storeIds || storeIdsKey !== key) { storeIds = createStoreIds(key); storeIdsKey = key; }
  return storeIds;
}

// Workers Rate Limiting bindings (approximate, per Cloudflare location). Missing bindings allow everything.
function limiter(env) {
  const bindings = { session: env.LIMIT_SESSION, read: env.LIMIT_READ, write: env.LIMIT_WRITE, api: env.LIMIT_API, webhook: env.LIMIT_API };
  return async (bucket, key) => {
    const b = bindings[bucket];
    if (!b) return true;
    try { return (await b.limit({ key: `${bucket}:${key}` })).success; } catch { return true; }
  };
}

// Secrets piped in from Windows can carry a byte-order mark or a line break; keys are printable ASCII, so keep only that.
const clean = (v) => (typeof v === 'string' ? v.replace(/[^\x21-\x7E]/g, '') : '');

// Workers' fetch accepts redirect "follow" or "manual" only. The PayPal and Groq clients ask for "error" (never follow a
// redirect with credentials attached); this keeps that guarantee by requesting "manual" and refusing any 3xx.
async function workerFetch(url, init = {}) {
  if (init.redirect !== 'error') return fetch(url, init);
  const r = await fetch(url, { ...init, redirect: 'manual' });
  if (r.status >= 300 && r.status < 400) throw new TypeError('redirect refused');
  return r;
}

function paypalFor(env) {
  const id = clean(env.PAYPAL_CLIENT_ID); const secret = clean(env.PAYPAL_CLIENT_SECRET);
  if (!id || !secret) {
    const off = async () => { throw new StoreError(503, 'PayPal is not configured on this deployment.'); };
    return { createOrder: off, authorizeOrder: off, getOrder: off, captureAuthorization: off, voidAuthorization: off, refundCapture: off, getCapture: off, verifyWebhook: off };
  }
  return createPayPal({ clientId: id, clientSecret: secret, fetchImpl: workerFetch });
}

// Channel3 live prices (keyless MCP), shared by every store in this isolate so its cache serves them all.
const market = createMarket({ fetchImpl: workerFetch });

// The one shared AI budget and the record of when each outside service last worked (src/budget.mjs).
export class Budget extends DurableObject {
  constructor(ctx, env) { super(ctx, env); this.core = new BudgetCore({ sql: ctx.storage.sql }); ctx.blockConcurrencyWhile(async () => this.core.init()); }
  async take(store, n = 1, ip = '') { return this.core.take(store, n, ip); }
  async cacheGet(keys) { return this.core.cacheGet(keys); }
  async cachePut(entries) { this.core.cachePut(entries); }
  async record(name, ok, error = '') { this.core.record(name, ok, error); }
  async status() { return this.core.status(); }
}
let statusCache = { at: 0, value: null };

// PayPal webhooks: on only when the Worker knows its PayPal webhook id. Every delivery is verified with PayPal; a verified
// one is recorded for /api/health, so a judge can see webhooks arriving without running a checkout.
function webhookConfig(env) {
  const webhookId = clean(env.PAYPAL_WEBHOOK_ID);
  if (!webhookId || !clean(env.PAYPAL_CLIENT_ID) || !clean(env.PAYPAL_CLIENT_SECRET)) return {};
  return {
    verifyWebhook: async (fields) => {
      const ok = await paypalFor(env).verifyWebhook({ ...fields, webhookId });
      await note(budgetOf(env), 'webhook', ok, ok ? '' : 'A webhook delivery failed signature verification.');
      return ok;
    },
    captureCustomId: async (captureId) => (await paypalFor(env).getCapture(captureId)).body?.custom_id ?? null,
  };
}
const budgetOf = (env) => (env.BUDGET ? env.BUDGET.getByName('global') : null);
const note = async (b, name, ok, error) => { if (b) { try { await b.record(name, ok, error || ''); } catch { /* health is best effort */ } } };


export class Store extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    const groqKey = clean(env.GROQ_API_KEY);
    const storeKey = ctx.id.toString();
    this.core = new StoreCore({
      sql: ctx.storage.sql,
      paypal: paypalFor(env),
      // every Groq call goes through the shared answer cache and AI budget (src/budget.mjs gatedAiCall)
      reviewAi: (rows, meta = {}) => gatedAiCall(rows, { budget: budgetOf(env), storeKey, ip: meta.ip || '', kind: 'price', field: 'verdicts', run: (r) => reviewPrices(r, { groqKey, fetchImpl: workerFetch }) }),
      market: async (names) => { const m = await market(names); if ([...m.values()].some((v) => v.listings.length)) await note(budgetOf(env), 'market', true); return m; },
      matchAi: (rows, meta = {}) => gatedAiCall(rows, { budget: budgetOf(env), storeKey, ip: meta.ip || '', kind: 'match', field: 'matches', run: (r) => matchListings(r, { groqKey, fetchImpl: workerFetch }) }),
      transaction: (fn) => ctx.storage.transactionSync(fn),
      scheduleAlarm: async (at) => {
        const current = await ctx.storage.getAlarm();
        if (current === null || current > at) await ctx.storage.setAlarm(at);
      },
    });
    ctx.blockConcurrencyWhile(async () => {
      this.core.init();
      const at = this.core.pendingWorkAt(); // after a restart, finish any settlement or stuck PayPal call
      if (at !== null) { const cur = await ctx.storage.getAlarm(); if (cur === null || cur > at) await ctx.storage.setAlarm(at); }
    });
  }

  async call(method, args = {}) {
    try { return await dispatch(this.core, method, args || {}); } catch (e) {
      if (e instanceof StoreError) return { __error: { status: e.status, message: e.message } };
      console.error('store error', e && e.name, e && String(e.message).slice(0, 200));
      return { __error: { status: 500, message: 'The store hit an unexpected error.' } };
    }
  }

  async alarm() { await this.core.settle(); }
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname.startsWith('/api/')) {
      return route(req, {
        getStore: (storeId) => env.STORE.getByName(storeId),
        config: {
          paypalClientId: clean(env.PAYPAL_CLIENT_ID), paypalReady: Boolean(clean(env.PAYPAL_CLIENT_ID) && clean(env.PAYPAL_CLIENT_SECRET)), aiReady: Boolean(clean(env.GROQ_API_KEY)),
          storeIds: storeIdsFor(env), limit: limiter(env),
          ...webhookConfig(env),
          status: async () => { // cached per isolate for 30 s, so the public health route cannot flood the one Budget object
            if (Date.now() - statusCache.at < 30_000) return statusCache.value;
            const b = budgetOf(env); const value = b ? await b.status() : null;
            statusCache = { at: Date.now(), value };
            return value;
          },
        },
      });
    }
    return env.ASSETS.fetch(req);
  },
  // Hourly self-check (wrangler.jsonc triggers): is each outside service answering? /api/health shows the result, so a
  // break during judging is visible without anyone running a checkout.
  async scheduled(event, env, ctx) { ctx.waitUntil(selfCheck(env)); },
};

async function selfCheck(env) {
  const b = budgetOf(env);
  if (!b) return;
  try { await paypalFor(env).getOrder('TRIPWIRE-HEALTH-CHECK'); await note(b, 'paypal', true); } catch (e) {
    const ok = e && e.status === 404; // PayPal signed us in and answered: the made-up order does not exist
    await note(b, 'paypal', ok, ok ? '' : `PayPal check failed (${(e && e.status) || 'network'}).`);
  }
  try {
    // Only a failure is recorded: /models answers 200 even when chat calls are rate-limited, so a pass here must never
    // hide a real failure that the price calls recorded.
    const r = await workerFetch('https://api.groq.com/openai/v1/models', { redirect: 'error', signal: AbortSignal.timeout(10_000), headers: { Authorization: `Bearer ${clean(env.GROQ_API_KEY)}` } });
    if (!r.ok) await note(b, 'ai', false, `Groq key check answered HTTP ${r.status}.`);
  } catch { await note(b, 'ai', false, 'Groq could not be reached.'); }
  try {
    const m = await createMarket({ fetchImpl: workerFetch })(['Sony WH-1000XM5 Wireless Headphones']); // a fresh client: no cache
    const ok = [...m.values()].some((v) => v.listings.length);
    await note(b, 'market', ok, ok ? '' : 'Channel3 gave no listings.');
  } catch { await note(b, 'market', false, 'Channel3 could not be reached.'); }
}
