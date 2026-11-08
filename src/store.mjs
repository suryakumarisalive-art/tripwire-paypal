// StoreCore: everything a Tripwire store decides. It runs inside one Durable Object per store, over that object's SQLite
// database. Every decision (the checkout gate, the breaker, settlement) is made with synchronous SQL before any call to
// PayPal or the AI, so concurrent checkouts cannot race past the breaker: the Durable Object runs one piece of synchronous
// code at a time, and PayPal is only called after the decision is written. Anything written after an await re-checks the
// state it depends on (status, price, store epoch), because other requests may have run in between.
import { parseMoney, parseCents, formatUsd, median, MoneyError, fromPayPalValue } from './money.mjs';
import { checkPrice, RULE_DEFAULTS } from './rules.mjs';
import { combine, groundVerdict, SOFT_CODES } from './ai.mjs';
import { authorizationOf, captureIdOf, SANDBOX_BOT_CARD, PayPalError } from './paypal.mjs';
import { SEED_CATALOG } from './seed.mjs';

export const STORE_DEFAULTS = Object.freeze({
  windowMs: 60_000,      // breaker window
  maxPerWindow: 5,       // checkouts allowed for one SKU inside the window before it trips
  coolingMs: 20_000,     // an authorization waits this long before settlement may capture it
  stuckMs: 60_000,       // an order still mid-call to PayPal after this long is recovered by settlement
  checkingStuckMs: 300_000, // an item still 'checking' after this long lost its AI check (a restart mid-call)
  swarmMax: 25,
  swarmCooldownMs: 10_000,
  historyMs: 30 * 86_400_000,
  maxImportRows: 100,
  aiBatch: 25,
  reviewMax: 10,         // units an item under review may sell before the merchant decides (each order only authorized)
  honorMs: 3 * 86_400_000, // PayPal's honor period: capture within 3 days of authorizing (the authorization lasts 29)
  maxQuantity: 1000,     // units one checkout API order may ask for (the breaker still counts every unit)
  // A buyer order whose checkout page never came back: settlement asks PayPal about it after createdCheckMs, then every
  // createdRecheckMs; approved -> authorized (after the same price check), never approved after abandonMs -> abandoned.
  createdCheckMs: 10 * 60_000,
  createdRecheckMs: 3 * 3_600_000,
  abandonMs: 24 * 3_600_000,
  maxReconcile: 10,      // PayPal lookups per settlement run
});

export class StoreError extends Error { constructor(status, message) { super(message); this.status = status; } }

const SKU_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;
const clean = (s, n) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, n);
const IN_FLIGHT = "('creating','authorizing','capturing','voiding')";
const OPEN = "('authorized','awaiting_merchant')";
const CHECK_ID_RE = /^chk_[A-Za-z0-9-]{1,64}$/;
const PAYPAL_ID_RE = /^[A-Za-z0-9-]{1,64}$/;
// Whole cents from the checkout API, or a 400 naming the field.
const apiCents = (v, field) => { try { return parseCents(v); } catch (e) { throw new StoreError(400, `${field}: ${e.message}`); } };
const API_HOLD = {
  HELD: "Held: the price is held for the merchant's review. Do not create a PayPal order.",
  CHECKING: 'Held: this price is still being checked. Ask again in a few seconds.',
  TRIPPED: 'Held: the breaker for this item is open. The merchant decides in the console.',
  SUPERSEDED: 'Held: the price changed while it was being checked. Ask again with the current price.',
  RESET: 'Held: the store was reset while this price was being checked. Ask again.',
  REVIEW_FULL: "Held: enough orders already wait on the merchant's review of this price. Ask again after the merchant decides.",
  UNDER_REVIEW: "Held: this item's price is under the merchant's review at a different price. Ask with the current price.",
};

// sku.status: live (selling) | checking (AI check running; refused) | held (refused) | review (selling, but each order
// is only authorized and waits for the merchant) | tripped (breaker open; refused).
const SKU_TABLE = (name, ifNotExists = 'IF NOT EXISTS ') => `CREATE TABLE ${ifNotExists}${name} (
     sku TEXT PRIMARY KEY, name TEXT NOT NULL, category TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '',
     price_cents INTEGER NOT NULL, last_good_cents INTEGER, cost_cents INTEGER,
     status TEXT NOT NULL CHECK (status IN ('live','checking','held','review','tripped')),
     reasons TEXT NOT NULL DEFAULT '[]', ai TEXT, version INTEGER NOT NULL DEFAULT 1,
     window_start INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL, restore_cents INTEGER, review_since INTEGER)`;
const SKU_COLUMNS = 'sku, name, category, description, price_cents, last_good_cents, cost_cents, status, reasons, ai, version, window_start, updated_at, restore_cents, review_since';
const SCHEMA_VERSION = 2; // 2: sku.status allows 'review'

const SCHEMA = [
  SKU_TABLE('sku'),
  `CREATE TABLE IF NOT EXISTS price_history (sku TEXT NOT NULL, price_cents INTEGER NOT NULL, at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS price_history_sku ON price_history (sku, at)`,
  `CREATE TABLE IF NOT EXISTS attempts (sku TEXT NOT NULL, at INTEGER NOT NULL, allowed INTEGER NOT NULL, channel TEXT NOT NULL,
     price_cents INTEGER NOT NULL, last_good_cents INTEGER, code TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS attempts_sku ON attempts (sku, at)`,
  `CREATE INDEX IF NOT EXISTS attempts_allowed ON attempts (allowed)`,
  `CREATE TABLE IF NOT EXISTS orders (
     id TEXT PRIMARY KEY, sku TEXT NOT NULL, name TEXT NOT NULL, amount_cents INTEGER NOT NULL, channel TEXT NOT NULL,
     status TEXT NOT NULL, paypal_order_id TEXT, authorization_id TEXT, capture_id TEXT, debug_id TEXT, note TEXT,
     created_at INTEGER NOT NULL, authorized_at INTEGER, updated_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS orders_status ON orders (status, authorized_at)`,
  `CREATE INDEX IF NOT EXISTS orders_paypal ON orders (paypal_order_id)`,
  `CREATE INDEX IF NOT EXISTS orders_created ON orders (created_at)`,
  `CREATE INDEX IF NOT EXISTS orders_sku ON orders (sku, status)`,
  `CREATE INDEX IF NOT EXISTS orders_auth ON orders (authorization_id)`,
  `CREATE INDEX IF NOT EXISTS orders_capture ON orders (capture_id)`,
  // PayPal webhook events already applied (each event changes an order at most once; kept 30 days)
  `CREATE TABLE IF NOT EXISTS webhook_events (id TEXT PRIMARY KEY, type TEXT NOT NULL, at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, kind TEXT NOT NULL,
     sku TEXT, message TEXT NOT NULL, paypal_id TEXT, amount_cents INTEGER)`,
  `CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)`,
  // Checkout API checks (docs/GATE.md): an allowed /check on a real merchant's own checkout. Tripwire never holds the
  // merchant's PayPal authorization, so these are kept apart from orders, which drive Tripwire's own PayPal calls.
  `CREATE TABLE IF NOT EXISTS checks (id TEXT PRIMARY KEY, sku TEXT NOT NULL, name TEXT NOT NULL, price_cents INTEGER NOT NULL,
     status TEXT NOT NULL CHECK (status IN ('open','waiting','capture','void')), reason TEXT, paypal_id TEXT,
     created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS checks_sku ON checks (sku, status)`,
];
// Columns added after the first deploy; ALTER fails harmlessly when the column already exists.
// orders.review / checks.review: taken while the price was under review and not yet confirmed, so only the merchant's
// confirm (or honor) may capture them. orders.wait_reason: why an order waits for the merchant (review, tripped, held,
// price, gone, pending, paypal_error), so confirming a price captures only the orders that waited on that review.
// sku.review_since: when the current review began; kept through a trip and a resume, so the review cap cannot reset.
// attempts.units / checks.quantity: a checkout for several units counts every unit in the breaker and the review cap,
// so one order for 500 units is stopped like 500 orders.
const MIGRATIONS = ['ALTER TABLE sku ADD COLUMN restore_cents INTEGER', 'ALTER TABLE orders ADD COLUMN auth_expires TEXT',
  'ALTER TABLE sku ADD COLUMN review_since INTEGER', 'ALTER TABLE orders ADD COLUMN review INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE orders ADD COLUMN wait_reason TEXT', 'ALTER TABLE checks ADD COLUMN review INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE attempts ADD COLUMN units INTEGER NOT NULL DEFAULT 1', 'ALTER TABLE checks ADD COLUMN quantity INTEGER NOT NULL DEFAULT 1',
  'ALTER TABLE orders ADD COLUMN refunded_cents INTEGER NOT NULL DEFAULT 0', 'ALTER TABLE orders ADD COLUMN checked_at INTEGER'];
// "3 × $19.99" for a multi-unit checkout, "$19.99" for one unit.
const unitsAt = (units, cents) => (units > 1 ? `${units} × ${formatUsd(cents)} (${formatUsd(units * cents)})` : formatUsd(cents));

export class StoreCore {
  // sql: a Durable Object SqlStorage (or the test adapter). paypal: createPayPal(). reviewAi: async (rows) => reviewPrices result.
  // scheduleAlarm: async (atMs) => void, asks the host to call settle() at that time.
  // market: optional async (names) => Map(name -> { listings }), live retailer evidence for the AI check (market.mjs).
  // transaction: runs a synchronous function as one storage transaction (ctx.storage.transactionSync in the Worker).
  // matchAi: optional async (rowsWithListings) => { ok, matches: Map(sku -> [ref]) }, the titles-only matching call.
  constructor({ sql, paypal, reviewAi, market = null, matchAi = null, now = Date.now, newId = () => crypto.randomUUID(), scheduleAlarm = async () => {}, config = {}, rules = RULE_DEFAULTS, transaction = (fn) => fn() }) {
    this.sql = sql; this.paypal = paypal; this.reviewAi = reviewAi; this.market = market; this.matchAi = matchAi; this.now = now; this.newId = newId; this.transaction = transaction;
    this.scheduleAlarm = scheduleAlarm; this.cfg = { ...STORE_DEFAULTS, ...config }; this.rules = rules;
  }

