# Real-case evaluation: does Tripwire stop real price mistakes without blocking real sales?

**Tested on 6 Nov 2026** with the shipped decision code (`src/rules.mjs`, `src/ai.mjs` `combine()`), the production model (`openai/gpt-oss-120b` on Groq, temperature 0, low reasoning effort) and **57 real, sourced cases**:

- **30 documented pricing mistakes**, for example a $13,000 Canon lens at $94.50 on Prime Day 2019, a Digitec quantity/price column swap, and Mexican shelf tags with a slipped thousands separator.
- **27 documented genuine sales**, for example 50%-off TCL TVs, a 65%-off Marmot jacket, and a $109 Chromebook.

Every case has a source URL and a quote (`cases.json`). How the cases were found, what was excluded and why, and the caveats are in `cases_notes.md`.

The whole evaluation ran **twice** to measure how much the AI's answers vary: run A is `results.json`, run B is `results_run2.json`. Where the runs differ, both numbers are shown as A / B.

## Since 7 Nov: hold the capture, not the checkout

Tripwire now treats two signals as **soft**: a steep drop (more than 50% below the 30-day typical price) and an AI "suspicious". When a price change carries only soft signals, and the AI answered:
- the item **keeps selling**;
- every order is **only authorized**, and its capture waits for the merchant's one click (Confirm captures them, Fix voids them);
- at most 10 orders are taken while the price is under review, and the speed breaker still applies.

Hard signals still refuse checkout before any PayPal order exists: a slipped decimal, below cost, a zero price, an AI "implausible", or a price nothing could vouch for because the AI was down. This is the same pattern as Stripe Radar's "review uncaptured payments" and Shopify's manual capture.

Re-scored on the **same recorded AI answers** (no new AI calls; `node tools/eval_rescore.mjs eval/results.json eval/results_run2.json`):

| Known item (run A / run B) | Refused at checkout | Sells, capture waits for a click | Let through (AI said ok) |
|---|---|---|---|
| 30 mistakes | 21 / 16 | 7 / 12 | 2 / 2 (M20, M27) |
| 27 genuine sales | **3 / 3** (was 7 / 9) | 4 / 6 | 20 / 18 |

| New item (run A / run B) | Refused at checkout | Sells, capture waits for a click | Let through (AI said ok) |
|---|---|---|---|
| 30 mistakes | 21 / 20 | 6 / 7 | 3 / 3 (M20, M27, M30) |
| 27 genuine sales | **3 / 4** (was 6 / 7) | 3 / 3 | 21 / 20 |

**The trade, stated plainly:**
- Genuine deep sales that are turned away fall from 7–9 to 3–4.
- The cost: 7–12 mistakes that used to be refused at checkout now take a few authorized orders (at most 10 each). Those orders are voided when the merchant fixes the price.
- No mistake that Tripwire flags (refused, or under review) has its money captured without the merchant's click. The misses are unchanged (M20, M27, M30): they go live and are captured like any sale.
- The thresholds and this policy were chosen on these same cases. There is no held-out set, so treat these numbers as in-sample.

## Since 7 Nov: the AI sees live retailer prices (Channel3)

**Setup.** For every item the AI must decide, Tripwire now also searches Channel3 (a sponsor; its keyless MCP server) for live US retailer listings. It uses them in three separate steps:
1. **The price call** decides as before. It never sees a listing.
2. **A matching call** sees product titles only, never a price, and says which listings are the exact product.
3. **Code** takes the matched listings' real prices. If the price is far below them, it tightens the price call's verdict (an "ok" becomes a review or a hold). It never softens or releases anything, and the reason names the live prices (for example "Live prices today (Channel3) at 2 US retailers: bestbuy.com $249.95, hsn.com $309.99").

Listing text is written by third parties, so it never shares a prompt with a price decision: the worst a hostile title can do is change which listings count as matches, and that can only add holds.

**Test.** The cases above are historical prices, so they cannot test this. `tools/eval_live_prices.mjs` tests it on today's prices instead:
- 16 real products at their current US list price.
- 4 prices each: sales 25% and 45% off, mistakes 70% off and a slipped decimal.
- All run as **new items**, where the AI is the only check.
- Real Groq and real Channel3, run on 7 Nov 2026; results in `live_prices.json`.

