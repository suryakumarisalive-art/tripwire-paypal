# Tripwire: a circuit breaker for price mistakes at PayPal checkout

A store's own pricing mistake can sell out in minutes. A slipped decimal, a bad supplier CSV, or a new item priced wrong is enough.

- **Little Swan (Tmall, 2024):** a franchise shop listed washing machines at ¥299 instead of ¥1,699. It took **over 40,000 orders in about 20 minutes**, a potential loss of about $4.2M.
- **Other cases:** MediaWorld sold iPad Airs at €15, Digitec sold 1,299 cameras at CHF 35, and an Amazon repricer bug put items at 1p.

In each case, buyers had paid before anyone looked.

**Tripwire sits at PayPal checkout and stops that before PayPal captures any money.**

- **A clear mistake** (a slipped decimal, below cost, or what the AI calls implausible) is refused before a PayPal order even exists.
- **A deep discount that might be a real sale** keeps selling. Each order is only *authorized* (the money is reserved), and capture waits for one merchant click: **Confirm** captures them; **Reset** voids them.
- **A rush of checkouts** on one item trips a breaker. That is what deal bots, scripts and AI shopping agents do to a mispriced listing.
- **The AI can add holds but never release one.** Code rules decide first, and only the merchant releases.

**Live demo (PayPal sandbox):** https://tripwire-demo.suryakumarisalive.workers.dev
(Sandbox only. No real money moves. Every PayPal ID on screen is a real sandbox ID.)

## Try it in 60 seconds

1. **Open the console** (the link above). You get your own demo store, a fictional electronics shop with 8 real products.
2. **Import "Supplier feed with a slipped decimal".** The $1,299.00 TV comes in at $129.90 and its breaker **trips**. The reasons are labelled **CODE** (decimal shift, below cost) and **AI** (the typical market price).
   - Then import **"New products, no price history"**: AirPods at $24.90 trip on the AI's word alone. Its reason names live retailer prices from Channel3.
3. **Send 25 bots at the TV.** Its breaker has tripped, so all 25 are refused before PayPal and no PayPal order is created; PayPal's panel reads "0 of 25 bots reached PayPal". Then press and hold **Reset at $1,299.00**: the TV is back at $1,299.00 and selling again.
4. **Import "A doorbuster, 53% off"** (under *Test it your way*). It keeps selling, but under **review**: orders are authorized, not captured. Buy one in the store (**Open the store**), then click **Confirm $349.99, capture 1** in the console: the waiting payment is captured on PayPal. (Pressing and holding **Reset at $749.99** instead restores the old price and voids what waited.)
5. **Watch the timeline.** Every authorization, capture and void carries its real PayPal sandbox ID.

To pay with the PayPal button in the store, log in as a PayPal **sandbox** buyer. The login is in the Devpost testing instructions.

## What it uses

| Area | What exactly | Where |
|---|---|---|
| PayPal Orders v2 | `POST /v2/checkout/orders` with **intent AUTHORIZE** (a sandbox card `payment_source` for the demo bots), and `POST /v2/checkout/orders/{id}/authorize` for buyers | `src/paypal.mjs` |
| PayPal Payments v2 | `POST /v2/payments/authorizations/{id}/capture` and `/void`; capture or void is decided by Tripwire or the merchant | `src/paypal.mjs`, `src/store.mjs` |
| PayPal JS SDK v6 | `<paypal-button>` and `<venmo-button>` with one-time payment sessions, created server-side | `public/store.js` |
| PayPal practices | OAuth token caching, `PayPal-Request-Id` idempotency keys on every POST (create, authorize, capture, void), retries on 429/5xx, `debug_id` logged | `src/paypal.mjs` |
| AI: price check | Groq `openai/gpt-oss-120b`, JSON output validated field by field. It estimates the market range; **code decides** with fixed thresholds. It can add a hold, never release one. If it is down, prices nothing can vouch for are held. | `src/ai.mjs` |
| AI: live evidence (sponsor: **Channel3**) | Live US retailer listings from Channel3's MCP server. A separate **titles-only** matching call picks the exact product, and code uses those real prices **only to tighten** a decision. Listing text never reaches the price decision. | `src/market.mjs`, `src/ai.mjs` |
| Agent checkout (MCP) | Tripwire is itself an **MCP server** (`POST /api/mcp`) with two tools, `check_price` and `check_capture`. An AI agent or agentic checkout calls them before creating and before capturing a PayPal order. | `src/mcp.mjs` |
| Merchant gate API | `POST /api/v1/check` and `/api/v1/capture-check`: a real merchant's own PayPal checkout asks Tripwire first (multi-unit orders: `quantity`) | `docs/GATE.md` |
| PayPal webhooks | `POST /api/paypal/webhook`, every delivery checked with `/v1/notifications/verify-webhook-signature` (raw event, byte for byte). Orders follow what PayPal says happened, even outside Tripwire: a void or capture made in PayPal, an expired authorization, a refund, a chargeback reversal, a buyer who approved but whose page never came back. Settlement also asks PayPal (GET order) in case a webhook is missed. | `src/router.mjs`, `src/store.mjs` |
| Runtime | Cloudflare Workers plus one SQLite **Durable Object** per store. Every decision is synchronous SQL before any PayPal call, so a rush cannot race past the breaker. Alarms run settlement. | `src/worker.mjs`, `src/store.mjs` |

