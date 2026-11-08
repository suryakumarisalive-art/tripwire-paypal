# Tripwire HTTP API (contract between the UI and the server)

All routes are same-origin JSON. A POST must send `Content-Type: application/json` from the same site; cross-site POSTs are refused with 403. Errors look like `{ "error": "plain sentence" }` and come with a 4xx or 5xx status. A 429 means slow down. All money is in **integer cents**.

## Session

| Route | Answer |
|---|---|
| `POST /api/session` with body `{}` | `{ storeId }`: a signed 32-hex id. One demo store per browser; `common.js` keeps it in localStorage under `tripwire.store`. |
| any store route with a bad or old id | `400 { error: "Missing or invalid store id…" }`. `common.js` `storeId()` then starts a new store. |

## Read

- `GET /api/health` returns `{ ok, paypal, ai, environment, checks }`. `paypal` and `ai` mean configured. `checks` is `{ aiCallsToday, aiCallsPerDay, services: { ai, market, paypal, webhook: { lastOkAt, lastErrorAt, lastError } } }`: when each outside service last worked or failed. It is refreshed by every AI call, every PayPal webhook delivery (`webhook`: the last one that verified) and an hourly self-check (cron), so a break during judging shows here.
- `GET /api/config` returns `{ paypalClientId, environment: "sandbox" }`. The client id is public and is used by the PayPal JS SDK v6.
- `GET /api/presets` returns `{ presets: [{ id, title, csv }] }`. The ids are `decimal_slip`, `new_products`, `black_friday` and `doorbuster`.
- `GET /api/store/products?store=ID` returns `{ products: [{ sku, name, category, description, priceCents, available }] }`.
- `GET /api/store/state?store=ID&after=SEQ` returns `{ catalog, summary, orders, timeline }`:

```
catalog[]:  { sku, name, category, description, priceCents, lastGoodCents, restoreCents, costCents, typicalCents,
              status: "live" | "checking" | "held" | "review" | "tripped",
                // review: keeps selling, but every order is only authorized and waits for the merchant (soft signals:
                // STEEP_DROP, AI_SUSPICIOUS). held/checking/tripped refuse checkout before PayPal.
              reasons: [{ code, message, source: "rule" | "ai" }],
              ai: { verdict, marketLowCents, marketHighCents, likelyCause, explanation } | null,
              version, updatedAt, awaiting, apiWaiting } // awaiting = orders waiting for the merchant's decision;
                                                    // apiWaiting = sales on the merchant's own checkout told to wait
summary:    { refusedCheckouts, refusedByChannel: { bot?, paypal?, venmo?, api?, mcp?: { n, savedCents } }, lossPreventedCents, captured: {n, cents}, voided: {n, cents}, awaiting: {n, cents}, authorized: {n, cents},
              refunded: {n, cents}, reversed: {n, cents}, expired: {n, cents},   // what PayPal reported (webhooks) or settlement found
              api: { capture: {n, cents}, void: {n, cents}, waiting: {n, cents} } }  // api = the merchant's own checkout (/api/v1); cents count every unit
            // lossPreventedCents and savedCents count every refused unit; a refused overcharge (a price slipped UP) is not counted
orders[]:   { id, sku, name, amountCents, channel: "bot"|"paypal"|"venmo", status, paypalOrderId, authorizationId, captureId, debugId, note, createdAt,
              authorizedAt, honorUntil, expiresAt,   // ms, ms (authorizedAt + 3 days, PayPal's honor period), ISO from PayPal or null
              waitReason }  // when awaiting_merchant: review | tripped | held | price | gone | pending | paypal_error
            status: creating | created | authorizing | authorized | awaiting_merchant | capturing | captured | voiding | voided | blocked | failed
                    | refunded | reversed   // PayPal webhook: refunded in PayPal (a partial refund stays captured; note says how much) / a chargeback or reversal
                    | expired              // the PayPal authorization ran out (29 days) before a decision: nothing was charged
                    | abandoned            // a buyer checkout never approved in PayPal: nothing was reserved
catalog[].ai.evidence (when Channel3 listings matched the item): { source: "Channel3", retailers, lowCents, highCents, offers: [{ retailer, cents, title }] }
            // live US retailer prices a titles-only matching call picked as the same product. They can only tighten the
            // price call's verdict; ai.aiVerdict is the price call's own word. The explanation leads with the live prices
            // only when they decided; otherwise it is the AI's reason followed by the live prices.
timeline[]: { seq, at, kind, sku, message, paypalId, amountCents }   // only events with seq > after; newest last
            kind: PRICE_LIVE PRICE_HELD PRICE_REVIEW PRICE_CHECKING AI_ERROR MERCHANT_CONFIRMED MERCHANT_FIXED RESUMED CHECKOUT_REFUSED
                  BREAKER_TRIPPED SWARM SWARM_DONE ORDER_CREATED AUTHORIZED AWAITING_MERCHANT CAPTURED VOIDED PAYPAL_ERROR
                  ALARM_ERROR RESET API_ALLOWED API_CAPTURE API_VOID API_WAIT
                  PAYPAL_WEBHOOK REFUNDED REVERSED EXPIRED ABANDONED   // what happened at PayPal, outside Tripwire (see the end)
            // VOIDED and CAPTURED can now also come from a PayPal webhook; their message says "outside Tripwire" when they did.
            // reasons[].code adds DECIMAL_SHIFT_UP and PRICE_SPIKE: a price slipped UP (every buyer overcharged), always held.
```

