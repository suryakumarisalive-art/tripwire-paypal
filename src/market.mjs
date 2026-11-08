// Live retailer prices from Channel3 (a hackathon sponsor), through its keyless MCP server (streamable HTTP, JSON-RPC).
// Tripwire asks it about each item it cannot vouch for. A separate titles-only AI call says which listings are the same
// product; the price decision never sees listing text. Everything Channel3
// returns is untrusted data: offers are filtered here, the AI only says which listings are the same product, and code
// computes the market from the real prices (see groundVerdict in ai.mjs). Never throws: a failure means "no evidence".
export const CHANNEL3_MCP = 'https://mcp.trychannel3.com/';
const PROTOCOL = '2025-06-18';
const MAX_PRODUCTS = 4;  // listings shown to the matching call per item
const MAX_OFFERS = 3;    // retailer offers kept per listing
const MAX_NAMES = 10;    // searches per lookup: an import of 100 rows gets evidence for its first 10 AI-checked items
const PARALLEL = 4;      // searches in flight at once (Workers allow few simultaneous outbound connections)
const CACHE_MAX = 500;   // names kept per isolate (oldest dropped first)
const EMPTY_MS = 300_000; // an empty answer is retried after 5 minutes, not cached for the hour
const USED = /\b(refurb|refurbished|renewed|pre-?owned|used|open[- ]box|grade [a-c]|reconditioned)\b/i;
// a US store's own domain; country-code storefronts (amazon.co.uk, bestbuy.ca, ...) price in other markets
const FOREIGN = /\.(uk|ca|de|fr|it|es|nl|au|in|jp|mx|br|ie|nz|se|ch|at|be|pl)$/i;
const HOST = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
// listing titles are third-party text that reaches a prompt: no structure characters, and nothing that reads like an order
const INJECTION = /ignore (all|any|previous|prior|the)|instruction|you are|assistant|system prompt|\bjson\b|verdict|respond with|reply with/i;

const clip = (s, n) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
const cleanTitle = (s) => clip(String(s ?? '').replace(/[{}[\]"\\`<>]/g, ' '), 80);

// Keeps only offers a shopper in the US could buy new today, at a sane price, in whole cents.
export function cleanProducts(products) {
  const out = [];
  for (const p of Array.isArray(products) ? products : []) {
    const title = cleanTitle(p?.title);
    if (!title || USED.test(title) || INJECTION.test(title)) continue;
    const brand0 = cleanTitle(Array.isArray(p.brands) ? p.brands[0]?.name : '').slice(0, 40);
    const brand = INJECTION.test(brand0) ? '' : brand0;
    const offers = [];
    for (const o of Array.isArray(p.offers) ? p.offers : []) {
      const usd = Number(o?.price?.price);
      const domain = clip(o?.domain, 60).toLowerCase().replace(/^(www|us)\./, '');
      if (!HOST.test(domain) || FOREIGN.test(domain) || o?.price?.currency !== 'USD') continue;
      if (o.condition && o.condition !== 'new') continue;
      if (o.availability && !/instock/i.test(o.availability)) continue;
      if (!Number.isFinite(usd) || usd <= 0 || usd > 100_000) continue;
      if (offers.some((x) => x.retailer === domain)) continue; // one price per retailer
      offers.push({ retailer: domain, cents: Math.round(usd * 100) });
      if (offers.length >= MAX_OFFERS) break;
    }
    if (offers.length) out.push({ ref: `L${out.length + 1}`, title, brand, offers });
    if (out.length >= MAX_PRODUCTS) break;
  }
  return out;
}

// The JSON-RPC message in a streamable-HTTP answer (plain JSON, or an SSE stream whose data events carry it).
export function rpcMessage(contentType, text) {
  if (!/text\/event-stream/i.test(contentType || '')) { try { return JSON.parse(text); } catch { return null; } }
  let msg = null;
  for (const block of String(text).split(/\r?\n\r?\n/)) {
    const data = block.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
    if (!data) continue;
    try { const j = JSON.parse(data); if (j && ('result' in j || 'error' in j)) msg = j; } catch { /* not JSON */ }
  }
  return msg;
}

// lookup(names) -> Promise<Map(name -> { listings, asOf })>, names it could not answer are left out.
// One MCP session per lookup; at most MAX_NAMES searches, PARALLEL at a time, all within timeoutMs.
export function createMarket({ fetchImpl = globalThis.fetch, url = CHANNEL3_MCP, timeoutMs = 8000, cacheMs = 3_600_000, now = Date.now, maxNames = MAX_NAMES } = {}) {
  // name -> { at, ttl, value }, per isolate: re-imports of the same item do not search again. Plain data only (never a
  // response or a promise), so sharing it across requests is safe. Insertion order makes it an LRU.
  const cache = new Map();
  const remember = (name, value) => {
    cache.delete(name);
    cache.set(name, { at: now(), ttl: value.listings.length ? cacheMs : EMPTY_MS, value });
    while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  };
  return async function lookup(names) {
    const found = new Map(); // normalized name -> value
    const todo = [];
    for (const n of new Set(names.map((x) => clip(x, 120)).filter(Boolean))) {
      const hit = cache.get(n);
      if (hit && now() - hit.at < hit.ttl) { found.set(n, hit.value); cache.delete(n); cache.set(n, hit); } else if (todo.length < maxNames) todo.push(n);
    }
    const out = new Map(); // keyed by the names exactly as the caller passed them
    const answer = () => { for (const x of names) { const v = found.get(clip(x, 120)); if (v) out.set(x, v); } return out; };
    if (!todo.length) return answer();
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    let nextId = 1;
    const post = async (body, session) => {
      const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
      if (session) { headers['mcp-session-id'] = session; headers['mcp-protocol-version'] = PROTOCOL; }
      const r = await fetchImpl(url, { method: 'POST', redirect: 'error', signal: ctl.signal, headers, body: JSON.stringify(body) });
      const text = await r.text();
      return { status: r.status, session: r.headers.get('mcp-session-id'), msg: rpcMessage(r.headers.get('content-type'), text) };
    };
    try {
      const init = await post({ jsonrpc: '2.0', id: nextId++, method: 'initialize', params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'tripwire', version: '1.0.0' } } });
      if (init.status !== 200 || !init.msg?.result) return answer();
      const session = init.session || null;
      await post({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }, session);
      const search = async (name) => {
        try {
          const id = nextId++;
          const r = await post({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'search_products', arguments: { query: name } } }, session);
          const sc = r.msg?.result?.structuredContent;
          if (r.status !== 200 || r.msg?.id !== id || !sc || r.msg.result.isError) return;
          const value = { listings: cleanProducts(sc.products), asOf: clip(sc.as_of, 40) || null };
          remember(name, value);
          found.set(name, value);
        } catch { /* this item gets no evidence */ }
      };
      const queue = [...todo];
      await Promise.all(Array.from({ length: Math.min(PARALLEL, queue.length) }, async () => { while (queue.length) await search(queue.shift()); }));
    } catch { /* Channel3 unreachable: no evidence */ } finally { clearTimeout(timer); }
    return answer();
  };
}