## How a price is decided

```
new price ──▶ code rules ──▶ hard hold?  (slipped decimal down or UP, below cost, zero) ──▶ HELD: checkout refused, no PayPal order
                  │
                  └─▶ AI price call (Groq) ──▶ "implausible"                    ──▶ HELD
                         │                    "suspicious", or a steep drop    ──▶ REVIEW: sells AUTHORIZE-only,
                         │                                                          capture waits for Confirm / Fix
                         └─▶ Channel3 listings ─▶ titles-only match ─▶ real prices can only make this stricter
checkout ──▶ breaker (more than 5 units a minute per item; one 500-unit order counts 500) ──▶ TRIPPED: the rest refused before PayPal
authorized ──▶ 20 s cooling ──▶ captured only if the item is still live at exactly that price; otherwise it waits for the merchant
```

## Agents: the MCP server

Agentic checkout is where a wrong price spreads fastest. One catalog feed now reaches several AI shopping surfaces, and agents buy the moment their criteria match.

PayPal's Agent Ready has the merchant implement `complete_checkout` as an MCP tool. Its UCP path has the merchant's server call Orders v2 (intent AUTHORIZE) in the complete step. Neither documents a price check before that call, and `check_price` is that check.

**Shown live** (`tools/mcp_agent_example.mjs`):
- A real LLM shopping agent (Groq tool calling) was told to buy the $1,299 TV listed at $129.90. It called `check_price`, got **HOLD**, and told its user it could not place the order.
- An agentic checkout bought a $199 item through the tools, with a real PayPal sandbox authorization and capture.
- Eight agents rushing one item tripped the breaker after 5.

Real ChatGPT / Agent Ready checkout is PayPal early access and is not part of this demo.

## Evidence it works

- **214 automated tests** (`npm test`) cover the rules, the AI parsing, every store transition, settlement, recovery, reconciliation, webhooks, multi-unit orders, the API, MCP, the AI budget and the schema migration. Each bug fix has a regression test.
- **Four live end-to-end scripts** run against the deployed Worker, the real PayPal sandbox and the real AI, and all pass:
  - `tools/e2e_live.mjs`: the demo flows, including review with real captures;
  - `tools/merchant_example.mjs`: a merchant's own server behind the gate, including multi-unit orders, a price slipped up, and one 500-unit order;
  - `tools/mcp_agent_example.mjs`: the agent checkout above;
  - `tools/webhook_live.mjs`: a void and a refund made directly in PayPal, outside Tripwire, reach Tripwire's orders through signed webhooks (16 s and 83 s in the last run), and a forged webhook is refused.
- **A sourced evaluation** (`eval/README.md`) of 30 documented price mistakes and 27 documented genuine sales:
  - On known items, Tripwire stopped 28 of 30 mistakes before capture, and turned away only 3 of 27 genuine deep sales; 4–6 more waited for one click.
  - Every miss is listed with the reason. All three are mistakes only 23–52% off, which no price rule can separate from a real sale.
  - A second eval on today's prices measures what the live Channel3 evidence adds: on that test it changed 1 decision in 64. It is reported, not hidden.
- **Two independent code reviews and a verification pass.** Every finding is fixed or documented.

## What's real and what's simulated

- **Real:** every PayPal call (sandbox), the AI calls, the Channel3 lookups, and the Durable Object state.
- **Simulated:**
  - The "bots" are server-side checkouts that use PayPal's public sandbox test card, so a rush can be shown without 25 people.
  - Fernbrook Supply is fictional, and its prices are typical US retail prices.
  - The "doorbuster" preset is illustrative, not a documented sale.

## Limits (honest)

- USD only. The demo store sells one unit per order; the merchant API and MCP take a `quantity`. Coupons and discount stacking are out of scope.
- A price slipped UP (exactly 10x, 100x or 1000x, or 5x or more above the usual price) is held, so buyers are never overcharged by a slip. Smaller rises are not checked.
- The breaker cannot tell bots from people. It trips on the 6th unit of one item within a minute, whoever is buying.
- Mistakes only 20–50% off can look like real sales. Those go to the AI, which can miss them (see the eval).
- The AI runs on a free Groq key. A shared budget protects it from abuse: 60 calls per store per day, 150 per network per day and 800 per day overall. Identical questions within 12 hours reuse the earlier answer, so repeated demo runs decide the same way. Past the budget, a price that needs the AI is held, never let through.

## Run it yourself

```
npm test                                   # 214 tests, Node 22+, no dependencies
npx wrangler dev                           # local; put PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET and GROQ_API_KEY in .dev.vars
npx wrangler secret put PAYPAL_CLIENT_ID   # then PAYPAL_CLIENT_SECRET and GROQ_API_KEY
npx wrangler deploy
node tools/e2e_live.mjs <your-worker-url>  # live checks (the Worker holds the secrets)
```

API reference: `docs/API.md`. Merchant gate spec: `docs/GATE.md`. Sources for every incident: `docs/EVIDENCE.md`.

## License

MIT. See `LICENSE`.