| 16 products × 4 prices | Mistakes refused / review / let through | Genuine sales refused / review / selling |
|---|---|---|
| Price call alone | 30 / 1 / 1 | 1 / 4 / 27 |
| With Channel3 evidence | 30 / 1 / 1 | 1 / 5 / 26 |

**Reading it honestly:**
- **Channel3 changed 1 decision out of 64:** an Anker power bank at 45% off moved from selling to review. That's a genuine sale made to wait, so on this test it bought no accuracy.
- **Coverage.** Channel3 had listings for all 16 products, and the matching call confirmed the exact product for 9. It is strict on titles: it did not match the TCL or Sony TV listings, whose titles leave out the model or size.
- **What it does buy:** for matched items, every reason shows real prices instead of the AI's memory, and it adds a check that can only tighten.
- **Misses, with or without it:**
  - a Corsair RAM kit at 70% off went live: the AI's memory predates the 2025–26 memory price rise, and Channel3 found no exact match;
  - the TCL 85" sale at 45% off was refused: the AI still thinks the TV costs far more.
- **Production limits.** A lookup searches at most 10 items, 4 at a time, within 8 s; demo imports are 2–3 items. In this eval, with 16 items, the 8 s limit answered only 5. The eval therefore gave Channel3 30 s, and waited out Groq's per-minute token limit before the matching call. Both are marked in the script.
- **An earlier version was withdrawn.** It put the listings in the price call itself. A second independent review found that the listing text moved the AI's own answers both ways and was a prompt-injection channel. Its numbers are withdrawn, and so is a claim drawn from them that the TCL TV was judged against Best Buy's price: in that run, nothing was matched for the TCL.
- One run, 64 rows: it shows the direction, not a precise rate.

The tables below are the 6 Nov results under the old policy, where every hold refused checkout.

## Two situations

- **Known item.** The store already sells it and knows its normal price; a CSV import or an edit changes the price. The rules compare against the last good price and the 30-day typical price.
- **New item.** The store has never sold it and knows no cost: a new SKU imported with a price. No rule can judge it, so only the AI can.

## Results

**Known item** (30 mistakes, 27 genuine sales):

| | Mistakes held | Genuine sales wrongly held |
|---|---|---|
| Rules only, letting through what they can't judge | 28 | 6 |
| Rules only, holding what they can't vouch for (Tripwire with the AI down) | 30 | 27 |
| **Tripwire (rules + AI)** | **28** (both runs) | **7** (run A), **9** (run B) |

**New item** (same 57 cases, with no history and no cost):

| | Mistakes held | Genuine sales wrongly held |
|---|---|---|
| Rules only, letting through what they can't judge | 0 | 0 |
| Rules only, holding what they can't vouch for | 30 | 27 |
| **Tripwire (rules + AI)** | **27** (both runs) | **6** (run A), **7** (run B) |

Counting only the 25 product mistakes (leaving out the 5 airfares): 23 of 25 are held for a known item and 22 of 25 for a new item, in both runs.

## What this shows

1. **For a known item, the AI adds nothing on this set.** The code rules held 28 of 30 mistakes, and the AI added no catches. Rules that simply let through what they can't judge (first row) do as well on mistakes, with 6 false holds against Tripwire's 7 to 9. The AI's real job here is safety: 21 genuine sales were deep enough (over 20% off) that the rules could not vouch for them. A store that fails closed would freeze all 21; the AI cleared 20 of them in run A and 18 in run B.
2. **For a new item, the AI is the only check there is.** The rules are blind, so the choice without the AI is to hold every new price (27 of 27 genuine sales blocked) or check nothing (0 of 30 mistakes caught). With the AI, Tripwire held 27 of 30 mistakes (90%) and let 20 to 21 of 27 genuine sales sell. Every mistake it caught was 67% or more below the real price; the three it missed were 23%, 36% and 52% below. Subtle mistakes are its weak spot.
3. **Code decides, which limits the AI's wobble but doesn't remove it.** Between the two runs, at temperature 0, the AI's verdict word changed on 16 of 57 known-item rows and 10 of 57 new-item rows. The final decision changed on only 2 and 1 rows, all of them genuine sales that run B held for review. Both runs held exactly the same mistakes. This is why the AI only estimates a market range and code applies a fixed 45% sale allowance (`aiHolds()`). For a new item, though, that estimate is the only input, so a different estimate can change the decision.
4. **The sale set is a worst case.** Every genuine sale in it is 22.7% to 65% off, chosen to be hard. A price cut under 20% never reaches the AI and is held only if it falls below the item's known cost (`checkPrice`, tested in `test/money_rules.test.mjs`).
5. **The AI can never release a hold.** In every row where a rule held the price, the price stayed held, whatever the AI said.

