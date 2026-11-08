# Merchant gate: Tripwire in front of a real merchant's own PayPal checkout

**Status:** built and verified live against the PayPal sandbox (6-7 Nov 2026).

**Scope:** a real merchant's server asks Tripwire two questions, server to server:
- before it creates a PayPal order;
- before it captures the authorization.

The rules, the AI check, the breaker and the console are the existing core. The demo store flows don't change, and no code path that calls PayPal changed for the gate itself. (Since 7 Nov, "hold the capture" did change `settle`, `decideOrders` and the console decisions; see the review status in docs/API.md.)

**Third party (since 7 Nov):** for a new or changed price the AI must decide, the product **name** (never a price, a cost or anything about a buyer) is sent to Channel3, a hackathon sponsor, to look up live US retailer prices. Those prices can only add holds. If Channel3 is slow or down, the check simply runs without them.

## Design decisions (and why)

1. **Field names carry the unit.** The fields are `priceCents`, `costCents` and `amountCents`, and only JSON integers are accepted. An untyped `price` invites the 100x slip Tripwire exists to catch.
2. **The API prices a new item, or reprices one that is selling, and nothing else.**
   - It never touches an item the merchant is deciding on (held, checking, under review or tripped), even to move it back to its old price. Only the console releases, reprices or resumes those. (A price change on a tripped item would also reopen the breaker in the middle of a rush.)
   - The same price is never re-checked, so nothing else the caller sends can re-ask the AI or release a hold.
   - The latest `/check` sets the catalog price of a live item, so send the price your checkout charges right now: one price per SKU.
   - (Fixed after review F1/F4.)
2b. **A cost sent by the API is the caller's word.**
   - When the price is new or changed, the cost can add a below-cost hold for that one evaluation.
   - It never vouches for a price: a new SKU always gets the AI check. A consistent units slip ($1.10 against a cost of $0.65) would otherwise go live unseen.
   - It is never stored, and it never replaces the store's own cost.
   - (Fixed after review F2 and verification X1/X2.)
2c. **The typical price is a median over days, not over edits:** at most one history row per item per day, the first price that day. Rapid back-and-forth changes therefore can't drag the 30-day typical price down and walk a price past the AI check in small steps. This applies to every channel. (Fixed after verification X5.)
2d. **An item stuck in `checking`** for 5 minutes (its AI check was lost to a restart) is held UNVERIFIED on the next API call, instead of answering CHECKING forever. (Verification X4.)
3. **capture-check enforces the cooling window** (`coolingMs`, 20 s, counted from the check). Without it, a merchant who captures immediately would capture the first 5 orders of a bot rush before the 6th trips the breaker. `settle()` applies the same rule to demo orders.
4. **When the price changes after a check:**
   - while the item is held, checking or tripped, the answer is **wait**;
   - once the item is live again at a different price, the answer is **void**.

   Otherwise a slip imported after a good sale would void that good sale, even when the merchant then fixes the price back.
5. **Capture and void are final for a check.** A repeat call gets the same answer (`repeat: true`), so retries are safe.
5b. **One check covers one PayPal authorization:** the first `authorizationId` sent to capture-check (it is required). Any other authorization gets void OTHER_AUTHORIZATION, so a cached checkId can never clear a stream of orders past the breaker. Call `/check` once per PayPal order. (Fixed after review F5.)
6. **A hold returns `checkId: null`.** There is nothing to capture, so there is no id to misuse.
7. **The API key reveals nothing about the store id.** The store id is the console credential. The key is the store id encrypted with AES-GCM under a separate key, with a synthetic IV (an HMAC of the store id), so it can't be forged or altered and is the same every time the console shows it. (The first version carried 96 of the store id's 128 bits in plain text; fixed after review F3.)
8. **API checks get their own `checks` table,** not rows in `orders`. Orders rows drive PayPal calls in five places (settle, recoverStuck, reset, decideOrders, pendingWorkAt), and Tripwire never holds the merchant's authorization. Velocity across channels already comes from the shared `attempts` table.
9. **API SKUs are never truncated.** A 41-character SKU is a 400 error, not silently a different item.
10. **Browsers can't call the API.**
    - Every method except POST is a 405, including the CORS preflight.
    - No `Access-Control-*` header is ever sent.
    - There is no Origin check, because server clients may send one.

## API

**Integration contract:**
- Create a PayPal order only after `200` with `decision: "allow"`, and only for exactly `priceCents`.
- Capture only after `200` with `decision: "capture"`. Void on `"void"`.
- Anything else (hold, wait, 4xx, 5xx, a timeout) means do nothing yet: fail closed.
- Use an HTTP timeout of at least 30 s for `/check`, because the first time Tripwire sees a price it may wait for the AI.

