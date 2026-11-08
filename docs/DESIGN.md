# Tripwire design system: the Breaker Box (7 Nov 2026)

This replaces v2 ("paper and ink"). Three independent reviews took the console from 6.5 to 7.5 out of 10, and the round-3 fixes are in. The source of truth is `public/app.css`; this file says why it looks the way it does.

## The idea

The console is a picture of where Tripwire sits in the money flow. It is drawn as a breaker panel:

- Checkouts come in from the shop's jack.
- They run along the top bus bar, through one breaker per product, and down the bottom bus to PayPal's terminal.
- A wrong price trips that product's breaker, and the bots that hit it stop at the gap.

Every element is a real part of a breaker panel and maps to a real rule in the product:

| Part | What it means |
|---|---|
| Breaker (toggle up, pilot lamp lit, wire to the bottom bus lit) | The product is selling; checkouts reach PayPal |
| Toggle flipped down, orange flag, lamp dark, dashed dead wire | Tripped: no checkout for this product reaches PayPal |
| RATED stamp | The last price the merchant trusted |
| Lockout tag (TRIPPED) | Only the merchant's lever removes it |
| Embers on top of the breaker, and the hit counter | The checkouts it stopped. The count stays after a reset, in white instead of orange ("025 stopped"), as the quiet record of the trip until the next one |
| Glass fuse | Rush checkouts in the last minute; more than 5 trip the breaker. Greyed out on a price hold, which never uses it |
| AI lamp | The AI added a hold. It has no lever: the AI can add a hold but never lift one |
| Test buttons on the faceplate | The three demo moves |
| PayPal terminal | PayPal's end of the bus. Its screen stays dim until the swarm ends, then reads "0 of 25 bots reached PayPal". After your reset it adds "ready at $1,299.00", rings green, and its lamp turns green. All of it is rebuilt from the event log, so a reload keeps the ending. A printed note at its foot: every order is an authorization, captured only at a price you trust, otherwise voided |
| Receipt from the box's printer slot | What happened, newest first, with real sandbox IDs |

## Principles

1. **One signal colour.** Orange (`--signal`) means tripped or stopped, and nothing else. Nothing that moves money wears it.
2. **Hardware, not cards.** The breakers sit 3px apart on a rail with 2px corners. The enclosure has a hard 2px frame, 4px corners and screws, and no soft shadow. Only a tripped breaker wears a cream tag.
3. **Every motion is cause and effect.**
   - The counter, the receipt total and the refused count climb one spark at a time.
   - The receipt prints on the last spark.
   - The demo steps move on only after that.
4. **One word for the state:** TRIPPED. Its opposite is ON, and the gesture is "reset". Avoid "open" and "close", which mean the opposite of what a shopper expects.
5. **The AI rule is first.** The rules plate in the box's left column leads with "The AI can add a hold, never lift one."

## Colour

Tokens are defined once in `:root`; the dark theme redefines only what changes. Every hue in the rules is a token; a hue with transparency is written as `color-mix()` of its token. Pure black and white (and their alpha) appear only as shading: bevels and shadows. Every corner is `--r-1`, `--r-2`, `--r-3` or a circle.

