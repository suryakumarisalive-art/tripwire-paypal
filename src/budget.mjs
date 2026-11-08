// One AI budget for the whole public demo, a shared cache of AI answers, and a record of when each outside service last
// worked. Every demo visitor gets a store and an API key, so a per-store limit cannot protect the one shared Groq key.
// One Durable Object (named "global") counts AI calls per minute, per day, per store per day and per IP per day, and
// refuses past the caps. A refusal fails closed for the price call: the store holds the price as unverified with an
// honest "AI busy" reason, exactly as when Groq is down. (The matching call only adds evidence, which can only tighten;
// without it a decision is the price call's alone, as when Channel3 has no listings.)
// The cache: the same question to the AI (same product, price and context) within 12 hours reuses the earlier answer.
// It keeps the demo inside Groq's free daily limits when many judges run the same presets, and it makes repeated runs
// decide the same way. This single object is a deliberate choice for a demo of this size: it is touched only on AI calls
// (at most perMinute a minute) and by health reads, which the Worker caches.
// BudgetCore is pure over a SqlStorage-shaped sql, so it runs the same in the Durable Object and in tests.
export const BUDGET_DEFAULTS = Object.freeze({ perMinute: 20, perDay: 800, perStorePerDay: 60, perIpPerDay: 150, cacheMs: 12 * 3_600_000 });
const SERVICES = ['ai', 'market', 'paypal', 'webhook']; // webhook: the last PayPal webhook delivery that verified (or failed to)

export class BudgetCore {
  constructor({ sql, now = Date.now, limits = {} }) { this.sql = sql; this.now = now; this.limits = { ...BUDGET_DEFAULTS, ...limits }; }

  init() {
    this.sql.exec('CREATE TABLE IF NOT EXISTS usage (bucket TEXT NOT NULL, key TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (bucket, key))');
    this.sql.exec('CREATE TABLE IF NOT EXISTS service (name TEXT PRIMARY KEY, ok_at INTEGER, error_at INTEGER, error TEXT)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS answers (k TEXT PRIMARY KEY, v TEXT NOT NULL, at INTEGER NOT NULL)');
  }

  #count(bucket, key) { const r = this.sql.exec('SELECT n FROM usage WHERE bucket = ? AND key = ?', bucket, key).toArray(); return r.length ? r[0].n : 0; }
  #add(bucket, key) { this.sql.exec('INSERT INTO usage (bucket, key, n) VALUES (?, ?, 1) ON CONFLICT(bucket, key) DO UPDATE SET n = n + 1', bucket, key); }

