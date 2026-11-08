# Tripwire build plan

Tripwire is a circuit breaker at PayPal checkout. It stops a store from selling at a price nobody meant before PayPal moves the money. The price might be a typo, a bad CSV import, or a price a bot swarm finds first.

Scope is fixed. Anything not on this page is out of scope until it ships.

## How it works

1. **Price changes are checked before they go live.**
   - Code runs fixed rules first: price is zero or negative, price is below cost, a decimal shift (x10, x100 or x1000), or a steep drop against the 30-day median.
   - Groq then checks price changes the rules can't vouch for: a drop over 20%, or a SKU with no cost and no price history. It returns a verdict, the market range, a likely cause and a short explanation.
   - **The AI can only add a hold. It can never release one.** Only the merchant releases a hold.
   - If the AI is down, a price nobody can vouch for is held anyway (fail closed).
2. **Checkout gate.** This runs synchronously inside the store's Durable Object, before any call to PayPal.
   - A SKU that is held, tripped or being checked is refused, and no PayPal order is created.
   - If more than N checkouts for one SKU arrive inside the window, the SKU trips and later checkouts are refused.
   - The price always comes from the server, never from the client.
3. **Money is authorized, not captured.**
   - Orders use `intent: AUTHORIZE`.
   - Settlement runs on the DO alarm after a cooling window. It captures if the SKU is live and the order's amount equals the live price.
   - Otherwise the authorization waits for the merchant to decide: honor it (capture) or void it.
   - Every PayPal ID is shown on a timeline.
4. **Per-visitor demo stores.** One DO per store id, so judges don't interfere with each other.

## Verified before writing code (sandbox, 6 Nov 2026)

- A server-side card order with `AUTHORIZE` returns 201 COMPLETED, with an authorization in CREATED status that expires in 29 days.
- Void returns VOIDED. Authorize, then capture, then refund, all return COMPLETED.

## Acceptance criteria (each one has a test)

| ID | Criterion |
|---|---|
| AC1 | A checkout on a held or tripped SKU creates no PayPal order, and the refusal is recorded on the timeline. |
| AC2 | 25 concurrent checkouts against a live SKU with the limit set to 5 allow exactly 5. The SKU trips and the other 20 are refused. |
| AC3 | Settlement captures only when the SKU is live and the order amount equals the live price. Otherwise it waits for the merchant. Voids and captures use real PayPal calls and their IDs are stored. |
| AC4 | An AI verdict can never move a SKU to live. Bad, malformed or injected AI output causes no release. |
| AC5 | A price change the rules can't vouch for is held when the AI fails. |
| AC6 | Money is in integer cents everywhere, and the amount sent to PayPal is formatted from cents. |
| AC7 | Every PayPal POST carries a PayPal-Request-Id. A 429 is retried with backoff. Redirects are refused. debug_id is recorded. Secrets never appear in logs or responses. |
| AC8 | The live end-to-end script runs every demo scene against the real PayPal sandbox and Groq, and passes. |
| AC9 | Cross-site POSTs, oversized bodies and bad store ids are refused. All page text is rendered with textContent. |
| AC10-AC16 | The merchant gate: a real merchant's server asks Tripwire before it creates a PayPal order and before it captures. Full spec, acceptance criteria and tests are in `docs/GATE.md`. |

## Demo scenes

1. **Decimal slip.** A CSV sets the $1,299.00 TV to $129.90. A rule (decimal shift) holds it, and the AI explains the likely cause. A swarm of 25 bots gets 25 refusals and 0 PayPal orders. The merchant clicks "Fix to $1,299", a real sandbox buyer checks out with PayPal, and the order is authorized and then captured (the PayPal-button path is not yet verified by hand; the bot path is verified live).
2. **No history, no cost.** A new SKU, "AirPods Pro 2", is imported at $24.90. No rule can judge it; the AI holds it as implausible against a ~$249 market price.
3. **Slipped through.** A live SKU's price is confirmed by mistake and bots rush it. The SKU trips after 5. The 5 authorizations wait for the merchant, who voids all 5 on PayPal.

## Out of scope for this build

Coupons and stacking, multi-currency stores, real store-platform plugins, accounts and login.
