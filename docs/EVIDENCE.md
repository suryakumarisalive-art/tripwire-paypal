# Evidence: why Tripwire matters (verified facts only)

Every claim below links its public source. **Don't add a claim without a source.**

## The problem is real, fast, and hits small merchants

| Incident | What happened | Source |
|---|---|---|
| Little Swan franchise shop on Tmall, Aug 2024 | Washing machines normally ¥1,699 listed at ¥299. **Over 40,000 orders in about 20 minutes**, a potential loss of about ¥30M (about $4.2M). The owner publicly begged customers to cancel. | [Oddity Central (citing SCMP)](https://www.odditycentral.com/news/small-business-stands-to-lose-4-2-million-due-to-employees-pricing-blunder.html) |
| East Fork, a small US pottery maker, 2020 | A discount applied twice for **about 4 minutes**: **2,000 orders, over $66,000 lost**. They honored the orders. (A discount mistake: Tripwire checks list prices and leaves coupons out of scope, so cite this only for how fast a pricing mistake spreads.) | [Business of Home](https://businessofhome.com/articles/a-tiny-mistake-cost-east-fork-66-000-then-customers-started-giving-the-money-back) |
| A Shopify merchant, 2025 | A promotion app set a whole collection to $7.90. **Thousands of orders**, including a $500 gift card, went unnoticed for hours. | [Rightpoint](https://www.rightpoint.com/thought/article/monitoring-for-order-anomalies-in-shopify) |
| Digitec (Switzerland) | Price and quantity swapped: "Instead of 35 cameras at 1299 francs each, we sold 1299 at 35 francs each." Sold out "within a very short time". | [bluewin.ch](https://www.bluewin.ch/en/news/digitec-customers-are-happy-about-camera-bargains-but-too-early-2816866.html) |
| MediaWorld (Italy), Nov 2025 | iPad Air at **€15 instead of €879**. Orders were paid and handed over; 11 days later the retailer asked for the devices back. | [heise](https://heise.de/-11096425) |
| OLG Frankfurt (Germany), 2024 | Court ordered delivery at the mistaken price, because the retailer had already shipped part of the order before cancelling. | [heise](https://heise.de/-9790947) |
| Amazon UK, Dec 2014 | A repricer bug put items at 1p for an hour. About 2,000 sellers were hit; some lost up to £100k. | [The Register](https://www.theregister.com/2014/12/14/amazon_retailers_hit_by_repricer_express_1p_software_flaw/) |

**The pattern:** minutes, not hours. The damage comes from letting money move and goods ship before anyone checks. Tripwire stops the order before PayPal captures.

## People and machines hunt these mistakes

- Slickdeals editors "typically see 10 to 15 good price mistakes every year", and members set keyword alerts for "price mistake" ([Slickdeals](https://daily.slickdeals.net/shopping/most-exciting-price-mistakes-all-time/)).
- **Autonomous buying is shipping.** Amazon Rufus "Auto Buy" checks prices every 30 minutes and buys automatically when a target price is hit ([Modern Retail](https://www.modernretail.co/technology/marketplace-briefing-amazons-shopping-bot-rufus-can-now-automatically-buy-products-for-you-when-prices-drop/)). A mistaken low price meets every target at once.
- Visa reports a **25% rise in malicious bot-initiated transactions over six months (40% in the US)** and warns agentic tools let attackers "spin up thousands of targeted operations in minutes" ([Visa, Nov 2025](https://corporate.visa.com/en/sites/visa-perspectives/security-trust/the-threats-landscape-of-agentic-commerce.html)).
- **Honest limit:** no documented case yet of an AI shopping agent buying at a mistaken price. Present agents as an amplifier that is coming, not a measured loss.

## Why the payment layer (void, don't refund)

- **PayPal:** "Voiding an authorized payment saves processing fees compared to refunding a captured payment", "up to 3%". An authorization "is valid for 29 days" and PayPal recommends capturing within the 3-day honor period ([PayPal Developer](https://developer.paypal.com/checkout/void-authorized-payment)).
- PayPal Help (search-indexed): on a refund "we won't return the fees you originally paid as the seller".
- **The bigger cost is not fees.** In the incidents above, merchants who took the money and confirmed or shipped ended up honoring the price, chasing customers, or being ordered by a court to deliver. For a price Tripwire flags, a clear mistake is refused before any PayPal order exists, and a doubtful deep sale is only authorized: nothing is captured until the merchant decides. Sales Tripwire does not flag are captured automatically after 20 seconds.
- **Honest limit:** fee savings per order are modest (about $4 on a $100 order), so the case leads with stopping the order, not with fees.

## What already exists (don't claim "nothing like this")

- **Catalog layer:** Amazon's seller min/max prices and "potential pricing error" deactivation.
- **Shopify apps:** Floorline (launched Oct 2026; can block checkouts below a price floor), Order Guard, MarginLock. They are rule-based and need cost data.
- **Payment-layer tools:** generic rules only (manual capture, PayPal Fraud Protection Advanced "Review" filters, Authorize.net amount filters).
- **Tripwire's defensible difference:**
  - it sits at the payment layer, before capture;
  - it checks each item's price against that item's own normal price and an AI market estimate, so it works without cost data;
  - a velocity breaker trips on bot or agent rushes;
  - mistakes are voided instead of refunded.

  The 6 Nov research found no product that combines all four.