### POST /api/v1/check
Headers: `Authorization: Bearer twk_<88 hex>` (the scheme is case-insensitive), `Content-Type: application/json`.
```json
{ "sku": "MX-ANKER-737", "name": "Anker 737 Power Bank 24000mAh", "priceCents": 10999,
  "costCents": 6500, "category": "Accessories", "description": "140W portable charger", "currency": "USD" }
```

| Field | Rule |
|---|---|
| sku | Required. 1-40 characters of `[A-Za-z0-9._-]`, starting with a letter or digit. |
| priceCents | Required. A JSON integer from 0 to 100,000,000. A price of 0 is held (NON_POSITIVE); a negative price is a 400. |
| name | Required the first time Tripwire sees the SKU; at most 120 characters. |
| costCents | Optional integer ≥ 0. Used only for the below-cost rule on a new or changed price, and only when the store has no cost of its own for the SKU. Never stored, and never vouches for a price. |
| category, description | Optional; at most 60 and 300 characters. |
| currency | Optional. If present, it must be `"USD"`. |

Answers:
- 200 allow: `{ "decision": "allow", "code": "ALLOWED", "checkId": "chk_…", "priceCents": 10999, "message": "…" }`
- 200 hold: `{ "decision": "hold", "code": "HELD", "checkId": null, "priceCents": 1099, "message": "…" }`

| code | When |
|---|---|
| ALLOWED | The item is live at exactly priceCents and the breaker admitted the check. |
| REVIEW | (decision `allow`) The item is under the merchant's review at exactly priceCents: soft signals only (a steep drop or an AI "suspicious"), and the AI answered. Create the order with intent AUTHORIZE. capture-check answers wait (REVIEW) until the merchant confirms the price (capture) or fixes it (void). Added 7 Nov. |
| HELD | The price is held by a rule, by the AI, or because the AI was unavailable (fail closed). This includes a price first sent by this very call. |
| UNDER_REVIEW | The item is under review at a different price. The API never reprices an item the merchant is deciding on. |
| REVIEW_FULL | The item under review already took its limit of orders (10) since the review began. Ask again after the merchant decides. |
| CHECKING | Another call's AI check of this price is still running. Ask again in a few seconds. |
| TRIPPED | The breaker is open; this call may be the one that tripped it. The merchant decides in the console. |
| SUPERSEDED | The price changed while this call's AI check ran. Ask again with the current price. |
| RESET | The store was reset during this call. Ask again. |

### POST /api/v1/capture-check
```json
{ "checkId": "chk_…", "amountCents": 10999, "authorizationId": "8AB12345CD678901E", "currency": "USD" }
```
- `checkId` is required and must match `^chk_[A-Za-z0-9-]{1,64}$`.
- `amountCents` is required: an integer > 0, the amount on the merchant's authorization.
- `authorizationId` is required and must match `^[A-Za-z0-9-]{1,64}$`. The first one sent is bound to the check (see decision 5b), and it is shown on the timeline.
- `currency` may be absent, null or `"USD"`.

All answers are 200: `{ decision, reason, checkId, priceCents, repeat, message }`. A wait also carries `retryAfterMs`.

The rows are evaluated in order, all as synchronous SQL:

| # | Condition | Answer | Stored |
|---|---|---|---|
| 1 | No such check (unknown id, or the store was reset since) | void, UNKNOWN_CHECK | nothing |
| 1b | The check is bound to a different authorizationId | void, OTHER_AUTHORIZATION | nothing (the first time, the id sent is bound) |
| 2 | The check was already answered void | void with the stored reason, `repeat: true` | unchanged |
| 3 | The check was already answered capture, same amount | capture, LIVE, `repeat: true` | unchanged |
| 4 | The check was already answered capture, different amount | void, AMOUNT_MISMATCH | the stored capture stays |
| 5 | amountCents ≠ the checked price | void, AMOUNT_MISMATCH | final void |
| 6 | The item is missing, or live or under review at another price | void, PRICE_CHANGED | final void, API_VOID event |
| 7 | The item is held, checking, under review or tripped, or the check was taken under review and the merchant has not confirmed it | wait, HELD / CHECKING / REVIEW / TRIPPED, `retryAfterMs = coolingMs` | open → waiting, API_WAIT event (first time only) |
| 8 | Live at the checked price, less than coolingMs since the check | wait, COOLING, `retryAfterMs` = the time left | nothing |
| 9 | Live at the checked price, cooling over | capture, LIVE | final capture, API_CAPTURE event |

After row 7 the merchant decides in the console:
- **Fix**, so a different price goes live: the next answer is void.
- **Confirm or Resume** at the checked price: the next answer is capture (after cooling). A check taken while the price was under review (7 Nov) waits until the merchant decides that review: Confirm returns it to the normal rules, so it captures (LIVE) once cooled; Fix moves the item to another price, so it is voided (PRICE_CHANGED). Resume does not end a review.