- `GET /api/store/apikey?store=ID` returns `{ apiKey }`: the store's checkout API key, `twk_` followed by 88 hex characters. Show it masked, with reveal and copy. It is not the store id and does not open the console.

## Merchant actions (POST, `?store=ID`)

| Route | Body | Answer |
|---|---|---|
| `/api/store/import` | `{ csv }` (header `sku,name,price[,cost,category,description]`, up to 100 rows, 64 KB) | `{ results: [{ sku, status? , unchanged?, error? }] }` |
| `/api/store/price` | `{ sku, price }` | same as import |
| `/api/store/hold` | `{ sku, action: "fix" \| "confirm", priceCents? }` | the item plus `{ captured, voided, failed }` (what PayPal actually did). `priceCents` is the price the merchant saw: if it changed since, 409 and nothing happens (send it always; it is optional only for older consoles). Works on held, checking and review items. `confirm`: sell at that price; capture the orders that waited on this review at exactly that price (not orders waiting for another reason, such as a bot rush the breaker stopped); the merchant's own checkout is told capture. `fix`: back to the last good price (for a tripped item, `restoreCents`); void every open order taken at the mistaken price; the merchant's own checkout is told void. |
| `/api/store/resume` | `{ sku }` | the item. A tripped item goes live at its current price, or back to review if that price was never confirmed. |
| `/api/store/decide` | `{ sku, action: "void" \| "honor", waitReason? }` | `{ count }`. Acts only on orders waiting for the merchant; `waitReason` (for example `"tripped"`, a bot rush) limits it to orders waiting for that reason. Honor never captures an order waiting on a price review (409): confirming the price does that. Honor on another group (for example a bot rush, waitReason "tripped") is the merchant's explicit decision to capture those orders at their price, even if that price was still under review. |
| `/api/store/swarm` | `{ sku, n }` (at most 25, about 10 s cooldown) | `{ count, authorized, refused, failed }` |
| `/api/store/settle` | `{}` | `{ captured, held }` (normally the alarm runs this) |
| `/api/store/reset` | `{}` | `{ voided }`. Open authorizations are voided on PayPal first; 409 while PayPal calls are in flight. |

## Buyer (POST, `?store=ID`)

| Route | Body | Answer |
|---|---|---|
| `/api/store/checkout` | `{ sku, channel: "paypal" \| "venmo" }` | `200 { ok: true, paypalOrderId }` or `409 { ok: false, code: "HELD" \| "CHECKING" \| "TRIPPED" \| "REVIEW_FULL", message }` (no PayPal order exists). An item under review checks out normally; its capture waits. |
| `/api/store/approve` | `{ paypalOrderId }` | `200 { ok: true, authorizationId }` or `409 { ok: false, code, message }` |

## Checkout API (server to server; full spec in `docs/GATE.md`)

A real merchant's server calls these before creating its own PayPal order, and again before capturing it. Auth is `Authorization: Bearer <apiKey>`. They are POST only, take no cookies and send no CORS headers, so browsers cannot call them. All amounts are whole cents in JSON numbers, and the currency is USD only.

| Route | Body | Answer (200) |
|---|---|---|
| `/api/v1/check` | `{ sku, name?, priceCents, quantity?, costCents?, category?, description?, currency? }` | `{ decision: "allow" \| "hold", code, checkId \| null, priceCents, quantity, amountCents, message }`. `priceCents` is ONE unit; `quantity` (1-1000, default 1) is units in this order, and `amountCents` = priceCents × quantity is what the PayPal order must be for. The breaker counts units, so one order for 500 units trips it like 500 orders. code is one of `ALLOWED REVIEW HELD CHECKING TRIPPED SUPERSEDED RESET REVIEW_FULL UNDER_REVIEW`. `REVIEW` is an allow: create the order with intent AUTHORIZE; capture-check waits until the merchant decides. |
| `/api/v1/capture-check` | `{ checkId, amountCents, authorizationId, currency? }` | `{ decision: "capture" \| "wait" \| "void", reason, checkId, priceCents, quantity, amountCents, repeat, message, retryAfterMs? }`. `amountCents` in the body is the whole authorization; anything but the check's priceCents × quantity is `AMOUNT_MISMATCH`. reason is one of `LIVE COOLING HELD CHECKING REVIEW TRIPPED PRICE_CHANGED AMOUNT_MISMATCH OTHER_AUTHORIZATION UNKNOWN_CHECK`. |