| Token | Light | Dark | Use |
|---|---|---|---|
| `--ground` | #e6e4df | #121211 | page |
| `--ink`, `--ink-2`, `--faint` | #1b1b1b / #4b4943 / #625f58 | #edebe6 / #b4b1a9 / #98958d | text |
| `--signal` / `--signal-ink` | #ff4f1a / #b8360a | #ff5a26 / #ff8a5c | tripped, stopped |
| `--amber` | #ffb020 | same | the AI lamp, "checking" |
| `--box`, `--box-rule`, `--module` | #1d1d1c / #33322f / #292826 | #2c2b28 / #5a5852 / #363531 | the enclosure; it sits a step above the page in dark mode |
| `--box-hi`, `--box-text`, `--box-faint` | #f4f2ec / #c9c6be / #a19e96 | same | print on the box |
| `--bus`, `--bus-hi`, `--bus-lo` | tinned copper greys | same | bus bars |
| `--live`, `--live-glow` | warm filament white | same | current flowing (a lit wire, the reset glow); never a second accent |
| `--go` | #9fe6c2 | same | PayPal's lamp after a capture or a reset |
| `--paypal` | #003087 | same | only on PayPal's screen |
| `--paper`, `--paper-ink` | #f6f5f1 / #1b1b1b | #e9e6de | the receipt stays paper in both themes |
| `--box-hi`, `--metal`, `--metal-hi`, `--rail*`, `--module-hi/lo`, `--glass`, `--handle-hi/lo`, `--slot-deep`, `--screw-ring`, `--frame`, `--engrave`, `--dead` | hardware greys | same | the materials of the box, each named once |

## Type

- **One family:** Archivo, loaded only at widths 75 to 125 and weights 400 to 800.
  - Condensed (75 to 92%): labels, stamps and numbers.
  - Wide (104 to 118%): the headline and names.
- **Scale:** 15 steps, each a token: `--fs-12`, `--fs-13`, `--fs-14`, `--fs-15`, `--fs-16`, `--fs-17`, `--fs-18`, `--fs-20`, `--fs-22`, `--fs-28`, `--fs-34`, `--fs-40`, `--fs-44`, `--fs-56` and `--fs-72`. No size is written by hand. No text is under 12px. Inside the box, reading text is 13px or more; stamps, tags and counter captions are 12px.
- **Corners:** `--r-1` (2px) for hardware and tags, `--r-2` (4px) for the enclosure and the receipt, `--r-3` (6px) for buttons and the lever. Round parts (lamps, jacks, screws) are circles.
- **Monospace** (`--mono`) only for the hit counter, the receipt and IDs.
- Numbers use tabular figures (`.num`).

## Motion

All of it is skipped under `prefers-reduced-motion`.

| Moment | Motion |
|---|---|
| Trip | The toggle flips on its pivot, the flag shows, the lamp goes dark, the box jolts 2px, and the lockout tag swings on |
| Decimal slip | In the big price, the point hops one digit left ($1299.0 → $129.90), once per mistake |
| Swarm | 14px pulses run the whole top bus to the tripped breaker. Each lands as a 56px spark, flashes the breaker and adds an ember, and counts in the counter and the receipt |
| Reset | The handle in the lever climbs during the 1-second hold. The breaker's wire flashes back on, a glow of current runs down the bottom bus to PayPal, the bus glows, and PayPal's lamp turns green |
| Receipt | New lines print in from above |

## Layout

- **Desktop:** a story row (40px headline) above the box.
  - Box: faceplate (name, filter tabs, test buttons), then the panel (rules column, rack, PayPal terminal).
  - Below the box: the work order on the left and the receipt hanging from the box on the right.
  - The reset lever stays above the 900px fold.
- **1000px and below:** the panel turns on its side.
  - The shop's bus runs down the left and PayPal's down the right.
  - Each breaker becomes a row.
  - The rules move to the box's bottom edge.
- **640px and below:** while a breaker is tripped, the reset lever floats at the bottom of the screen.

## Copy

Utility language, short.

- "Tripped: wrong price"
- "Reset at $1,299.00", with "Press and hold" under it
- "While it was tripped it stopped 25 checkouts. None of them reached PayPal."

Receipt lines fit on one line.

## The store

A printed catalog, not a card grid:
- the TV is the "Feature of the week" and spans two columns;
- every item has a catalog number;
- rules separate items instead of boxes.

A held product shows "Price under review" with a small breaker glyph and "Checkout is paused, so you won't be charged."

## Accessibility

- Each breaker is a real button. Its label carries the state, the count stopped and the AI lamp.
- Results are announced through a polite live region.
- The lever works from the keyboard: Enter acts at once.
- All targets are 44px or more.
- Colour is never the only signal: every state has a word and a toggle position.