  // ---------- setup ----------
  init() {
    for (const s of SCHEMA) this.sql.exec(s);
    for (const m of MIGRATIONS) { try { this.sql.exec(m); } catch { /* already applied */ } }
    if (Number(this.#meta('schema') || 1) < SCHEMA_VERSION) this.#rebuildSku();
    if (!this.#meta('seeded')) this.#seed();
  }

  // SQLite cannot change a CHECK constraint in place, so a store created before 'review' existed gets its sku table
  // rebuilt once, rows and all, in one transaction (all of it or none of it).
  #rebuildSku() {
    this.transaction(() => {
      this.sql.exec('DROP TABLE IF EXISTS sku_v2');
      this.sql.exec(SKU_TABLE('sku_v2', ''));
      this.sql.exec(`INSERT INTO sku_v2 (${SKU_COLUMNS}) SELECT ${SKU_COLUMNS} FROM sku`);
      this.sql.exec('DROP TABLE sku');
      this.sql.exec('ALTER TABLE sku_v2 RENAME TO sku');
      this.#setMeta('schema', SCHEMA_VERSION);
    });
  }

  // When settlement still has work (after a restart, for example), the time it should run; otherwise null.
  pendingWorkAt() {
    const open = this.sql.exec(`SELECT MIN(authorized_at) AS t FROM orders WHERE status = 'authorized'`).one().t;
    const stuck = this.sql.exec(`SELECT MIN(updated_at) AS t FROM orders WHERE status IN ${IN_FLIGHT}`).one().t;
    // buyer orders to ask PayPal about, and authorizations that run out (PayPal's expiration_time)
    const created = this.sql.exec("SELECT MIN(CASE WHEN checked_at IS NULL THEN created_at + ? ELSE checked_at + ? END) AS t FROM orders WHERE status = 'created'", this.cfg.createdCheckMs, this.cfg.createdRecheckMs).one().t;
    const expiries = this.sql.exec(`SELECT auth_expires FROM orders WHERE status IN ${OPEN} AND auth_expires IS NOT NULL`).toArray().map((r) => Date.parse(r.auth_expires)).filter(Number.isFinite);
    const times = [];
    if (open !== null && open !== undefined) times.push(open + this.cfg.coolingMs);
    if (stuck !== null && stuck !== undefined) times.push(stuck + this.cfg.stuckMs);
    if (created !== null && created !== undefined) times.push(created);
    if (expiries.length) times.push(Math.min(...expiries));
    return times.length ? Math.max(this.now() + 1000, Math.min(...times)) : null;
  }

  // Reset voids every open authorization on PayPal first, so no buyer's money stays reserved by a store that forgot it.
  async reset() {
    const busy = () => this.sql.exec(`SELECT COUNT(*) AS n FROM orders WHERE status IN ${IN_FLIGHT}`).one().n;
    if (busy()) throw new StoreError(409, 'PayPal calls are still in flight. Try again in a few seconds.');
    const open = this.sql.exec(`SELECT * FROM orders WHERE status IN ${OPEN}`).toArray();
    for (const o of open) this.#setOrder(o.id, { status: 'voiding' });
    await Promise.all(open.map((o) => this.#void(o)));
    const left = this.sql.exec(`SELECT COUNT(*) AS n FROM orders WHERE status IN ${OPEN}`).one().n;
    if (left || busy()) throw new StoreError(409, `Could not release ${left || 'some'} authorization(s) on PayPal. Try again.`);
    // API checks hold no authorization of Tripwire's, so a reset never waits on them; capture-check answers void after.
    const discarded = this.sql.exec("SELECT COUNT(*) AS n FROM checks WHERE status IN ('open','waiting')").one().n;
    const epoch = this.#epoch() + 1; const route = this.#meta('route');
    for (const t of ['sku', 'price_history', 'attempts', 'orders', 'checks', 'events', 'meta', 'webhook_events']) this.sql.exec(`DELETE FROM ${t}`);
    this.#setMeta('epoch', epoch);
    if (route) this.#setMeta('route', route);
    this.#setMeta('schema', SCHEMA_VERSION);
    this.#seed();
    const api = discarded ? ` ${discarded} checkout API check${discarded === 1 ? ' was' : 's were'} discarded; capture-check now answers void for ${discarded === 1 ? 'it' : 'them'}.` : '';
    this.#event('RESET', null, (open.length ? `Demo store reset. ${open.length} open authorization${open.length === 1 ? ' was' : 's were'} voided on PayPal first.` : 'Demo store reset to its starting catalog.') + api);
    return { voided: open.length };
  }

  #seed() {
    const now = this.now();
    for (const item of SEED_CATALOG) {
      this.sql.exec(`INSERT INTO sku (sku, name, category, description, price_cents, last_good_cents, cost_cents, status, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'live', ?)`, item.sku, item.name, item.category, item.description, item.priceCents, item.priceCents, item.costCents ?? null, now);
      for (const [daysAgo, cents] of item.history) this.sql.exec('INSERT INTO price_history (sku, price_cents, at) VALUES (?, ?, ?)', item.sku, cents, now - daysAgo * 86_400_000);
    }
    this.#setMeta('seeded', '1');
  }

  #meta(k) { const r = this.sql.exec('SELECT v FROM meta WHERE k = ?', k).toArray(); return r.length ? r[0].v : null; }
  #setMeta(k, v) { this.sql.exec('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v', k, String(v)); }
  #epoch() { return Number(this.#meta('epoch') || 0); }

  #event(kind, sku, message, paypalId = null, amountCents = null) {
    this.sql.exec('INSERT INTO events (at, kind, sku, message, paypal_id, amount_cents) VALUES (?, ?, ?, ?, ?, ?)', this.now(), kind, sku, message, paypalId, amountCents);
  }

  #sku(sku) {
    const r = this.sql.exec('SELECT * FROM sku WHERE sku = ?', sku).toArray();
    return r.length ? r[0] : null;
  }

  #median(sku) {
    const since = this.now() - this.cfg.historyMs;
    return median(this.sql.exec('SELECT price_cents FROM price_history WHERE sku = ? AND at >= ?', sku, since).toArray().map((r) => r.price_cents));
  }

  async #schedule(at) {
    try { await this.scheduleAlarm(at); } catch { this.#event('ALARM_ERROR', null, 'Could not schedule settlement; it will run on the next action.'); }
  }

  // ---------- reads ----------
  catalog() {
    const awaiting = new Map(this.sql.exec("SELECT sku, COUNT(*) AS n FROM orders WHERE status = 'awaiting_merchant' GROUP BY sku").toArray().map((r) => [r.sku, r.n]));
    // sales on the merchant's own checkout told to wait on this item's decision (open checks are not counted: an
    // abandoned checkout stays open forever)
    // ...and only while the item is still undecided: once it is live again, those sales are settled by their next poll
    const apiWaiting = new Map(this.sql.exec("SELECT c.sku, COUNT(*) AS n FROM checks c JOIN sku s ON s.sku = c.sku WHERE c.status = 'waiting' AND s.status != 'live' GROUP BY c.sku").toArray().map((r) => [r.sku, r.n]));
    return this.sql.exec('SELECT * FROM sku ORDER BY name').toArray().map((r) => ({
      sku: r.sku, name: r.name, category: r.category, description: r.description,
      priceCents: r.price_cents, lastGoodCents: r.last_good_cents, restoreCents: r.restore_cents ?? null, costCents: r.cost_cents, typicalCents: this.#median(r.sku),
      status: r.status, reasons: JSON.parse(r.reasons), ai: r.ai ? JSON.parse(r.ai) : null, version: r.version, updatedAt: r.updated_at,
      awaiting: awaiting.get(r.sku) || 0, apiWaiting: apiWaiting.get(r.sku) || 0,
    }));
  }

  publicCatalog() { // what the storefront may see
    return this.sql.exec('SELECT sku, name, category, description, price_cents, status FROM sku ORDER BY name').toArray()
      .map((c) => ({ sku: c.sku, name: c.name, category: c.category, description: c.description, priceCents: c.price_cents, available: c.status === 'live' || c.status === 'review' }));
  }

  timeline(afterSeq = 0, limit = 200) {
    return this.sql.exec('SELECT * FROM events WHERE seq > ? ORDER BY seq DESC LIMIT ?', Number(afterSeq) || 0, Math.min(500, limit)).toArray().reverse()
      .map((e) => ({ seq: e.seq, at: e.at, kind: e.kind, sku: e.sku, message: e.message, paypalId: e.paypal_id, amountCents: e.amount_cents }));
  }

  orders(limit = 100) {
    return this.sql.exec('SELECT * FROM orders ORDER BY created_at DESC LIMIT ?', Math.min(500, limit)).toArray().map((o) => ({
      id: o.id, sku: o.sku, name: o.name, amountCents: o.amount_cents, channel: o.channel, status: o.status, paypalOrderId: o.paypal_order_id,
      authorizationId: o.authorization_id, captureId: o.capture_id, debugId: o.debug_id, note: o.note, createdAt: o.created_at,
      // While money is reserved: capture by honorUntil (PayPal's 3-day honor period); the authorization ends at expiresAt.
      authorizedAt: o.authorized_at ?? null, honorUntil: o.authorized_at ? o.authorized_at + this.cfg.honorMs : null, expiresAt: o.auth_expires ?? null,
      waitReason: o.status === 'awaiting_merchant' ? (o.wait_reason ?? null) : null, // review tripped held price gone pending paypal_error
    }));
  }

  summary() {
    // a REVIEW_FULL refusal may be a genuine sale turned away at the cap, so it never counts as loss prevented
    // every unit of a refused multi-unit checkout counts
    const SAVED = "COALESCE(SUM(CASE WHEN code != 'REVIEW_FULL' AND last_good_cents > price_cents THEN (last_good_cents - MAX(price_cents, 0)) * units ELSE 0 END), 0)";
    const refused = this.sql.exec(`SELECT COUNT(*) AS n, ${SAVED} AS saved FROM attempts WHERE allowed = 0`).one();
    const by = (st) => this.sql.exec('SELECT COUNT(*) AS n, COALESCE(SUM(amount_cents), 0) AS cents FROM orders WHERE status = ?', st).one();
    // The merchant's own checkout (the checkout API): what Tripwire told it, apart from Tripwire's own orders.
    // Waiting counts only items still undecided, like the catalog's apiWaiting.
    const api = (st) => this.sql.exec('SELECT COUNT(*) AS n, COALESCE(SUM(price_cents * quantity), 0) AS cents FROM checks WHERE status = ?', st).one();
    const waiting = this.sql.exec("SELECT COUNT(*) AS n, COALESCE(SUM(c.price_cents * c.quantity), 0) AS cents FROM checks c JOIN sku s ON s.sku = c.sku WHERE c.status = 'waiting' AND s.status != 'live'").one();
    // who was refused: the demo's own bots, real buyers (paypal, venmo), a merchant's checkout (api) or AI agents (mcp)
    const byChannel = Object.fromEntries(this.sql.exec(`SELECT channel, COUNT(*) AS n, ${SAVED} AS saved FROM attempts WHERE allowed = 0 GROUP BY channel`).toArray().map((r) => [r.channel, { n: r.n, savedCents: r.saved }]));
    return { refusedCheckouts: refused.n, refusedByChannel: byChannel, lossPreventedCents: refused.saved, captured: by('captured'), voided: by('voided'), awaiting: by('awaiting_merchant'), authorized: by('authorized'), refunded: by('refunded'), reversed: by('reversed'), expired: by('expired'),
      api: { capture: api('capture'), void: api('void'), waiting } };
  }

