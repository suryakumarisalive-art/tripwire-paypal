# Tripwire eval cases: method, exclusions, caveats

Companion to `eval_cases.json` (built 2026-11-06). It holds 30 real pricing mistakes (M01-M30) and 27 real genuine sales (S01-S27). Every row has a source URL and a short quote.

## Summary

| | Mistakes | Genuine sales |
|---|---|---|
| Count | 30 | 27 |
| VERIFIED | 25 | 27 |
| PARTIAL | 5 (M17, M23, M27, M28, M30) | 0 |
| Dated 2019-2026 | 21 | 26 |
| Dated 2023-2026 | 10 | 20 |
| Discount range | 22.7% to 99.9% below normal | 22.7% to 65.1% off |

**Status meanings**
- VERIFIED: I opened the page, or saw a search snippet quoting it, and both prices were stated (or derivable, e.g. "$550 off" plus the sale price).
- PARTIAL: one price is a bound, a range, or an inference. The reason is written into that row's `outcome` field and repeated below.

## The finding that matters for the eval

A plain "percent below normal" threshold cannot separate these two sets perfectly. The ranges overlap.

- The deepest genuine sale is S25, a Marmot down jacket at 65% off (normal/sale = 2.86x). S26, a North Face jacket, is 60% off (2.5x).
- Three real mistakes were shallower than that:
  - M20, Sony 16-35mm GM lens: 23% low (1.29x).
  - M27, iPhone 11 shelf tag: about 36% low (about 1.55x).
  - M30, Corsair DDR5 stale price: about 52% low (2.1x or less).
- M22, the Fnac Ultimate Ears Boom 3, is 67% low (3.05x). That is only just past the deepest genuine sale.

With the rows as they stand:

| Rule: block when normal/price is at least... | Mistakes caught | Genuine sales wrongly blocked |
|---|---|---|
| 3x | 27 of 30 | 0 of 27 |
| 2.5x | 27 of 30 | 2 (S25, S26) |

The three it misses (M20, M27, M30) only show up with other signals:
- a preorder or launch price;
- a shelf tag that disagrees with the system price;
- a price that went stale after the market moved.

## Tripwire error type for each mistake

| Error type | Cases |
|---|---|
| Slipped decimal / thousands separator | M09 (gas $6.99 to $0.69, divided by 10); M25 (Armani MXN 15,984 tagged 16, divided by 1000); M28 (Liverpool motorcycle tag 66.499 instead of 66,499, divided by 1000) |
| Missing digits | M02 (Cartier MXN 237,000 listed as 237) |
| Wrong currency | M05 (ANA, Vietnam site conversion); M11 (United, Danish krone rate) |
| Column swap | M07 (Digitec: quantity and price fields swapped, 35 and 1,299) |
| Cost/price swap | **None found** (see Gaps) |
| Software / system glitch, mechanism not disclosed | M06 Qantas, M12 Argos, M15 Walmart, M16 Makro, M17 Turkish, M30 Corsair |
| Unknown | All the rest |

## How I searched

1. I started with the incidents named in the brief: the Amazon Prime Day 2019 camera gear, the Amazon UK 1p RepricerExpress glitch, and airline mistake fares (Cathay, ANA, Qantas, United, Turkish, Delta, Hong Kong Airlines).
2. I branched into these sources:
   - retailer glitch news: Walmart, Best Buy, Home Depot, Argos, Makro, Dell, M&S;
   - the Slickdeals editorial blog (daily.slickdeals.net), which recaps price mistakes with both prices;
   - non-US consumer press, which documents mistakes well and often names a regulator outcome: Swiss SRF and bluewin, Italian Il Post, Belgian La Libre, Mexican El Siglo de Torreon, Publimetro and Diario de Yucatan (Profeco cases).
3. For genuine sales I used single-deal articles that state a "was" and a "now" price: Engadget, 9to5Toys, MacRumors, Notebookcheck, Digital Trends, SoundGuys, NBC Select, and an ABC7 Black Friday roundup. I aimed for some hard cases:
   - 50%+ off TVs (S02, S03, S15) and laptops (S14, S16);
   - 60-65% clearance apparel (S25, S26).
4. I fetched each source page to read the prices directly. When a page blocked fetching (403, 410 or 451, or a truncated page), I either used a different outlet for the same fact or dropped the case.
5. Currency conversions use rough mid-market rates for the month of the incident, and each one is written into the row's `outcome`:
   - AUD 0.67
   - CHF 1.24
   - EUR 1.155 (Nov 2025) and 1.09 (Nov 2023)
   - GBP 1.34 (Sep 2017) and 1.55 (Jan 2012)
   - ZAR 18.4 per USD
   - MXN 18.9 to 19.8 per USD

   Dell Taiwan (M10), Cartier (M02), ANA (M05) and United (M11) use the USD figures printed in the source.

## PARTIAL rows explained

| Row | Case | Why it is PARTIAL |
|---|---|---|
| M17 | Turkish Airlines, Apr 2026 | WSJ says typical business fares "run at least five times" the $550 paid. $2,750 is that lower bound. |
| M23 | Mexican online camera, Feb 2023 | The article names neither the retailer nor the camera model. Its source link points to Walmart. |
| M27 | Walmart Tampico iPhone 11, Nov 2022 | The normal price is a range, MXN 10,000-11,500. I used the lower bound. |
| M28 | Liverpool motorcycles, Dec 2022 | The article says the tags put the decimal point after the first two digits ("66.499 pesos"). The normal price of MXN 66,499 is inferred from that description. |
| M30 | Corsair DDR5, Jan 2026 | The normal price is a buyer's report that the kit was relisted at "over $500", so $500 is a lower bound. This was a stale price during the 2025-26 DRAM price surge, so the "mistake" price matches the kit's own price a few months earlier. That makes it a deliberately hard case. |

