// Deterministic price checks. These run before the AI and the AI can never undo them.
import { formatUsd } from './money.mjs';

export const RULE_DEFAULTS = Object.freeze({
  steepDropPct: 50,     // a drop of more than this against the 30-day median is a soft signal: review (keeps selling, capture waits) unless the AI calls it implausible
  aiReviewDropPct: 20,  // a drop of more than this (that passed every rule) needs the AI to vouch for it
  decimalTolerance: 0.02,
  spikeX: 5,            // a price this many times above BOTH the last good and the typical price would overcharge buyers: held
});

const hold = (code, message) => ({ code, message });

// newCents: the price being set. oldCents: the current listed price (null for a new SKU). costCents: unit cost if known.
// medianCents: median listed price over the last 30 days (null without history).
// Returns { holds: [{code, message}], needsAi, reference } — holds non-empty means the price must not go live.
export function checkPrice({ newCents, oldCents = null, costCents = null, medianCents = null }, cfg = RULE_DEFAULTS) {
  const holds = [];
  if (!Number.isSafeInteger(newCents) || newCents <= 0) {
    holds.push(hold('NON_POSITIVE', `A price of ${formatUsd(newCents)} would give the item away.`));
    return { holds, needsAi: false, reference: oldCents ?? medianCents };
  }
  if (Number.isSafeInteger(costCents) && costCents > 0 && newCents < costCents) {
    holds.push(hold('BELOW_COST', `${formatUsd(newCents)} is below your unit cost of ${formatUsd(costCents)}.`));
  }
  const reference = Number.isSafeInteger(oldCents) && oldCents > 0 ? oldCents : medianCents;
  // A slipped decimal is measured against the last good price AND the 30-day typical price: after a confirmed sale the
  // last good price is the sale price, and a slip off the usual price must still be caught as a slip.
  decimal: for (const anchor of [reference, medianCents]) {
    if (!Number.isSafeInteger(anchor) || anchor <= newCents) continue;
    const ratio = anchor / newCents;
    for (const f of [10, 100, 1000]) {
      if (Math.abs(ratio - f) / f <= cfg.decimalTolerance) {
        holds.push(hold('DECIMAL_SHIFT', `${formatUsd(anchor)} became ${formatUsd(newCents)}: exactly ${f}x lower, which looks like a slipped decimal point.`));
        break decimal;
      }
    }
  }
  // The other way round: a price slipped UP overcharges every buyer (refunds, disputes, chargebacks). It is measured
  // against the HIGHER of the last good and the typical price, so restoring the usual price after a mistaken low one
  // went live is never held.
  const ceiling = Math.max(Number.isSafeInteger(reference) && reference > 0 ? reference : 0, Number.isSafeInteger(medianCents) && medianCents > 0 ? medianCents : 0);
  if (ceiling > 0 && newCents > ceiling) {
    const ratio = newCents / ceiling;
    const f = [10, 100, 1000].find((x) => Math.abs(ratio - x) / x <= cfg.decimalTolerance);
    if (f) holds.push(hold('DECIMAL_SHIFT_UP', `${formatUsd(ceiling)} became ${formatUsd(newCents)}: exactly ${f}x higher, which looks like a slipped decimal point. Every buyer would be overcharged.`));
    else if (ratio >= cfg.spikeX) holds.push(hold('PRICE_SPIKE', `${formatUsd(newCents)} is ${Math.floor(ratio * 10) / 10}x your usual price of ${formatUsd(ceiling)}. Every buyer would be overcharged.`));
  }
  if (Number.isSafeInteger(medianCents) && medianCents > 0 && newCents < medianCents * (1 - cfg.steepDropPct / 100)) {
    const pct = Math.round((1 - newCents / medianCents) * 100);
    holds.push(hold('STEEP_DROP', `${formatUsd(newCents)} is ${pct}% below the 30-day typical price of ${formatUsd(medianCents)}.`));
  }
  if (holds.length) return { holds, needsAi: false, reference };
  const unverifiable = !Number.isSafeInteger(reference) && !(Number.isSafeInteger(costCents) && costCents > 0);
  // Measured against the higher of the last good price and the 30-day typical price, so a run of small cuts
  // (each under the threshold against the previous price) cannot walk a price down without the AI ever looking.
  const anchor = Math.max(Number.isSafeInteger(reference) ? reference : 0, Number.isSafeInteger(medianCents) ? medianCents : 0);
  const bigDrop = anchor > 0 && newCents < anchor * (1 - cfg.aiReviewDropPct / 100);
  return { holds, needsAi: unverifiable || bigDrop, reference: reference ?? null };
}