### GET /api/store/apikey?store=ID (console, store-id auth)
Returns `200 { "apiKey": "twk_…" }`. It is computed from the store id alone (HMAC and AES-GCM), with no Durable Object call.

### Errors
The body is `{ "error": "plain sentence" }`:
- **400:** a bad body, sku, cents, currency, checkId or authorizationId, or a new SKU with no name.
- **401:** a missing or invalid Bearer key. This is checked before the body is read.
- **404:** an unknown `/api/v1/*` path.
- **405:** any method except POST.
- **413 / 415:** the body is too large / not JSON.
- **429:** over LIMIT_API (120 calls per minute per store).
- **500:** an unexpected error.

## API key

**Derivation:**
- `apiKey = "twk_" + hex(iv) + hex(AES-GCM(K_enc, iv, storeIdBytes))`, where `iv = HMAC-SHA256(K_iv, storeId)[0..12 bytes]`. That makes 24 + 64 hex characters.
- The keys are domain-separated: `K_enc = SHA-256("tripwire-api-keys-enc:" + secret)` and `K_iv = HMAC key SHA-256("tripwire-api-keys:" + secret)`, separate from the store-id key `SHA-256("tripwire-store-ids:" + secret)`.

**Verification:**
1. Check the key against the regex.
2. AES-GCM-decrypt it. The GCM tag rejects any altered or forged key.
3. Check that the result is a validly signed store id.
4. Check that the IV is the one this store id derives, so only the key the console shows works.
5. Route to that store's Durable Object.

**What a key holder can and can't do:** the key reveals nothing about the store id, so it can't be turned into console access. A leaked key can trip breakers or push prices into review, and it can burn AI calls. Those are bounded by LIMIT_API per store, and (since 7 Nov) by one shared AI budget for the whole demo: 60 calls per store per day, 150 per network per day, 20 per minute and 800 per day overall (src/budget.mjs). Identical AI questions within 12 hours reuse the earlier answer. Past the budget, a price that needs the AI is held; the optional live-price evidence step is skipped, so the decision is the AI price check's alone. It can't release a hold or a trip, and it can't read the console.

**Not in this build:**
- per-store key revocation;
- keys that are unforgeable in local dev without the secret.

## Edge cases

| Case | Behaviour |
|---|---|
| The amount differs from the checked price | void AMOUNT_MISMATCH, final. A capture already given for the right amount stays. |
| A repeat capture-check | capture and void are repeated with `repeat: true` and no new event. A wait is re-evaluated each time. API_WAIT is emitted once per check. |
| A reset during the AI wait | The epoch is re-checked after the await → hold RESET. Nothing is recorded. |
| A reset between check and capture-check | The checks are deleted → void UNKNOWN_CHECK. The RESET event counts the discarded checks. |
| Currency other than USD | 400 on both endpoints. |
| AI outage | A new or changed price that needs the AI is held (UNVERIFIED). Known prices never call the AI and keep selling. |
| Brand-new SKU, first call | The call always waits for the AI: at most 20 s, plus up to 12 s more for the Channel3 matching call when live listings were found (about 32 s worst case). A concurrent call for the same price gets CHECKING. To avoid the wait at checkout, import the catalog once in the console. |
| Held, checking, under-review or tripped item | Hold (or, under review at exactly the asked price, allow REVIEW), whatever cost is sent. The API never reprices it, not even back to its old price; the merchant decides in the console. |
| The same checkId with a second authorization | void OTHER_AUTHORIZATION for the second one; the first stays covered. |
| The price changes during the AI wait | SUPERSEDED: the item is allowed at neither price. |
| Velocity across channels | One `attempts` window per SKU covers bot, paypal, venmo and api. |
| Tripped item | Hold TRIPPED at any price. The API never reprices or resumes it. |
| Price ≤ 0; fractional or string cents | Hold (NON_POSITIVE); a 400. |

## Acceptance criteria

| ID | Criterion |
|---|---|
| AC10 | An API check on a held, checking or tripped price answers hold with no check id. Tripwire writes no order and makes no PayPal call. The refusal is on the timeline. |
| AC11 | A new or changed API price passes the same rules and AI check before it can be allowed. With the AI down it is held. The API never releases a hold or a trip. |
| AC12 | One velocity window per SKU across API and demo channels. 25 concurrent API checks with a limit of 5 allow exactly 5, and the breaker trips once. |
| AC13 | capture-check says capture only after cooling, only while the item is live at exactly the checked price, and only for that amount. Otherwise it says void or wait as in the table. capture and void are final. |
| AC14 | The API key is per store, can't be forged or altered, and reveals nothing about the console credential. Invalid keys get 401. Browsers can't call the API (preflight 405, no CORS headers). The API has its own rate limit. |
| AC17 | Review fixes: a cost sent by the API never releases a hold or vouches for a price; the API never reprices an item under review; one check covers one authorization; negative cents are refused (tests R1-R8). |
| AC15 | `tools/merchant_example.mjs` passes live (the deployed Worker, real PayPal sandbox, real Groq, scenes A-C). Tripwire's own orders table stays empty. |
| AC16 | The existing tests and `tools/e2e_live.mjs` pass unchanged. |