  // ---------- price changes ----------
  // rows: [{ sku, name?, price, cost?, category?, description? }] from a CSV import or an edit.
  // meta: { ip } (a hash of the caller's network, from the router) for the shared AI budget's per-network cap.
  async applyPriceChanges(rows, source = 'import', meta = {}) {
    if (!Array.isArray(rows) || !rows.length) throw new StoreError(400, 'No rows to import.');
    if (rows.length > this.cfg.maxImportRows) throw new StoreError(400, `Import at most ${this.cfg.maxImportRows} rows at a time.`);
    const epoch = this.#epoch();
    const results = []; const review = [];
    // An import that lists the same SKU twice uses only its last row: one price per item per import, so every answer
    // below (rules, AI, evidence) is about exactly one price.
    const lastRow = new Map(rows.map((raw, i) => [clean(raw?.sku, 40), i]));
    for (const [i, raw] of rows.entries()) {
      const sku = clean(raw?.sku, 40);
      if (!SKU_RE.test(sku)) { results.push({ sku, error: 'SKU must be 1-40 letters, digits, dot, dash or underscore.' }); continue; }
      if (lastRow.get(sku) !== i) { results.push({ sku, error: 'This SKU appears again later in the import; only its last row is used.' }); continue; }
      let newCents; let costCents = null;
      try {
        if (source === 'api') { // the checkout API sends whole cents, never text
          newCents = parseCents(raw.priceCents);
          if (raw.costCents !== undefined && raw.costCents !== null) costCents = parseCents(raw.costCents);
        } else {
          newCents = parseMoney(raw.price);
          if (raw.cost !== undefined && raw.cost !== null && String(raw.cost).trim() !== '') costCents = parseMoney(raw.cost);
        }
      } catch (e) { results.push({ sku, error: e instanceof MoneyError ? e.message : 'Bad price.' }); continue; }
      const existing = this.#sku(sku);
      const name = clean(raw.name, 120) || existing?.name || '';
      if (!name) { results.push({ sku, error: 'A new item needs a name.' }); continue; }
      if (costCents === null && existing) costCents = existing.cost_cents;
      if (source === 'api' && existing && existing.cost_cents !== null) costCents = existing.cost_cents; // the API never overwrites a stored cost
      // A cost sent by the API counts for this one evaluation and is never stored: stored, it would vouch for the item's
      // price in a later console edit, or stay wrong after the merchant fixed the price.
      const storedCost = source === 'api' ? (existing ? existing.cost_cents : null) : costCents;
      // The same price that was never vouched for (held, checking, under review, or tripped while under review) is never
      // re-checked: the AI is not asked again (it could flip a hold) and a newly given cost cannot vouch for it. Only the
      // merchant's confirm releases it. A new cost is stored, and can still make it a below-cost hold.
      // The exception: a hold whose AI check never answered (AI down, busy or out of budget) may ask again; with no answer
      // on record there is nothing a re-check could flip.
      const aiNeverAnswered = existing && existing.status === 'held' && !existing.ai && JSON.parse(existing.reasons).some((x) => x.code === 'UNVERIFIED');
      if (existing && existing.price_cents === newCents && existing.status !== 'live' && existing.last_good_cents !== newCents && !aiNeverAnswered) {
        if (storedCost !== existing.cost_cents) this.sql.exec('UPDATE sku SET cost_cents = ?, updated_at = updated_at WHERE sku = ?', storedCost, sku);
        if (Number.isSafeInteger(costCents) && costCents > 0 && newCents < costCents && existing.status !== 'held') {
          const reasons = [...JSON.parse(existing.reasons).filter((x) => x.code !== 'VELOCITY'), { code: 'BELOW_COST', message: `${formatUsd(newCents)} is below your unit cost of ${formatUsd(costCents)}.`, source: 'rule' }];
          this.sql.exec("UPDATE sku SET status = 'held', reasons = ?, review_since = NULL, version = version + 1, updated_at = ? WHERE sku = ?", JSON.stringify(reasons), this.now(), sku);
          this.#event('PRICE_HELD', sku, `${name} at ${formatUsd(newCents)} is now held: it is below your unit cost of ${formatUsd(costCents)}.`, null, newCents);
        }
        results.push({ sku, status: this.#sku(sku).status, unchanged: true }); continue;
      }
      // Same price, same cost: nothing to re-check.
      if (existing && existing.status !== 'tripped' && existing.price_cents === newCents && existing.cost_cents === costCents && !aiNeverAnswered) { results.push({ sku, status: existing.status, unchanged: true }); continue; }
      const oldCents = existing ? (existing.last_good_cents ?? null) : null;
      let rule = checkPrice({ newCents, oldCents, costCents, medianCents: this.#median(sku) }, this.rules);
      // A cost sent by the checkout API is the caller's word: it can add a below-cost hold, but it never vouches for a
      // price with no history. A consistent units slip ($1.10 against a cost of $0.65) would otherwise go live unseen.
      if (source === 'api' && !rule.holds.length && !rule.needsAi && rule.reference === null) rule = { ...rule, needsAi: true };
      // A hard rule hold is refused at once. A soft one (a steep drop that may be a real sale) waits for the AI check,
      // which decides between review (keeps selling, capture waits) and held.
      const hard = rule.holds.some((h) => !SOFT_CODES.has(h.code));
      const status = hard ? 'held' : (rule.holds.length || rule.needsAi) ? 'checking' : 'live';
      const version = (existing?.version ?? 0) + 1;
      const lastGood = status === 'live' ? newCents : (existing?.last_good_cents ?? null);
      // restore: the price before this change, kept through a merchant's confirm, so a mistaken confirm can be undone
      const restore = status === 'live' ? null : (existing?.last_good_cents ?? null);
      const category = clean(raw.category, 60) || existing?.category || '';
      const description = clean(raw.description, 300) || existing?.description || '';
      const reasons = JSON.stringify(rule.holds.map((h) => ({ ...h, source: 'rule' })));
      const now = this.now();
      if (existing) {
        this.sql.exec(`UPDATE sku SET name = ?, category = ?, description = ?, price_cents = ?, last_good_cents = ?, restore_cents = ?, cost_cents = ?, status = ?,
          reasons = ?, ai = NULL, review_since = NULL, version = ?, window_start = ?, updated_at = ? WHERE sku = ?`,
        name, category, description, newCents, lastGood, restore, storedCost, status, reasons, version, existing.status === 'tripped' ? now : existing.window_start, now, sku);
      } else {
        this.sql.exec(`INSERT INTO sku (sku, name, category, description, price_cents, last_good_cents, restore_cents, cost_cents, status, reasons, version, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`, sku, name, category, description, newCents, lastGood, storedCost, status, reasons, version, now);
      }
      const via = source === 'edit' ? 'Edited' : source === 'api' ? 'Checkout API priced' : 'Imported';
      if (existing && existing.status === 'tripped') this.#event('RESUMED', sku, `New price for ${name}: the tripped breaker is replaced by the price check below.`);
      if (status === 'live') { this.#history(sku, newCents); this.#event('PRICE_LIVE', sku, `${via} ${name} at ${formatUsd(newCents)}. Passed every check; selling.`, null, newCents); }
      if (status === 'held') this.#event('PRICE_HELD', sku, `${via} ${name} at ${formatUsd(newCents)}. Held: ${rule.holds.map((h) => h.message).join(' ')}`, null, newCents);
      if (status === 'checking') this.#event('PRICE_CHECKING', sku, `${via} ${name} at ${formatUsd(newCents)}. Not selling until the AI check vouches for it.`, null, newCents);
      // checks taken under review at the old price stop waiting on a review that no longer exists: capture-check now
      // answers them by the normal rules (void while the price differs)
      if (existing && existing.price_cents !== newCents) this.sql.exec("UPDATE checks SET review = 0 WHERE sku = ? AND review = 1 AND price_cents = ? AND status IN ('open','waiting')", sku, existing.price_cents);
      if (status !== 'live') review.push({ sku, name, category, description, newCents, oldCents, costCents, rule, version, status });
      results.push({ sku, status });
    }
    if (!review.length) return results;

    const { verdicts, failed } = await this.#reviewInBatches(review, meta);
    if (this.#epoch() !== epoch) return results; // the store was reset while the AI was thinking: nothing below applies
    if (failed) this.#event('AI_ERROR', null, `${failed} Items the rules could not vouch for stay held.`);
    for (const r of review) {
      const current = this.#sku(r.sku);
      // Superseded by a newer change or a merchant decision: the answer was about a price that is no longer the question.
      if (!current || current.version !== r.version || current.price_cents !== r.newCents) continue;
      const v = verdicts.get(r.sku);
      const outcome = combine(r.rule, v, r.newCents);
      const aiJson = outcome.ai ? JSON.stringify(outcome.ai) : null;
      if (outcome.status === 'live' && current.status === 'checking') {
        this.sql.exec("UPDATE sku SET status = 'live', last_good_cents = price_cents, restore_cents = NULL, reasons = '[]', ai = ?, updated_at = ? WHERE sku = ? AND version = ? AND status = 'checking' AND price_cents = ?",
          aiJson, this.now(), r.sku, r.version, r.newCents);
        this.#history(r.sku, r.newCents);
        this.#event('PRICE_LIVE', r.sku, `AI check: ${outcome.ai.explanation} ${formatUsd(r.newCents)} is now selling.`, null, r.newCents);
      } else if (outcome.status === 'review' && current.status === 'checking') {
        this.sql.exec("UPDATE sku SET status = 'review', reasons = ?, ai = ?, review_since = ?, updated_at = ? WHERE sku = ? AND version = ? AND status = 'checking' AND price_cents = ?",
          JSON.stringify(outcome.reasons), aiJson, this.now(), this.now(), r.sku, r.version, r.newCents);
        this.#event('PRICE_REVIEW', r.sku, `${current.name} at ${formatUsd(r.newCents)} keeps selling, but every order waits for you before capture: ${outcome.reasons.map((x) => x.message).join(' ')} Confirm the price to capture them, or fix it to void them.`, null, r.newCents);
      } else if (outcome.status === 'held') {
        this.sql.exec("UPDATE sku SET status = 'held', reasons = ?, ai = ?, updated_at = ? WHERE sku = ? AND version = ? AND status IN ('checking','held') AND price_cents = ?",
          JSON.stringify(outcome.reasons), aiJson, this.now(), r.sku, r.version, r.newCents);
        if (current.status !== 'held' || outcome.ai) this.#event('PRICE_HELD', r.sku, `Held ${current.name} at ${formatUsd(r.newCents)}. ${outcome.reasons.filter((x) => x.source === 'ai' || x.code === 'UNVERIFIED').map((x) => x.message).join(' ') || 'Waiting for you to confirm.'}`, null, r.newCents);
      }
      const done = results.find((x) => x.sku === r.sku && !x.error); if (done) done.status = this.#sku(r.sku).status;
    }
    return results;
  }

  // The AI sees at most aiBatch rows per call; larger imports are split, and each row gets its own call's outcome.
  async #reviewInBatches(review, meta = {}) {
    const rows = review.map((r) => ({ sku: r.sku, name: r.name, category: r.category, description: r.description, newCents: r.newCents, oldCents: r.oldCents, costCents: r.costCents }));
    // Live retailer listings (Channel3) are looked up while the price call runs, only for items the AI decides (a hard
    // hold is refused already, and evidence can only tighten).
    const decide = review.filter((r) => r.status === 'checking');
    const lookup = this.market && decide.length ? this.market(decide.map((r) => r.name)).catch(() => new Map()) : Promise.resolve(new Map());
    const batches = [];
    for (let i = 0; i < rows.length; i += this.cfg.aiBatch) batches.push(rows.slice(i, i + this.cfg.aiBatch));
    // One batch at a time: the AI key has a tokens-per-minute limit, and parallel batches all hit it at once.
    const answers = [];
    for (const b of batches) answers.push(await this.reviewAi(b, meta).catch(() => ({ ok: false, error: 'AI check failed.', verdicts: new Map() })));
    const out = new Map(); let failed = null;
    batches.forEach((b, i) => {
      const a = answers[i];
      if (!a.ok) failed = a.error;
      for (const row of b) out.set(row.sku, { ok: a.ok, error: a.error, verdict: a.verdicts.get(row.sku) });
    });
    // The matching call sees titles only, separately from the price call; its matches can only add holds.
    const evidence = await lookup;
    // each row from its own review entry (never another row's price); at most 10, to stay inside the tokens-per-minute limit
    const listed = decide.map((r) => ({ sku: r.sku, name: r.name, newCents: r.newCents, listings: evidence.get(r.name)?.listings }))
      .filter((r) => r.listings?.length && out.get(r.sku)?.verdict).slice(0, 10);
    if (listed.length && this.matchAi) {
      let m = null;
      try { m = await this.matchAi(listed, meta); } catch { /* no evidence */ }
      for (const r of listed) {
        const refs = m?.ok ? m.matches.get(r.sku) : null;
        if (refs?.length) { const a = out.get(r.sku); out.set(r.sku, { ...a, verdict: groundVerdict(a.verdict, r, refs) }); }
      }
    }
    return { verdicts: out, failed };
  }

  // At most one history row per item per day, the first price that day. The 30-day typical price is then a median over
  // days, not over edits, so rapid back-and-forth changes can't drag it down and walk a price past the AI check.
  #history(sku, cents) {
    const dayStart = Math.floor(this.now() / 86_400_000) * 86_400_000;
    if (this.sql.exec('SELECT COUNT(*) AS n FROM price_history WHERE sku = ? AND at >= ?', sku, dayStart).one().n) return;
    this.sql.exec('INSERT INTO price_history (sku, price_cents, at) VALUES (?, ?, ?)', sku, cents, this.now());
  }

  // An item still 'checking' long after its AI check should have answered lost that check (the Durable Object restarted
  // mid-call). The API never reprices an item under review, so without this it would answer CHECKING forever.
  #unstick(s) {
    const reasons = [...JSON.parse(s.reasons), { code: 'UNVERIFIED', message: 'Nothing could vouch for this price yet: its AI check never finished. Import the same price again to retry the check, or confirm it to sell.', source: 'rule' }];
    this.sql.exec("UPDATE sku SET status = 'held', reasons = ?, updated_at = ? WHERE sku = ? AND status = 'checking' AND version = ?", JSON.stringify(reasons), this.now(), s.sku, s.version);
    this.#event('PRICE_HELD', s.sku, `Held ${s.name} at ${formatUsd(s.price_cents)}: its AI check never finished. Confirm it to start selling.`, null, s.price_cents);
  }

  // The merchant's one click, as the console sends it: the decision below, then PayPal for the orders it settles.
  // expectedCents: the price the merchant saw; if the price changed since, nothing happens (409).
  async decideHold(sku, action, expectedCents = null) {
    const { item, marked } = this.#resolve(sku, action, expectedCents);
    await Promise.all(marked.map((o) => (action === 'confirm' ? this.#capture(o) : this.#void(o))));
    // what PayPal actually did, not what was attempted: a failed call leaves the order waiting
    const done = (st) => marked.filter((o) => this.sql.exec('SELECT status FROM orders WHERE id = ?', o.id).one().status === st).length;
    return { ...item, captured: done('captured'), voided: done('voided'), failed: marked.length - done('captured') - done('voided') };
  }

  // The decision alone (synchronous). Orders it settles are marked capturing or voiding here; decideHold sends them
  // to PayPal, and if that never happens (a restart), settlement finishes them with the same idempotency keys.
  resolveHold(sku, action, expectedCents = null) { return this.#resolve(sku, action, expectedCents).item; }

  // The merchant's decision.
  //   held/checking/review + "confirm": sell at that price. Orders that waited on this review at exactly that price
  //     are captured (not orders waiting for another reason, such as a bot rush the breaker stopped); orders still
  //     cooling are released to normal settlement; the merchant's own checkout is told to capture its checks.
  //   held/checking/review + "fix": go back to the last good price. Every open order taken at the mistaken price is
  //     voided, and the merchant's own checkout is told to void its checks at that price.
  //   tripped + "fix": go back to the price before the mistaken change (for a wrong price that was confirmed by mistake).
  #resolve(sku, action, expectedCents = null) {
    const s = this.#sku(sku);
    if (!s) throw new StoreError(404, 'No such item.');
    if (action !== 'confirm' && action !== 'fix') throw new StoreError(400, 'Unknown action.');
    if (expectedCents !== null && expectedCents !== s.price_cents) throw new StoreError(409, `The price changed to ${formatUsd(s.price_cents)} since you looked. Check it, then decide again.`);
    const held = s.status === 'held' || s.status === 'checking' || s.status === 'review';
    if (!held && !(s.status === 'tripped' && action === 'fix')) throw new StoreError(409, s.status === 'tripped' ? 'A tripped item can be fixed to its earlier price or resumed.' : 'This item is not held.');
    let cents = s.price_cents;
    if (action === 'fix') {
      const target = held ? s.last_good_cents : (s.restore_cents ?? s.last_good_cents);
      if (!Number.isSafeInteger(target) || target <= 0 || target === s.price_cents) throw new StoreError(409, 'There is no earlier price to go back to. Import a corrected price instead.');
      cents = target;
    }
    if (cents <= 0) throw new StoreError(409, 'A price of zero or less cannot be confirmed.');
    const keepRestore = action === 'confirm' ? (s.restore_cents ?? s.last_good_cents) : null;
    this.sql.exec("UPDATE sku SET status = 'live', price_cents = ?, last_good_cents = ?, restore_cents = ?, reasons = '[]', review_since = NULL, version = version + 1, window_start = ?, updated_at = ? WHERE sku = ?",
      cents, cents, keepRestore, s.status === 'tripped' ? this.now() : s.window_start, this.now(), sku);
    this.#history(sku, cents);
    let marked; let checks;
    if (action === 'confirm') {
      marked = this.sql.exec("SELECT * FROM orders WHERE sku = ? AND status = 'awaiting_merchant' AND wait_reason = 'review' AND amount_cents = ?", sku, cents).toArray();
      this.sql.exec("UPDATE orders SET review = 0 WHERE sku = ? AND status IN ('creating','created','authorizing','authorized') AND review = 1 AND amount_cents = ?", sku, cents);
      // the merchant's own checks at this price follow the normal rules from now on: capture LIVE once cooled
      checks = this.sql.exec("SELECT COUNT(*) AS n FROM checks WHERE sku = ? AND review = 1 AND price_cents = ? AND status IN ('open','waiting')", sku, cents).one().n;
      this.sql.exec("UPDATE checks SET review = 0, updated_at = ? WHERE sku = ? AND review = 1 AND price_cents = ? AND status IN ('open','waiting')", this.now(), sku, cents);
    } else {
      marked = this.sql.exec(`SELECT * FROM orders WHERE sku = ? AND status IN ${OPEN} AND amount_cents = ?`, sku, s.price_cents).toArray();
      // checks at the mistaken price: the item now sells at another price, so capture-check answers void (PRICE_CHANGED).
      // Their review flag is cleared, so they are never left waiting on a review that is over.
      checks = this.sql.exec("SELECT COUNT(*) AS n FROM checks WHERE sku = ? AND price_cents = ? AND status IN ('open','waiting')", sku, s.price_cents).one().n;
      this.sql.exec("UPDATE checks SET review = 0 WHERE sku = ? AND review = 1 AND price_cents = ? AND status IN ('open','waiting')", sku, s.price_cents);
    }
    for (const o of marked) this.#setOrder(o.id, { status: action === 'confirm' ? 'capturing' : 'voiding' });
    if (marked.length) void this.#schedule(this.now() + this.cfg.stuckMs); // if the PayPal calls below never run, settlement finishes them
    const n = marked.length; const orders = `${n} waiting order${n === 1 ? '' : 's'}`;
    const api = checks ? (action === 'confirm' ? ` Your checkout's capture-check will answer capture for ${checks} sale${checks === 1 ? '' : 's'} once the cooling window has passed.`
      : ` Your checkout's capture-check now answers void for ${checks} sale${checks === 1 ? '' : 's'}.`) : '';
    this.#event(action === 'fix' ? 'MERCHANT_FIXED' : 'MERCHANT_CONFIRMED', sku,
      (action === 'fix' ? `You restored ${s.name} to ${formatUsd(cents)}. Selling again.${n ? ` Voiding ${orders} at the mistaken ${formatUsd(s.price_cents)}.` : ''}`
        : `You confirmed ${s.name} at ${formatUsd(cents)}. Selling at that price.${n ? ` Capturing ${orders}.` : ''}`) + api, null, cents);
    return { item: this.#sku(sku), marked };
  }

  // A tripped breaker stays open until the merchant resumes it (or fixes or reprices the item). Waiting orders are untouched.
  resume(sku) {
    const s = this.#sku(sku);
    if (!s) throw new StoreError(404, 'No such item.');
    if (s.status !== 'tripped') throw new StoreError(409, 'This item\'s breaker is not tripped.');
    // An item that tripped while under review goes back to review: resuming re-arms the breaker, it does not vouch
    // for the price. (Only a confirmed price is the last good price; a review price never is.)
    const back = s.price_cents === s.last_good_cents ? 'live' : 'review';
    const reasons = back === 'review' ? JSON.parse(s.reasons).filter((r) => r.code !== 'VELOCITY') : [];
    this.sql.exec('UPDATE sku SET status = ?, reasons = ?, window_start = ?, version = version + 1, updated_at = ? WHERE sku = ?', back, JSON.stringify(reasons), this.now(), this.now(), sku);
    this.#event('RESUMED', sku, `You resumed ${s.name} at ${formatUsd(s.price_cents)}. The breaker is armed again.${back === 'review' ? ' The price is still under your review: orders wait for you before capture.' : ''}`, null, s.price_cents);
    return this.#sku(sku);
  }

  // ---------- the checkout gate (synchronous: nothing may interleave) ----------
  // The checkout decision for one SKU, shared by every channel (bot, paypal, venmo, api). Refuses held, checking and
  // tripped items, trips the breaker past maxPerWindow allowed checkouts in the window (all channels count together),
  // and records the attempt either way. askedCents: the price an API caller asked about (defaults to the item's price).
  // units: how many of the item this one checkout buys. The breaker and the review cap count units, not checkouts, so a
  // single order for 500 units is stopped exactly like 500 single orders.
  #admit(sku, channel, askedCents = null, units = 1) {
    const s = this.#sku(sku);
    if (!s) return { ok: false, code: 'UNKNOWN', message: 'No such item.' };
    const now = this.now();
    const cents = askedCents ?? s.price_cents;
    const refuse = (code, message) => {
      this.sql.exec('INSERT INTO attempts (sku, at, allowed, channel, price_cents, last_good_cents, code, units) VALUES (?, ?, 0, ?, ?, ?, ?, ?)', sku, now, channel, cents, s.last_good_cents, code, units);
      this.#event('CHECKOUT_REFUSED', sku, `${channelName(channel)} checkout for ${s.name} at ${unitsAt(units, cents)} refused before PayPal: ${message}`, null, cents * units);
      return { ok: false, code, message };
    };
    if (s.status === 'held') return refuse('HELD', 'the price is held for your review.');
    if (s.status === 'checking') return refuse('CHECKING', 'the new price is still being checked.');
    if (s.status === 'tripped') return refuse('TRIPPED', 'the breaker for this item is open.');
    // Under review, the item keeps selling, but only up to reviewMax units since the review began: a mistaken price
    // that sells slowly (below the breaker's speed) still cannot pile up authorizations while the merchant is away.
    if (s.status === 'review') { // counted from when the review began, through any trip and resume
      const taken = this.sql.exec('SELECT COALESCE(SUM(units), 0) AS n FROM attempts WHERE sku = ? AND allowed = 1 AND at >= ?', sku, s.review_since ?? s.updated_at).one().n;
      if (taken + units > this.cfg.reviewMax) {
        return refuse('REVIEW_FULL', units === 1 ? `${taken} orders already wait for your review of this price.`
          : `${units} more units would take the units waiting for your review of this price past ${this.cfg.reviewMax} (${taken} already wait).`);
      }
    }
    const since = Math.max(now - this.cfg.windowMs, s.window_start);
    const w = this.sql.exec('SELECT COUNT(*) AS n, COALESCE(SUM(units), 0) AS u FROM attempts WHERE sku = ? AND allowed = 1 AND at > ?', sku, since).one();
    if (w.u + units > this.cfg.maxPerWindow) {
      const secs = Math.round(this.cfg.windowMs / 1000);
      // all single units: the familiar "checkouts" wording; otherwise say units, and name a big single order
      const why = units === 1 && w.u === w.n ? `${w.n + 1} checkouts in under ${secs} seconds (limit ${this.cfg.maxPerWindow}).`
        : `${w.u + units} units in under ${secs} seconds (limit ${this.cfg.maxPerWindow})${units > 1 ? `, ${units} of them in one order` : ''}.`;
      // a review item keeps its review reasons under the breaker, so resuming it returns it to review
      const kept = s.status === 'review' ? JSON.parse(s.reasons) : [];
      this.sql.exec("UPDATE sku SET status = 'tripped', reasons = ?, version = version + 1, updated_at = ? WHERE sku = ?",
        JSON.stringify([{ code: 'VELOCITY', message: why, source: 'rule' }, ...kept]), now, sku);
      this.#event('BREAKER_TRIPPED', sku, `Breaker tripped on ${s.name} at ${formatUsd(s.price_cents)}: ${why} Every order already authorized waits for your decision.`, null, s.price_cents);
      return refuse('TRIPPED', 'the breaker for this item just tripped.');
    }
    this.sql.exec('INSERT INTO attempts (sku, at, allowed, channel, price_cents, last_good_cents, code, units) VALUES (?, ?, 1, ?, ?, ?, ?, ?)', sku, now, channel, cents, s.last_good_cents, 'ALLOWED', units);
    return { ok: true, s, now };
  }

  // The demo channels: an admitted checkout becomes a 'creating' order before any call to PayPal.
  gate(sku, channel) {
    const a = this.#admit(sku, channel);
    if (!a.ok) return a;
    const order = { id: this.newId(), sku, name: a.s.name, amountCents: a.s.price_cents, channel };
    this.sql.exec("INSERT INTO orders (id, sku, name, amount_cents, channel, status, review, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'creating', ?, ?, ?)",
      order.id, sku, a.s.name, a.s.price_cents, channel, a.s.status === 'review' ? 1 : 0, a.now, a.now);
    return { ok: true, order };
  }

  #orderStatus(id) { const r = this.sql.exec('SELECT status FROM orders WHERE id = ?', id).toArray(); return r.length ? r[0].status : null; }

  #setOrder(id, fields) {
    const keys = Object.keys(fields);
    const sets = [...keys.map((k) => `${k} = ?`), 'updated_at = ?'];
    this.sql.exec(`UPDATE orders SET ${sets.join(', ')} WHERE id = ?`, ...keys.map((k) => fields[k]), this.now(), id);
  }

  #paypalFailed(order, e, what) {
    const debug = e instanceof PayPalError ? e.debugId : '';
    const detail = e instanceof PayPalError ? `${e.status} ${e.paypalName}${e.issue ? ` ${e.issue}` : ''}`.trim() : 'unexpected error';
    this.#setOrder(order.id, { status: 'failed', debug_id: debug || null, note: `${what} failed: ${detail}` });
    this.#event('PAYPAL_ERROR', order.sku, `PayPal ${what} failed for ${order.name} (${detail}${debug ? `, debug_id ${debug}` : ''}).`);
  }

  // Records the outcome of a PayPal response that may carry an authorization. A CREATED authorization cools before
  // settlement; any other status (PENDING, for example) is kept for the merchant to decide, never dropped as failed.
  async #recordAuthorization(o, paypalOrderId, body) {
    const auth = authorizationOf(body);
    if (!auth) {
      this.#setOrder(o.id, { status: 'failed', paypal_order_id: paypalOrderId || null, note: `PayPal returned ${body?.status || 'no status'} without an authorization.` });
      this.#event('PAYPAL_ERROR', o.sku, `PayPal did not authorize order ${paypalOrderId || ''} (${body?.status || 'no status'}).`);
      return { ok: false, code: 'NOT_AUTHORIZED', message: 'PayPal did not authorize the payment.' };
    }
    if (auth.status !== 'CREATED') {
      this.#setOrder(o.id, { status: 'awaiting_merchant', wait_reason: 'pending', paypal_order_id: paypalOrderId, authorization_id: auth.id, note: `PayPal returned the authorization as ${auth.status}.` });
      this.#event('AWAITING_MERCHANT', o.sku, `PayPal returned authorization ${auth.id} for ${o.name} as ${auth.status}. It waits for your decision.`, auth.id, o.amountCents);
      return { ok: true, authorizationId: auth.id, paypalOrderId, pending: true };
    }
    const now = this.now();
    this.#setOrder(o.id, { status: 'authorized', paypal_order_id: paypalOrderId, authorization_id: auth.id, authorized_at: now, auth_expires: auth.expiresAt });
    this.#event('AUTHORIZED', o.sku, `${channelName(o.channel)} order for ${o.name}: PayPal reserved ${formatUsd(o.amountCents)} (authorization ${auth.id}). Nothing is captured yet.`, auth.id, o.amountCents);
    // Taken while its price was under review, and the merchant fixed or replaced that price while PayPal was answering:
    // release the buyer now instead of leaving the money reserved. (A confirm in the meantime cleared the review flag.)
    const row = this.sql.exec('SELECT * FROM orders WHERE id = ?', o.id).one();
    const s = this.#sku(o.sku);
    if (row.review && (!s || s.price_cents !== o.amountCents)) {
      this.#setOrder(o.id, { status: 'voiding' });
      await this.#void({ ...row, status: 'voiding' });
      return { ok: true, authorizationId: auth.id, paypalOrderId, voided: true };
    }
    await this.#schedule(now + this.cfg.coolingMs);
    return { ok: true, authorizationId: auth.id, paypalOrderId };
  }

  #createBody(o) {
    return { amountCents: o.amountCents, sku: o.sku, name: o.name, localOrderId: o.id, customId: this.#meta('route') || undefined, requestId: `create-${o.id}`, paymentSource: o.channel === 'bot' ? SANDBOX_BOT_CARD : undefined };
  }

  // A sandbox bot: checks out with a PayPal test card, so the order is authorized with no buyer login.
  async botCheckout(sku) {
    const g = this.gate(sku, 'bot');
    if (!g.ok) return g;
    const o = g.order;
    let r;
    try { r = await this.paypal.createOrder(this.#createBody(o)); } catch (e) { this.#paypalFailed(o, e, 'order'); return { ok: false, code: 'PAYPAL', message: 'PayPal could not create the order.' }; }
    return this.#recordAuthorization(o, r.body.id, r.body);
  }

  // A real buyer: create the PayPal order; the buyer approves it in PayPal or Venmo; then buyerApprove authorizes it.
  async buyerCreateOrder(sku, channel) {
    if (channel !== 'paypal' && channel !== 'venmo') throw new StoreError(400, 'Unknown payment method.');
    const g = this.gate(sku, channel);
    if (!g.ok) return g;
    const o = g.order;
    try {
      const r = await this.paypal.createOrder(this.#createBody(o));
      this.#setOrder(o.id, { status: 'created', paypal_order_id: r.body.id });
      this.#event('ORDER_CREATED', sku, `${channelName(channel)} buyer started checkout for ${o.name} at ${formatUsd(o.amountCents)} (PayPal order ${r.body.id}).`, r.body.id, o.amountCents);
      await this.#schedule(this.now() + this.cfg.createdCheckMs); // if the page never comes back, settlement asks PayPal
      return { ok: true, paypalOrderId: r.body.id };
    } catch (e) { this.#paypalFailed(o, e, 'order'); return { ok: false, code: 'PAYPAL', message: 'PayPal could not create the order.' }; }
  }

  async buyerApprove(paypalOrderId) {
    const rows = this.sql.exec('SELECT * FROM orders WHERE paypal_order_id = ?', String(paypalOrderId)).toArray();
    if (!rows.length) throw new StoreError(404, 'Unknown order.');
    const o = rows[0];
    if (o.status !== 'created') throw new StoreError(409, 'This order was already handled.');
    const s = this.#sku(o.sku);
    if (!s || !(s.status === 'live' || s.status === 'review') || s.price_cents !== o.amount_cents) {
      this.#setOrder(o.id, { status: 'blocked', note: 'Price changed or went under review before the payment was authorized.' });
      this.#event('CHECKOUT_REFUSED', o.sku, `Buyer approved ${o.name} at ${formatUsd(o.amount_cents)}, but the price is under review, so PayPal was never asked to reserve the money.`, o.paypal_order_id, o.amount_cents);
      return { ok: false, code: 'HELD', message: 'The seller is confirming this price. You have not been charged.' };
    }
    this.#setOrder(o.id, { status: 'authorizing' });
    const order = { id: o.id, sku: o.sku, name: o.name, amountCents: o.amount_cents, channel: o.channel };
    let r;
    try { r = await this.paypal.authorizeOrder(o.paypal_order_id, `authorize-${o.id}`); } catch (e) { this.#paypalFailed(order, e, 'authorization'); return { ok: false, code: 'PAYPAL', message: 'PayPal could not authorize the payment.' }; }
    return this.#recordAuthorization(order, o.paypal_order_id, r.body);
  }

  // ---------- the checkout API: a real merchant's own PayPal checkout asks first (docs/GATE.md) ----------
  // Before the merchant creates a PayPal order. A new or changed price goes through the same rules and AI check (and
  // waits for it); then the same synchronous gate decides. Tripwire writes no order and never calls PayPal here.
  // via: 'api' (POST /api/v1/check) or 'mcp' (an AI agent or agentic checkout through the MCP server); it only labels the
  // timeline. Both count in the same breaker window.
  // quantity: units in this one order (1 to maxQuantity); priceCents is the price of ONE unit, and capture-check then
  // expects an authorization for exactly priceCents × quantity.
  async apiCheck({ sku, name = '', priceCents, costCents = null, category = '', description = '', via = 'api', ip = '', quantity = 1 } = {}) {
    if (typeof sku !== 'string' || !SKU_RE.test(sku)) throw new StoreError(400, 'SKU must be 1-40 letters, digits, dot, dash or underscore.');
    const cents = apiCents(priceCents, 'priceCents');
    if (cents < 0) throw new StoreError(400, 'priceCents must be zero or more.');
    const qty = quantity === undefined || quantity === null ? 1 : quantity;
    if (!Number.isSafeInteger(qty) || qty < 1 || qty > this.cfg.maxQuantity) throw new StoreError(400, `quantity must be a whole number of units from 1 to ${this.cfg.maxQuantity}.`);
    const cost = costCents === null || costCents === undefined ? null : apiCents(costCents, 'costCents');
    if (cost !== null && cost < 0) throw new StoreError(400, 'costCents must be zero or more.');
    const epoch = this.#epoch();
    let existing = this.#sku(sku);
    if (existing && existing.status === 'checking' && this.now() - existing.updated_at > this.cfg.checkingStuckMs) { this.#unstick(existing); existing = this.#sku(sku); }
    // The API prices a new item, or reprices one that is selling (the merchant's checkout now charges another price).
    // It never touches an item the merchant is deciding on (held, checking or tripped): only the console releases or
    // reprices those. The same price is never re-checked, so nothing the caller sends (a cost, say) can re-ask the AI.
    // ...or retries the AI check on the same price when that check never answered (AI down, busy or out of budget).
    const retry = existing && existing.status === 'held' && existing.price_cents === cents && !existing.ai && JSON.parse(existing.reasons).some((x) => x.code === 'UNVERIFIED');
    if (!existing || (existing.status === 'live' && existing.price_cents !== cents) || retry) {
      const [r] = await this.applyPriceChanges([{ sku, name, priceCents: cents, costCents: cost, category, description }], 'api', { ip });
      if (r.error) throw new StoreError(400, r.error);
    }
    return this.#apiDecide(sku, cents, epoch, via === 'mcp' ? 'mcp' : 'api', qty); // synchronous, on the state as it is after the await
  }

  #apiDecide(sku, cents, epoch, channel = 'api', qty = 1) {
    const total = { quantity: qty, amountCents: cents * qty };
    const hold = (code) => ({ decision: 'hold', code, message: API_HOLD[code], checkId: null, priceCents: cents, ...total });
    if (this.#epoch() !== epoch) return hold('RESET');
    const s = this.#sku(sku);
    if (!s) return hold('RESET');
    if (s.status === 'live' && s.price_cents !== cents) return hold('SUPERSEDED'); // changed while this call's AI check ran
    if (s.status === 'review' && s.price_cents !== cents) return hold('UNDER_REVIEW');
    // held, checking or tripped: #admit refuses it (and records the refusal at the asked price)
    const a = this.#admit(sku, channel, cents, qty);
    const who = channel === 'mcp' ? 'An AI agent checkout (MCP)' : 'Checkout API';
    if (!a.ok) return hold(API_HOLD[a.code] ? a.code : 'HELD');
    const id = `chk_${this.newId()}`;
    this.sql.exec("INSERT INTO checks (id, sku, name, price_cents, quantity, status, review, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?)", id, sku, s.name, cents, qty, s.status === 'review' ? 1 : 0, a.now, a.now);
    const exactly = qty > 1 ? `exactly amountCents (${qty} × priceCents)` : 'exactly priceCents';
    if (s.status === 'review') {
      this.#event('API_ALLOWED', sku, `${who} may sell ${s.name} at ${unitsAt(qty, cents)} (check ${id}), but the price is under your review: capture-check answers wait until you confirm or fix it.`, null, cents * qty);
      return { decision: 'allow', code: 'REVIEW', checkId: id, priceCents: cents, ...total, message: `Allowed, but this price is under the merchant's review. Create the PayPal order for ${exactly} with intent AUTHORIZE; capture-check answers wait until the merchant confirms the price (then capture) or fixes it (then void).` };
    }
    this.#event('API_ALLOWED', sku, `${who} may sell ${s.name} at ${unitsAt(qty, cents)} (check ${id}). Nothing is captured until capture-check clears it.`, null, cents * qty);
    return { decision: 'allow', code: 'ALLOWED', checkId: id, priceCents: cents, ...total, message: `Allowed. Create the PayPal order for ${exactly}, then call capture-check before you capture.` };
  }

  // Before the merchant captures its authorization. Synchronous: no await, so nothing can interleave. The answer is
  // "capture" only after the cooling window, while the item is live at exactly the checked price, for that amount.
  // "capture" and "void" are final for a check; "wait" is re-evaluated on every call.
  captureCheck(checkId, amountCents, authorizationId = null) {
    if (typeof checkId !== 'string' || !CHECK_ID_RE.test(checkId)) throw new StoreError(400, 'checkId must be the id that /api/v1/check returned.');
    const amount = apiCents(amountCents, 'amountCents');
    if (amount <= 0) throw new StoreError(400, 'amountCents must be more than zero.');
    if (typeof authorizationId !== 'string' || !PAYPAL_ID_RE.test(authorizationId)) throw new StoreError(400, 'authorizationId is required: the id of the PayPal authorization you want to capture.');
    const auth = authorizationId;
    const rows = this.sql.exec('SELECT * FROM checks WHERE id = ?', checkId).toArray();
    if (!rows.length) return { decision: 'void', reason: 'UNKNOWN_CHECK', checkId, priceCents: null, repeat: false, message: 'Void: Tripwire has no such check (the store may have been reset). Do not capture.' };
    const c = rows[0];
    const qty = c.quantity ?? 1; const due = c.price_cents * qty; // the authorization must be for every unit, exactly
    const answer = (decision, reason, message, extra = {}) => ({ decision, reason, checkId, priceCents: c.price_cents, quantity: qty, amountCents: due, repeat: false, message, ...extra });
    // One check covers one PayPal authorization: the first one asked about. Any other is not covered (call /check
    // once per PayPal order), so a cached checkId can never clear a stream of authorizations past the breaker.
    if (c.paypal_id && c.paypal_id !== auth) {
      this.#event('API_VOID', c.sku, `Told your checkout to void authorization ${auth} for ${c.name}: check ${c.id} already covers authorization ${c.paypal_id}. Call /check once per PayPal order.`, auth, c.price_cents);
      return answer('void', 'OTHER_AUTHORIZATION', `Void: this check covers authorization ${c.paypal_id}, not ${auth}. Call /check once per PayPal order.`);
    }
    if (!c.paypal_id) { this.sql.exec('UPDATE checks SET paypal_id = ? WHERE id = ? AND paypal_id IS NULL', auth, c.id); c.paypal_id = auth; }
    if (c.status === 'void') return answer('void', c.reason, 'Void: this check was already answered void. Do not capture.', { repeat: true });
    if (c.status === 'capture') {
      if (amount === due) return answer('capture', 'LIVE', 'Capture: this check was already cleared for exactly this amount.', { repeat: true });
      return answer('void', 'AMOUNT_MISMATCH', `Void: this check was cleared for ${unitsAt(qty, c.price_cents)}, not ${formatUsd(amount)}.`);
    }
    if (amount !== due) return this.#finishCheck(c, 'void', 'AMOUNT_MISMATCH', `the authorization is for ${formatUsd(amount)}, but Tripwire checked ${unitsAt(qty, c.price_cents)}`, auth);
    const s = this.#sku(c.sku);
    if (!s) return this.#finishCheck(c, 'void', 'PRICE_CHANGED', 'the item no longer exists', auth);
    if ((s.status === 'live' || s.status === 'review') && s.price_cents !== c.price_cents) return this.#finishCheck(c, 'void', 'PRICE_CHANGED', `the item now sells at ${formatUsd(s.price_cents)}, not ${formatUsd(c.price_cents)}`, auth);
    // A check taken under review waits even if the item is live again: only the merchant's confirm (which finalizes it
    // as capture) clears it, never a route around the confirm.
    if (s.status !== 'live' || c.review) {
      const reason = s.status === 'tripped' ? 'TRIPPED' : s.status === 'checking' ? 'CHECKING' : s.status === 'review' || c.review ? 'REVIEW' : 'HELD';
      const why = reason === 'TRIPPED' ? 'its breaker tripped' : reason === 'CHECKING' ? 'its new price is still being checked'
        : reason === 'REVIEW' ? 'its price is under your review' : 'its price is held for your review';
      if (c.status === 'open') {
        this.sql.exec("UPDATE checks SET status = 'waiting', paypal_id = COALESCE(?, paypal_id), updated_at = ? WHERE id = ? AND status = 'open'", auth, this.now(), c.id);
        this.#event('API_WAIT', c.sku, `Told your checkout to wait on ${unitsAt(qty, c.price_cents)} for ${c.name}: ${why}. It is captured only if the item goes live at ${formatUsd(c.price_cents)}; fixing the price voids it.`, auth || c.paypal_id || null, due);
      }
      return answer('wait', reason, `Wait: ${why}. The merchant decides in the console; ask again later.`, { retryAfterMs: this.cfg.coolingMs });
    }
    const left = c.created_at + this.cfg.coolingMs - this.now();
    if (left > 0) return answer('wait', 'COOLING', `Wait: a sale is captured only after a ${Math.round(this.cfg.coolingMs / 1000)} s cooling window, so a bot rush trips the breaker first.`, { retryAfterMs: left });
    return this.#finishCheck(c, 'capture', 'LIVE', 'live at exactly that price', auth);
  }

  #finishCheck(c, decision, reason, why, auth) {
    const qty = c.quantity ?? 1; const due = c.price_cents * qty;
    this.sql.exec("UPDATE checks SET status = ?, reason = ?, paypal_id = COALESCE(?, paypal_id), updated_at = ? WHERE id = ? AND status IN ('open','waiting')", decision, reason, auth, this.now(), c.id);
    const pid = auth || c.paypal_id || null;
    if (decision === 'capture') {
      this.#event('API_CAPTURE', c.sku, `Cleared your checkout to capture ${unitsAt(qty, c.price_cents)} for ${c.name}${pid ? ` (authorization ${pid})` : ''}: live at exactly that price.`, pid, due);
      return { decision, reason, checkId: c.id, priceCents: c.price_cents, quantity: qty, amountCents: due, repeat: false, message: 'Capture: the item is live at exactly the checked price.' };
    }
    this.#event('API_VOID', c.sku, `Told your checkout to void ${unitsAt(qty, c.price_cents)} for ${c.name}: ${why}. The buyer is not charged once your server voids it.`, pid, due);
    return { decision, reason, checkId: c.id, priceCents: c.price_cents, quantity: qty, amountCents: due, repeat: false, message: `Void: ${why}.` };
  }

  // ---------- PayPal webhooks (the router verifies the signature with PayPal before an event gets here) ----------
  // The store's webhook route token (router: storeIds.routeFor), sent as custom_id on every PayPal order it creates.
  setRoute(token) { if (typeof token === 'string' && /^twr_[a-f0-9]{88}$/.test(token) && this.#meta('route') !== token) this.#setMeta('route', token); }

  // PayPal tells Tripwire what happened to its orders, including what happened outside Tripwire: a buyer who approved
  // but whose checkout page never came back, an authorization voided in PayPal or expired, a capture that completed
  // while Tripwire's own call lost its answer, a capture declined, refunded or reversed (a chargeback). Each event moves
  // the order to what PayPal says is true; an event id is applied at most once.
  async paypalEvent({ id, type, resource } = {}) {
    if (typeof id !== 'string' || !id || id.length > 100) throw new StoreError(400, 'The webhook event has no id.');
    if (this.sql.exec('SELECT COUNT(*) AS n FROM webhook_events WHERE id = ?', id).one().n) return { duplicate: true };
    const result = await this.#applyEvent(String(type), resource && typeof resource === 'object' ? resource : {});
    this.sql.exec('INSERT OR IGNORE INTO webhook_events (id, type, at) VALUES (?, ?, ?)', id, String(type).slice(0, 60), this.now());
    this.sql.exec('DELETE FROM webhook_events WHERE at < ?', this.now() - 30 * 86_400_000);
    return result;
  }

  async #applyEvent(type, r) {
    const find = (col, v) => (typeof v === 'string' && v ? this.sql.exec(`SELECT * FROM orders WHERE ${col} = ?`, v).toArray()[0] || null : null);
    const relatedAuth = r.supplementary_data?.related_ids?.authorization_id;
    switch (type) {
      case 'CHECKOUT.ORDER.APPROVED': {
        const o = find('paypal_order_id', r.id);
        if (!o) return { ignored: 'unknown order' };
        if (o.status !== 'created') return { unchanged: o.status };
        this.#event('PAYPAL_WEBHOOK', o.sku, `PayPal reports the buyer approved order ${o.paypal_order_id} for ${o.name}, but the checkout page never came back. Checking the price again before PayPal reserves the money.`, o.paypal_order_id, o.amount_cents);
        try {
          const a = await this.buyerApprove(o.paypal_order_id);
          return { approved: Boolean(a.ok), code: a.code || null };
        } catch (e) { if (e instanceof StoreError && e.status === 409) return { unchanged: 'already handled' }; throw e; }
      }
      case 'PAYMENT.AUTHORIZATION.VOIDED': {
        const o = find('authorization_id', r.id);
        if (!o) return { ignored: 'unknown authorization' };
        if (!['authorized', 'awaiting_merchant', 'voiding', 'capturing'].includes(o.status)) return { unchanged: o.status };
        const ours = o.status === 'voiding'; // Tripwire's own void, whose answer has not come back yet
        this.#setOrder(o.id, { status: 'voided', note: ours ? 'Voided; the buyer was never charged.' : 'Voided at PayPal outside Tripwire (in PayPal, or the authorization expired). The buyer was never charged.' });
        this.#event('VOIDED', o.sku, ours ? `PayPal confirmed the void of ${formatUsd(o.amount_cents)} for ${o.name} (authorization ${r.id}). The buyer was never charged.`
          : `PayPal reports authorization ${r.id} for ${o.name} (${formatUsd(o.amount_cents)}) was voided outside Tripwire: in PayPal, or it expired. The buyer was never charged.`, r.id, o.amount_cents);
        return { voided: o.id };
      }
      case 'PAYMENT.CAPTURE.COMPLETED':
      case 'PAYMENT.CAPTURE.PENDING': {
        const o = find('capture_id', r.id) || find('authorization_id', relatedAuth);
        if (!o) return { ignored: 'unknown capture' };
        const pending = type === 'PAYMENT.CAPTURE.PENDING';
        const note = pending ? `Captured; PayPal holds the money as pending (${String(r.status_details?.reason || 'pending').slice(0, 60)}).` : null;
        if (o.status === 'captured') {
          this.sql.exec('UPDATE orders SET capture_id = COALESCE(capture_id, ?), note = COALESCE(?, note) WHERE id = ?', String(r.id), note, o.id);
          return { unchanged: 'captured' };
        }
        if (!['capturing', 'authorized', 'awaiting_merchant'].includes(o.status)) return { unchanged: o.status };
        const outside = o.status !== 'capturing'; // nobody at Tripwire asked for this capture: it was made in PayPal
        this.#setOrder(o.id, { status: 'captured', capture_id: String(r.id), note: note || (outside ? 'Captured in PayPal, outside Tripwire.' : null) });
        this.#event('CAPTURED', o.sku, `PayPal reports capture ${r.id} of ${formatUsd(o.amount_cents)} for ${o.name}${outside ? ', made in PayPal outside Tripwire' : ''}${pending ? '; PayPal holds it as pending' : ''}.`, String(r.id), o.amount_cents);
        return { captured: o.id };
      }
      case 'PAYMENT.CAPTURE.DENIED':
      case 'PAYMENT.CAPTURE.DECLINED': {
        const o = find('capture_id', r.id) || find('authorization_id', relatedAuth);
        if (!o) return { ignored: 'unknown capture' };
        if (!['captured', 'capturing'].includes(o.status)) return { unchanged: o.status };
        this.#setOrder(o.id, { status: 'failed', note: 'PayPal declined the capture: the buyer was not charged.' });
        this.#event('PAYPAL_ERROR', o.sku, `PayPal declined capture ${r.id} of ${formatUsd(o.amount_cents)} for ${o.name}. The buyer was not charged.`, String(r.id), o.amount_cents);
        return { declined: o.id };
      }
      case 'PAYMENT.CAPTURE.REFUNDED':
      case 'PAYMENT.CAPTURE.REVERSED': {
        const capture = captureIdOf(r) || r.id;
        const o = find('capture_id', capture);
        if (!o) return { ignored: 'unknown capture' };
        if (o.status !== 'captured') return { unchanged: o.status };
        let cents = o.amount_cents - (o.refunded_cents || 0);
        try { if (r.amount?.value !== undefined) cents = Math.min(cents, fromPayPalValue(r.amount.value)); } catch { /* no usable amount: the rest of the capture */ }
        if (type === 'PAYMENT.CAPTURE.REVERSED') {
          this.#setOrder(o.id, { status: 'reversed', refunded_cents: o.amount_cents, note: 'PayPal reversed the capture (a chargeback or a reversal): the money went back to the buyer.' });
          this.#event('REVERSED', o.sku, `PayPal reversed capture ${capture} of ${formatUsd(o.amount_cents)} for ${o.name}: a chargeback or a reversal. The money went back to the buyer.`, capture, o.amount_cents);
          return { reversed: o.id };
        }
        const total = (o.refunded_cents || 0) + cents;
        const full = total >= o.amount_cents;
        this.#setOrder(o.id, { status: full ? 'refunded' : 'captured', refunded_cents: total, note: full ? 'Refunded in PayPal.' : `Partly refunded in PayPal: ${formatUsd(total)} of ${formatUsd(o.amount_cents)}.` });
        this.#event('REFUNDED', o.sku, `PayPal refunded ${formatUsd(cents)} of the ${formatUsd(o.amount_cents)} captured for ${o.name}${full ? '' : ` (${formatUsd(total)} refunded so far)`}.`, capture, cents);
        return { refunded: o.id, cents };
      }
      default: return { ignored: 'event type not used by Tripwire' };
    }
  }

  // ---------- the bot swarm ----------
  async swarm(sku, n = this.cfg.swarmMax) {
    const count = Math.max(1, Math.min(this.cfg.swarmMax, Math.floor(Number(n)) || this.cfg.swarmMax));
    const s = this.#sku(sku);
    if (!s) throw new StoreError(404, 'No such item.');
    const last = Number(this.#meta('swarm_at') || 0);
    if (this.now() - last < this.cfg.swarmCooldownMs) throw new StoreError(429, 'A swarm just ran. Wait a few seconds.');
    this.#setMeta('swarm_at', this.now());
    this.#event('SWARM', sku, `${count} bots rush ${s.name} at ${formatUsd(s.price_cents)} at the same moment.`, null, s.price_cents);
    const results = await Promise.all(Array.from({ length: count }, () => this.botCheckout(sku)));
    const authorized = results.filter((r) => r.ok).length;
    const refused = results.filter((r) => !r.ok && ['HELD', 'CHECKING', 'TRIPPED', 'REVIEW_FULL'].includes(r.code)).length;
    const failed = count - authorized - refused;
    this.#event('SWARM_DONE', sku, `Swarm over: ${refused} refused before PayPal, ${authorized} authorized and waiting${failed ? `, ${failed} failed at PayPal` : ''}. Nothing was captured.`);
    return { count, authorized, refused, failed };
  }

  // ---------- settlement (run by the Durable Object alarm) ----------
  async settle() {
    const now = this.now();
    await this.#recoverStuck(now);
    this.#expire(now);
    await this.#reconcileCreated(now);
    const due = this.sql.exec("SELECT * FROM orders WHERE status = 'authorized' AND authorized_at <= ? ORDER BY authorized_at", now - this.cfg.coolingMs).toArray();
    const capture = [];
    for (const o of due) { // decide everything before any PayPal call
      const s = this.#sku(o.sku);
      const atPrice = s && s.price_cents === o.amount_cents;
      // An order taken while its price was under review is never captured here, whatever the item's state: only the
      // merchant's confirm (which clears the flag) or honor captures it.
      if (s && s.status === 'live' && atPrice && !o.review) { this.#setOrder(o.id, { status: 'capturing' }); capture.push(o); continue; }
      const [reason, why] = !s ? ['gone', 'the item no longer exists']
        : s.status === 'tripped' ? ['tripped', 'its breaker tripped']
        : !atPrice ? ['price', `the price is now ${formatUsd(s.price_cents)}`]
        : s.status === 'review' || o.review ? ['review', 'its price is under your review (confirm it to capture, fix it to void)']
        : ['held', 'its price is held'];
      this.#setOrder(o.id, { status: 'awaiting_merchant', wait_reason: reason, note: `Not captured: ${why}.` });
      this.#event('AWAITING_MERCHANT', o.sku, `Did not capture ${formatUsd(o.amount_cents)} for ${o.name}: ${why}. The money stays reserved until you honor or void the order.`, o.authorization_id, o.amount_cents);
    }
    await Promise.all(capture.map((o) => this.#capture(o)));
    const next = this.pendingWorkAt();
    if (next !== null) await this.#schedule(next);
    return { captured: capture.length, held: due.length - capture.length };
  }

  // An authorization PayPal has let run out (its expiration_time, 29 days) can never be captured: the money went back to
  // the buyer. Waiting orders past it are marked expired, so nobody tries to honor them. (PayPal also sends a VOIDED
  // webhook at expiry; whichever comes first wins and the other changes nothing.)
  #expire(now) {
    for (const o of this.sql.exec(`SELECT * FROM orders WHERE status IN ${OPEN} AND auth_expires IS NOT NULL`).toArray()) {
      const at = Date.parse(o.auth_expires);
      if (!Number.isFinite(at) || at > now) continue;
      this.#setOrder(o.id, { status: 'expired', note: "PayPal's authorization expired before anyone captured it: the buyer's money was released and nothing was charged." });
      this.#event('EXPIRED', o.sku, `Authorization ${o.authorization_id} for ${o.name} (${formatUsd(o.amount_cents)}) expired at PayPal before a decision. The buyer was never charged.`, o.authorization_id, o.amount_cents);
    }
  }

  // Buyer orders still 'created' long after checkout began: the buyer closed PayPal's window, or approved it and the
  // checkout page never came back (a closed tab, a dropped connection). PayPal's word decides: approved is authorized
  // after the same price check as a normal approval; voided, gone or never approved for a day is abandoned (nothing
  // was ever reserved). Webhooks (CHECKOUT.ORDER.APPROVED) usually get there first; this catches a missed one.
  async #reconcileCreated(now) {
    const due = this.sql.exec("SELECT * FROM orders WHERE status = 'created' AND ((checked_at IS NULL AND created_at <= ?) OR checked_at <= ?) ORDER BY created_at LIMIT ?",
      now - this.cfg.createdCheckMs, now - this.cfg.createdRecheckMs, this.cfg.maxReconcile).toArray();
    for (const o of due) this.sql.exec('UPDATE orders SET checked_at = ? WHERE id = ?', now, o.id); // decided before any await
    const abandon = (o, why) => {
      if (this.#orderStatus(o.id) !== 'created') return;
      this.#setOrder(o.id, { status: 'abandoned', note: `${why} Nothing was reserved or charged.` });
      this.#event('ABANDONED', o.sku, `Checkout for ${o.name} at ${formatUsd(o.amount_cents)} (PayPal order ${o.paypal_order_id}) was abandoned: ${why} Nothing was reserved or charged.`, o.paypal_order_id, o.amount_cents);
    };
    await Promise.all(due.map(async (o) => {
      let body;
      try { body = (await this.paypal.getOrder(o.paypal_order_id)).body; } catch (e) {
        if (e instanceof PayPalError && e.status === 404) abandon(o, 'PayPal no longer has the order (it expired unapproved).');
        return; // PayPal busy or unreachable: asked again on the next run
      }
      if (this.#orderStatus(o.id) !== 'created') return; // the page (or a webhook) finished it while PayPal answered
      const st = String(body?.status || '');
      if (st === 'APPROVED') {
        this.#event('PAYPAL_WEBHOOK', o.sku, `PayPal shows the buyer approved order ${o.paypal_order_id} for ${o.name}, but the checkout page never came back. Checking the price again before PayPal reserves the money.`, o.paypal_order_id, o.amount_cents);
        try { await this.buyerApprove(o.paypal_order_id); } catch (e) { if (!(e instanceof StoreError)) throw e; }
      } else if (st === 'VOIDED') abandon(o, 'PayPal voided the unapproved order.');
      else if (st === 'COMPLETED' && authorizationOf(body)) { // authorized outside this checkout: never captured without the merchant
        const auth = authorizationOf(body);
        this.#setOrder(o.id, { status: 'awaiting_merchant', wait_reason: 'pending', authorization_id: auth.id, auth_expires: auth.expiresAt, note: 'PayPal shows this order authorized outside Tripwire\'s checkout. It waits for your decision.' });
        this.#event('AWAITING_MERCHANT', o.sku, `PayPal shows order ${o.paypal_order_id} for ${o.name} authorized outside Tripwire's checkout (authorization ${auth.id}). It waits for your decision.`, auth.id, o.amount_cents);
      } else if (now - o.created_at >= this.cfg.abandonMs) abandon(o, 'the buyer never approved it in PayPal.');
    }));
  }

  // Orders left mid-call to PayPal (an eviction or a deploy in the middle of a request) are finished with the same
  // idempotency keys, so PayPal returns the original result instead of acting twice.
  async #recoverStuck(now) {
    const stuck = this.sql.exec(`SELECT * FROM orders WHERE status IN ${IN_FLIGHT} AND updated_at <= ?`, now - this.cfg.stuckMs).toArray();
    for (const o of stuck) this.#setOrder(o.id, {}); // touch: a concurrent settle will not pick the same rows
    await Promise.all(stuck.map(async (o) => {
      const order = { id: o.id, sku: o.sku, name: o.name, amountCents: o.amount_cents, channel: o.channel };
      if (o.status === 'capturing') return this.#capture(o);
      if (o.status === 'voiding') return this.#void(o);
      try {
        if (o.status === 'authorizing') {
          const r = await this.paypal.authorizeOrder(o.paypal_order_id, `authorize-${o.id}`);
          return this.#recordAuthorization(order, o.paypal_order_id, r.body);
        }
        const r = await this.paypal.createOrder(this.#createBody(order)); // 'creating': same request id returns the same order
        if (o.channel === 'bot') return this.#recordAuthorization(order, r.body.id, r.body);
        this.#setOrder(o.id, { status: 'created', paypal_order_id: r.body.id });
        return null;
      } catch (e) { return this.#paypalFailed(order, e, o.status === 'authorizing' ? 'authorization' : 'order'); }
    }));
  }

  async #capture(o) {
    try {
      const r = await this.paypal.captureAuthorization(o.authorization_id, `capture-${o.id}`);
      // a PayPal webhook may have recorded this capture while the call was out: then only the id is filled in
      if (this.#orderStatus(o.id) === 'captured') { this.sql.exec('UPDATE orders SET capture_id = COALESCE(capture_id, ?) WHERE id = ?', r.body.id, o.id); return; }
      this.#setOrder(o.id, { status: 'captured', capture_id: r.body.id });
      this.#event('CAPTURED', o.sku, `Captured ${formatUsd(o.amount_cents)} for ${o.name} (capture ${r.body.id}).`, r.body.id, o.amount_cents);
    } catch (e) {
      if (this.#orderStatus(o.id) !== 'capturing') return; // settled meanwhile by a PayPal webhook (voided in PayPal, say)
      const debug = e instanceof PayPalError ? e.debugId : '';
      this.#setOrder(o.id, { status: 'awaiting_merchant', wait_reason: 'paypal_error', debug_id: debug || null, note: 'Capture did not complete at PayPal. Trying again is safe: it uses the same idempotency key.' });
      this.#event('PAYPAL_ERROR', o.sku, `Capture did not complete for ${o.name}${debug ? ` (debug_id ${debug})` : ''}. The order waits for your decision.`, o.authorization_id);
    }
  }

  // The merchant decides what happens to orders waiting on an item: "honor" captures them, "void" releases the buyer's
  // money. Only orders shown as waiting are touched; orders still cooling are left to settlement.
  // waitReason: act only on orders waiting for that reason (for example 'tripped', a bot rush), or on all when null.
  // Honor never captures an order still waiting on a price review: confirming that price is how those are captured.
  async decideOrders(sku, action, waitReason = null) {
    if (action !== 'honor' && action !== 'void') throw new StoreError(400, 'Unknown action.');
    let waiting = this.sql.exec("SELECT * FROM orders WHERE sku = ? AND status = 'awaiting_merchant'", sku).toArray();
    if (waitReason) waiting = waiting.filter((o) => o.wait_reason === waitReason);
    const underReview = action === 'honor' && waiting.some((o) => o.wait_reason === 'review');
    if (action === 'honor') waiting = waiting.filter((o) => o.wait_reason !== 'review');
    if (!waiting.length) throw new StoreError(409, underReview ? 'These orders wait on your review of the price: confirm the price to capture them, or fix it to void them.' : 'No orders are waiting on this item.');
    for (const o of waiting) this.#setOrder(o.id, { status: action === 'honor' ? 'capturing' : 'voiding' });
    await Promise.all(waiting.map((o) => (action === 'honor' ? this.#capture(o) : this.#void(o))));
    return { count: waiting.length };
  }

  async #void(o) {
    try {
      await this.paypal.voidAuthorization(o.authorization_id, `void-${o.id}`);
      if (this.#orderStatus(o.id) === 'voided') return; // a PayPal webhook already recorded this void
      this.#setOrder(o.id, { status: 'voided', note: 'Voided by the merchant; the buyer was never charged.' });
      this.#event('VOIDED', o.sku, `Voided ${formatUsd(o.amount_cents)} for ${o.name} (authorization ${o.authorization_id}). The buyer was never charged.`, o.authorization_id, o.amount_cents);
    } catch (e) {
      if (this.#orderStatus(o.id) !== 'voiding') return; // settled meanwhile by a PayPal webhook
      const debug = e instanceof PayPalError ? e.debugId : '';
      this.#setOrder(o.id, { status: 'awaiting_merchant', wait_reason: 'paypal_error', debug_id: debug || null, note: 'Void did not complete at PayPal; try again.' });
      this.#event('PAYPAL_ERROR', o.sku, `Void did not complete for ${o.name}${debug ? ` (debug_id ${debug})` : ''}. The order still waits for your decision.`, o.authorization_id);
    }
  }
}

function channelName(c) { return c === 'bot' ? 'Bot' : c === 'venmo' ? 'Venmo' : c === 'api' ? 'API' : c === 'mcp' ? 'AI agent (MCP)' : 'PayPal'; }
