// Pure helpers for the console, kept free of the DOM so node --test can check them (test/ui_logic.test.mjs).

// The printed label on a breaker: brand and model, short enough to print in full. The full name is in its tooltip.
export function shortLabel(name) {
  const words = String(name).replace(/\(.*?\)|["”″]/g, ' ').replace(/,.*$/, '').split(/\s+/).filter(Boolean);
  let out = '';
  for (const w of words) { const next = out ? `${out} ${w}` : w; if (out && (out.length >= 10 || next.length > 18)) break; out = next; }
  return out || String(name);
}

// Where the guided demo stands for one product, judged on its latest hold only. A hold starts at the first
// PRICE_HELD after the product was selling; the AI's own PRICE_HELD a moment later belongs to the same hold.
export function tourProgress(events, sku) {
  let start = 0; let inHold = false; let swarm = 0; let fixed = 0;
  for (const e of events) {
    if (e.sku !== sku) continue;
    if (e.kind === 'PRICE_HELD') { if (!inHold) { start = e.seq; inHold = true; } } else if (e.kind === 'SWARM_DONE') swarm = e.seq;
    else if (e.kind === 'MERCHANT_FIXED') { fixed = e.seq; inHold = false; } else if (['MERCHANT_CONFIRMED', 'PRICE_LIVE', 'RESUMED'].includes(e.kind)) inHold = false;
  }
  return { slipped: start > 0, swarmed: start > 0 && swarm > start, closed: start > 0 && fixed > start };
}

// The receipt totals while bots are still sparking: they climb one refused checkout per spark, never ahead of what
// the server has confirmed. pre = the totals before the swarm, actual = the latest totals, sparked = sparks so far.
export function swarmReadings(pre, actual, sparked) {
  const confirmed = actual.refused - pre.refused;
  if (confirmed <= 0) return { refused: pre.refused, kept: pre.kept };
  const n = Math.max(0, Math.min(confirmed, sparked));
  if (n === confirmed) return { refused: actual.refused, kept: actual.kept };
  return { refused: pre.refused + n, kept: pre.kept + Math.round(((actual.kept - pre.kept) * n) / confirmed) };
}

// What PayPal's terminal shows, rebuilt from the event log so a reload keeps the ending:
// the last swarm's result ("0 of 25 bots reached PayPal") and, once you reset that product, "ready at $X".
export function terminalState(events) {
  let swarm = null;
  for (const e of events) if (e.kind === 'SWARM_DONE') swarm = e;
  if (!swarm) return { reached: null, readyCents: null };
  const n = (re) => Number((re.exec(swarm.message || '') || [])[1] || 0);
  const refused = n(/(\d+) refused/); const authorized = n(/(\d+) authorized/); const failed = n(/(\d+) failed/);
  let readyCents = null;
  for (const e of events) {
    if (e.sku !== swarm.sku || e.seq <= swarm.seq) continue;
    if (e.kind === 'MERCHANT_FIXED' || e.kind === 'RESUMED') readyCents = Number.isSafeInteger(e.amountCents) ? e.amountCents : null;
    else if (['PRICE_HELD', 'BREAKER_TRIPPED', 'MERCHANT_CONFIRMED'].includes(e.kind)) readyCents = null;
  }
  return { reached: { total: refused + authorized + failed, authorized }, readyCents };
}

// The buttons for a product's waiting orders. Under review, PayPal capture happens only by confirming the price
// (the server refuses "honor" there with a 409), so a review item gets Void but no Capture.
export function waitingActions(status) { return status === 'review' ? ['void'] : ['void', 'honor']; }