The tests are in `test/merchant_gate.test.mjs`: G1-G11 (check), C1-C7 (capture-check) and H1-H5 (HTTP and keys).

## The live proof: tools/merchant_example.mjs

It plays an outside merchant's server. It imports nothing from `src/`, it makes its own PayPal sandbox calls (credentials from `tools/run_sandbox.ps1`), and it does its own `dns.setDefaultResultOrder('ipv4first')`.

- **Scene A: a normal sale is allowed and captured.**
  1. A new SKU, `MX-ANKER-737`, at $109.99: the AI vouches → allow.
  2. PayPal authorizes it.
  3. capture-check → wait COOLING.
  4. Then capture LIVE, and PayPal's capture is COMPLETED.
  5. A repeat capture-check → capture with `repeat: true`.
- **Scene B: a decimal slip is held with no PayPal order.** The same SKU at $10.99 → hold HELD by code (DECIMAL_SHIFT).
- **Scene C: the price changes after authorization, so void.**
  1. `MX-KETTLE-EKG` at $165.00 with a cost of $95 → the AI vouches (a new SKU always gets the AI check) → allow.
  2. PayPal authorizes it.
  3. A sale at $149.00 → allow.
  4. capture-check on the $165 sale → void PRICE_CHANGED, and PayPal returns VOIDED.
- **Final checks:**
  - Tripwire's `orders` is empty.
  - The timeline shows the API events.
  - There is no PAYPAL_ERROR or AI_ERROR.
  - `summary.refusedCheckouts === 1`.

## What this gate does NOT guarantee

The gate is advisory: Tripwire never touches the merchant's PayPal account, so it can only stop orders it is asked about. It protects only if the merchant's server does three things:
- asks `/check` before every PayPal order, and creates the order only on allow, for exactly `priceCents`;
- asks `/capture-check` before every capture, captures only on capture, voids on void, and keeps waiting on anything else;
- treats any Tripwire error or timeout as hold or wait, never as yes.

A merchant who captures immediately, captures without asking, ignores a hold, or fails open while Tripwire is down gets no protection for those orders.

Tripwire takes the merchant's word for the authorized amount, and it can't see whether the merchant actually captured or voided. The console shows what Tripwire told the merchant, not what PayPal did.

Other limits of this build:
- **One SKU per check, USD only.** Several units of one SKU are fine since 8 Nov: send `quantity` (1-1000) and create the PayPal order for `amountCents` = priceCents × quantity. The breaker and the review cap count units, so one order for 500 units trips the breaker like 500 orders. An order with several different SKUs needs one `/check` per SKU, and capture-check compares one SKU's amount, so such an order is not covered yet.
- **No idempotency on `/check`:** a retried check counts toward velocity.
- **Upward slips (fixed 8 Nov):** a price slipped up by exactly 10x, 100x or 1000x, or 5x or more above both the last good and the typical price, is held (`DECIMAL_SHIFT_UP`, `PRICE_SPIKE`). Every buyer would be overcharged.
- **Velocity is per SKU per store,** and it counts units.
- **PayPal webhooks cover Tripwire's own orders only.** A merchant using this API keeps its own PayPal integration, so its webhooks go to its own server; Tripwire still sees only what the merchant tells it.

## UI requests (for the UI session, not built into public/)

Everything works without these; new event kinds render with the timeline's default style.

1. **A "Connect your checkout" panel:**
   - shows the key from `/api/store/apikey`, masked, with reveal and copy;
   - lists the two endpoints with a one-line curl.
2. **Timeline styles for the new event kinds:** `API_ALLOWED` (info), `API_CAPTURE` (good), `API_VOID` (info), `API_WAIT` (hold).
3. **A catalog badge** when `apiWaiting > 0`: "N sales from your checkout wait on this decision".
4. **Count the checkout API in the summary tiles.** Seen in the live browser check on 7 Nov: after a merchant capture and a void through the API, the "Captured · Voided" tile still read $0.00, because it counts only Tripwire's own orders. The API outcomes appear only on the timeline. Either add API_CAPTURE and API_VOID totals to that tile, or label it "Tripwire checkout". Server side DONE (7 Nov): `summary.api = { capture, void, waiting }`, each `{n, cents}`.