Errors use the usual `{ error }` shape: 400 for bad input, 401 for a bad key, 404 for an unknown route, 405 for any method but POST, and 429 when over 120 calls per minute per store.

## MCP server (AI agents and agentic checkouts; spec in `src/mcp.mjs`)

`POST /api/mcp`: Model Context Protocol, Streamable HTTP, stateless, JSON responses (protocol versions 2025-06-18 and 2025-03-26).

- **Auth:** `Authorization: Bearer <apiKey>`, the same key and rate limit as the checkout API.
- **Refused requests:** a cross-site browser `Origin` (403), GET (405: no event stream) and an unsupported `MCP-Protocol-Version` (400).
- **Methods:** `initialize`, `notifications/initialized` (202), `ping`, `tools/list`, `tools/call`.

| Tool | Arguments | Result |
|---|---|---|
| `check_price` | `{ sku, priceCents, quantity?, name?, costCents?, category?, description? }` | The `/api/v1/check` answer as `structuredContent`, plus one sentence ("ALLOW: create the PayPal order for exactly $199.00 with intent AUTHORIZE…" or "HOLD (HELD): do not create a PayPal order…"). |
| `check_capture` | `{ checkId, amountCents, authorizationId }` | The `/api/v1/capture-check` answer, plus "CAPTURE", "WAIT…" or "VOID…". |

Batches (a JSON array of up to 20 messages) are answered in order. A response or notification sent to the server gets 202. An id must be a string or an integer. A `currency` other than USD is refused. Bad tool input is an `isError` tool result the agent can read. Unknown tools and methods are JSON-RPC errors (-32602, -32601). Agent checks are labelled "AI agent (MCP)" on the timeline and count in the same breaker window as every other channel.

**Where it fits:** PayPal Agent Ready has the merchant's MCP server implement `complete_checkout`, and the UCP-with-PayPal path calls Orders v2 (intent AUTHORIZE) from the merchant's complete step. Call `check_price` there, before the order, and `check_capture` before capture. This is proven in the PayPal sandbox by `tools/mcp_agent_example.mjs`, including a real LLM agent. Real Agent Ready / ChatGPT checkout is PayPal early access and is not part of this demo.

## PayPal webhooks (PayPal to server; `src/router.mjs` paypalWebhook)

`POST /api/paypal/webhook` receives PayPal's signed events for the webhook that `tools/register_webhook.mjs` registered (its id is `vars.PAYPAL_WEBHOOK_ID` in `wrangler.jsonc`). Nobody else needs to call it.

- **Verified by PayPal, every time.** The transmission headers and the event exactly as received go to PayPal's `/v1/notifications/verify-webhook-signature`. Cheap checks come first and cost no PayPal call: the five `PAYPAL-*` headers, a certificate URL on https `paypal.com`, at most 64 KB, and a subscribed event type.
- **Routed by a token, not the store id.** Every PayPal order a store creates carries `custom_id` = the store's route token (`twr_` + 88 hex: AES-GCM of the store id under its own keys). It reveals nothing and opens nothing. A refund has no `custom_id`, so it is routed through the capture it refunds.
- **Applied once per event id:**
  - `CHECKOUT.ORDER.APPROVED`: authorizes a buyer whose checkout page never came back, after the same price check as a normal approval.
  - `PAYMENT.AUTHORIZATION.VOIDED` (voided in PayPal, or expired): the order becomes voided.
  - `PAYMENT.CAPTURE.COMPLETED` or `PENDING`: records a capture made in PayPal, or one whose answer Tripwire's own call lost.
  - `DENIED` or `DECLINED`: the order becomes failed.
  - `REFUNDED`: the order becomes refunded. A partial refund stays captured, and `note` says how much.
  - `REVERSED` (a chargeback): the order becomes reversed.
- **Answers:**
  - 200 `{ ok, ... }`: applied, or ignored (not a Tripwire order, an unknown order, a duplicate).
  - 400: not a PayPal webhook.
  - 401: the signature did not verify, or PayPal refused to verify it.
  - 503: PayPal or the store could not answer. PayPal retries non-2xx deliveries.

**When a webhook is missed,** settlement asks PayPal itself. A buyer order still `created` 10 minutes after checkout began (and then every 3 hours) is looked up with GET order:
- APPROVED: authorized after the price check.
- VOIDED, gone, or never approved for a day: `abandoned`.

Waiting authorizations past PayPal's `expiration_time` become `expired` and can no longer be honored.