## Caveats you should know before scoring

- **Reference price choices.** I used the source's stated "normal" price even where a lower street price existed:
  - M08 MediaWorld: list price 879 euros. The "pay 619 more after a 150 discount" offer implies a shop price of about 784.
  - M18 Segway: $520 is the previous Black Friday price, not MSRP.
  - S05 Walmart M1 MacBook Air: $999 is Apple's original price. Walmart's own earlier price was $699.

  A detector that compares against recent street price will see smaller gaps on these rows.
- **Airfares.** Five mistakes are airfares (M04, M05, M06, M11, M17). Fares change by date and cabin, so their "normal" price is less firm than a product's. Drop them if Tripwire only covers physical goods. That leaves 25 product mistakes.
- **Cathay (M04).** Fortune pairs $675 with a $16,000 normal fare. Thrifty Traveler says $675 was the business fare and first class was about $1,000+. The row keeps Fortune's pairing.
- **Two incidents give two rows each.** M01 and M03 are different products in the same Prime Day 2019 glitch. M24, M25, M26 and M27 are separate Buen Fin 2022 cases from one Profeco roundup. M14, M18, M19, M20, M21 and M29 come from Slickdeals editorial recaps, a secondary source but a stable page. Each row is a distinct product, but the incidents are not fully independent.
- **Dates.**
  - S22 (Samsung fridge): the Digital Trends page is dated April 2022 but says the sale "lasts through March 20, 2019". I used 2019-03.
  - M22 (Fnac): the article is dated 1 Dec 2023. The orders were placed days earlier, so I used 2023-11.
  - M04: Cathay's mistake ran over New Year 2018/19. I used 2019-01, the coverage date.
- **Older mistakes.** I included nine pre-2019 mistakes (2009-2018) because they are well documented. They cover error types (currency, decimal) that recent coverage lacks.
- **Syndicated sources.** M15 cites Christian Post and M13 cites sportsvideo.org. Both syndicate wire coverage. The facts match the wider reporting I saw (Walmart cancelled with a $10 gift card; M&S reversed after a petition).
- **Quotes.** Quotes in other languages are given in the original with an English translation. M26's quote is a translated summary of the Spanish source, not a verbatim line.

## Excluded cases and why

| Candidate | Reason excluded |
|---|---|
| Amazon UK 1p RepricerExpress, Dec 2014 (named in the brief) | I read Expert Reviews, The Register, Computerworld and Fortune, plus search coverage of others. None named a specific product with its normal price. The closest was "675 of her items were sold for 1p each, when some should have cost £100". The incident is real and well sourced, but it fails the rule that both prices must be stated for a product. |
| Reebok Czech e-shop, Jun 2025 (EUR prices charged as CZK) | Error prices are given (CZK 28 t-shirts) but no normal prices. A good currency case if a source with normal prices turns up. |
| Delta Auckland-Oakland business fare (~$900, honored) | No normal fare stated. |
| Hong Kong Airlines $560 business fare, Aug 2018 | No normal fare stated. |
| Samsung France Black Friday 2025 | No prices in the Que Choisir article. |
| Walmart Mexico Philips 50" TVs at 299 pesos, Sep 2025 | The fetched source gives no normal price. A secondary summary said "over 6,000 pesos", but I did not verify it. |
| Makro (other items), Qatar business fare (404), Argos 2016 MacBook Pro, Best Buy $9.99 HDTVs, Walmart 2016 70" TV, Lowe's $2,999 fridge at $298 | No specific model plus normal price, page dead (410/404), or only one price confirmed. |
| House of Resell "2025 round-up" (Samsung 75" Neo QLED at £1, etc.) and blog claims of a Target Dyson V15 at $199 and an Amazon Fire Stick at $9.99 in 2024 | Commercial reseller and SEO blogs with no dates or primary sourcing. Not trustworthy enough. |
| Echo Dot 5th gen at $22.99 (was $49.99) | Real and widely covered, but every source page I tried was blocked (TechHive 410, Wccftech 403, CNN 451, Slickdeals 403). |
| Patagonia Better Sweater at $34 (was $139), Nike Pegasus 41 deals | Tom's Guide pages returned only headlines, so I could not confirm the prices and date on the page. |
| Meta Quest 3S at $249.99 (was $299.99) | Verified, but only 17% off, below the brief's 20-60% band. |
| Sony WH-1000XM5 at $248 (Engadget, Jul 2025) | Same product as S04. I kept the deeper 2026 deal to avoid a near-duplicate. |
| Samsung S90D on eBay at $1,358 | The regular price was not stated on the page. |

## Gaps

- **No documented cost/price swap.** I found no news report of a retailer listing its cost price instead of its sell price. The closest real field-swap is Digitec's quantity/price swap (M07). Tripwire's cost/price-swap path has no real-world test case here.
- **Little non-electronics coverage among mistakes.** There is fuel, jewelry, apparel, tools, an appliance and a motorcycle. Groceries and beauty are missing because coverage rarely gives both prices.
- **No r/pricemistakes or r/glitchndealz threads.** I found none that a news article or stable page confirmed with both prices, so none are used directly. Slickdeals editorial recaps stand in for the community sources.