  // One AI call for this store (and caller IP, hashed), or a refusal that says which cap was hit. Synchronous.
  take(store, n = 1, ip = '') {
    const now = this.now();
    const minute = String(Math.floor(now / 60_000));
    const day = new Date(now).toISOString().slice(0, 10);
    const s = String(store || 'unknown').slice(0, 80);
    const who = String(ip || '').slice(0, 64);
    // keep only the current minute and day (the table never grows past one day of stores and IPs)
    this.sql.exec("DELETE FROM usage WHERE (bucket = 'minute' AND key != ?) OR (bucket = 'day' AND key != ?) OR (bucket IN ('store','ip') AND key NOT LIKE ?)", minute, day, `${day}:%`);
    if (this.#count('day', day) + n > this.limits.perDay) return { ok: false, reason: "the demo's shared AI budget for today is used up" };
    if (who && this.#count('ip', `${day}:${who}`) + n > this.limits.perIpPerDay) return { ok: false, reason: 'this network has used its AI checks for today' };
    if (this.#count('store', `${day}:${s}`) + n > this.limits.perStorePerDay) return { ok: false, reason: 'this demo store has used its AI checks for today' };
    if (this.#count('minute', minute) + n > this.limits.perMinute) return { ok: false, reason: 'the AI check is busy right now' };
    for (let i = 0; i < n; i++) { this.#add('day', day); this.#add('store', `${day}:${s}`); this.#add('minute', minute); if (who) this.#add('ip', `${day}:${who}`); }
    return { ok: true };
  }

  // Cached AI answers: { key: value } for the keys still fresh.
  cacheGet(keys) {
    const out = {};
    const since = this.now() - this.limits.cacheMs;
    for (const k of (Array.isArray(keys) ? keys : []).slice(0, 100)) {
      const r = this.sql.exec('SELECT v FROM answers WHERE k = ? AND at >= ?', String(k), since).toArray();
      if (r.length) { try { out[k] = JSON.parse(r[0].v); } catch { /* ignore a bad row */ } }
    }
    return out;
  }

  cachePut(entries) {
    const now = this.now();
    this.sql.exec('DELETE FROM answers WHERE at < ?', now - this.limits.cacheMs);
    for (const [k, v] of (Array.isArray(entries) ? entries : []).slice(0, 100)) {
      const text = JSON.stringify(v);
      if (typeof k === 'string' && text && text.length < 8000) this.sql.exec('INSERT INTO answers (k, v, at) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, at = excluded.at', k, text, now);
    }
  }

  // Whether a call to an outside service worked: what /api/health reports.
  record(name, ok, error = '') {
    if (!SERVICES.includes(name)) return;
    const now = this.now();
    this.sql.exec('INSERT INTO service (name) VALUES (?) ON CONFLICT(name) DO NOTHING', name);
    if (ok) this.sql.exec('UPDATE service SET ok_at = ? WHERE name = ?', now, name);
    else this.sql.exec('UPDATE service SET error_at = ?, error = ? WHERE name = ?', now, String(error || 'failed').slice(0, 160), name);
  }

  status() {
    const day = new Date(this.now()).toISOString().slice(0, 10);
    const services = Object.fromEntries(SERVICES.map((n) => [n, { lastOkAt: null, lastErrorAt: null, lastError: null }]));
    for (const r of this.sql.exec('SELECT * FROM service').toArray()) services[r.name] = { lastOkAt: r.ok_at ?? null, lastErrorAt: r.error_at ?? null, lastError: r.error ?? null };
    return { aiCallsToday: this.#count('day', day), aiCallsPerDay: this.limits.perDay, services };
  }
}

// The cache key for one AI question: a hash of exactly what the AI is shown about the row (never the SKU, which is a
// store's own label). kind: 'price' or 'match'.
export async function questionKey(kind, row) {
  const q = kind === 'match'
    ? { name: row.name, listings: (row.listings || []).map((l) => [l.ref, l.title, l.brand]) }
    : { name: row.name, category: row.category || '', description: row.description || '', newCents: row.newCents, oldCents: row.oldCents ?? null, costKnown: Number.isSafeInteger(row.costCents) };
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${kind}:${JSON.stringify(q)}`));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// One AI call through the cache and the budget. rows: the rows to ask about (each with a sku). field: 'verdicts' (the
// price call) or 'matches' (the matching call). run(rows) is the real Groq call. budget: the Budget stub, or null.
// Cached rows are answered without Groq; the rest take one budget unit and one Groq call. A refusal or a failed call
// returns { ok: false } (the store fails closed on the price call). Nothing here can turn a missing answer into one.
export async function gatedAiCall(rows, { budget, storeKey, ip = '', kind, field, run }) {
  const keys = await Promise.all(rows.map((r) => questionKey(kind, r)));
  let hits = {};
  if (budget) { try { hits = await budget.cacheGet(keys); } catch { hits = {}; } }
  const answers = new Map();
  const miss = [];
  rows.forEach((r, i) => { if (hits[keys[i]] !== undefined) answers.set(r.sku, hits[keys[i]]); else miss.push(i); });
  if (!miss.length) return { ok: true, [field]: answers, cached: rows.length };
  if (budget) {
    let t; try { t = await budget.take(storeKey, 1, ip); } catch { t = { ok: true }; } // the budget guards a quota; it does not decide prices
    if (!t.ok) return { ok: false, error: `AI check skipped: ${t.reason}.`, [field]: new Map() };
  }
  const r = await run(miss.map((i) => rows[i]));
  if (budget) { try { await budget.record('ai', r.ok, r.error); } catch { /* best effort */ } }
  if (!r.ok) return { ok: false, error: r.error, [field]: new Map() };
  const fresh = r[field] || new Map();
  const entries = [];
  for (const i of miss) { const v = fresh.get(rows[i].sku); if (v !== undefined) { answers.set(rows[i].sku, v); entries.push([keys[i], v]); } }
  if (budget && entries.length) { try { await budget.cachePut(entries); } catch { /* best effort */ } }
  return { ok: true, [field]: answers, truncated: r.truncated, cached: rows.length - miss.length };
}