## Every miss (a mistake Tripwire let sell)

| Case | Price vs normal | Why it was missed |
|---|---|---|
| M20 Sony FE 16-35mm f/2.8 GM lens (preorder) | $1,698 vs $2,198 (23% low) | It looks like an ordinary discount. The AI put the market at $1,800-$2,200 and called it ok. Both situations, both runs. |
| M27 Apple iPhone 11 64GB (Walmart Tampico shelf tag; normal price PARTIAL) | $332 vs $515 (36% low) | Also looks like a discount, since the iPhone 11 is an old model. AI: ok. Both situations, both runs. |
| M30 Corsair Dominator Titanium 48GB DDR5 (stale price; normal price PARTIAL) | $239.99 vs about $500 (52% low) | New item only. The "mistake" was the kit's own price a few months earlier, before the 2025-26 memory price surge, and the AI's knowledge matches that older price ($230-$300). For a known item, the steep-drop rule held it. |

The case research found the same thing independently: these three can't be separated from genuine sales by price alone. Catching them needs other signals, such as a preorder flag, a shelf-tag mismatch, or a stale price after the market moved.

## Every wrong hold (a genuine sale Tripwire held for the merchant)

**Known item, held by the steep-drop rule** (more than 50% below the 30-day typical price; the same in both runs):
- S02: TCL 65" QM5K TV, $449.99 (50% off)
- S03: TCL 85" Q5K TV, $599.99 (50% off)
- S04: Sony WH-1000XM5 headphones, $198 (50% off)
- S15: TCL 85" S4 TV, $498 (50% off)
- S25: Marmot Guides down jacket, $96 (65% off)
- S26: The North Face Front Range jacket, $52 (60% off)

**Known item, held by the AI:**
- S16: Acer Chromebook 315, $109 (50% off). AI market estimate $200-$300. Both runs.
- Run B only: S07, a Ring Battery Doorbell at $50 (50% off; AI $100-$120).
- Run B only: S19, an iRobot Roomba 104 at $130 (48% off; AI $250-$300).

**New item, all held by the AI:**
- S02, S03, S15, S16, S19 and S27 in both runs, plus S07 in run B.
- The AI's TV estimates were far above the real prices; for example, it put the 85" TCL at $2,400-$2,800 against a regular price of $1,200. Its knowledge lags categories whose prices fall fast.

**What a wrong hold costs (6 Nov policy):** no money moves and no buyer is charged. The item stops selling until the merchant clicks **Confirm**, and the console shows the reason. Since 7 Nov, a soft hold keeps the item selling and only the capture waits (see the top of this file). Within those minutes a real flash sale can lose buyers, which is a real cost. Tripwire's trade is that an unexpected deep discount costs the merchant one click, while a missed mistake can cost thousands in minutes (see `docs/EVIDENCE.md`).

## Honest caveats

- **57 cases is a small set.** They come from one research pass over public reporting, which favours large, newsworthy mistakes. Several rows come from the same incident (see `cases_notes.md`).
- **Airfares.** 5 of the 30 mistakes are airfares, and their "normal" fare is less firm than a product's price. Product-only numbers are given above.
- **PARTIAL rows.** 5 mistakes have one price that is a bound or an inference: M17, M23, M27, M28 and M30.
- **Currency.** Non-US cases were converted to USD at the rates stated in `cases_notes.md`. The AI was asked about US retail prices.
- **The known-item test is the rules' best case:** the store is given the item's normal price as both its last price and its 30-day typical price. A store with a thin or noisy price history will see the rules fire less often, and lean more on the AI.
- **Two runs measure variance; they don't bound it.** Another run may differ on a few genuine sales, as runs A and B did.
- **No real cost/price swap case** was found, so Tripwire's below-cost rule has no real-world case here.
- **An earlier run on 6 Nov is superseded.** It failed most AI calls on a rate-limit bug, fixed in commit `08004c1`.

## Reproduce

```
node tools/eval.mjs eval/cases.json eval
```

The Groq key is read from the single `.txt` file in `~/.dg_groq_key`, and nothing secret is printed. One run makes 6 AI calls (3 batches of up to 25 rows per situation) and takes a few minutes, because it waits out Groq's tokens-per-minute limit.
