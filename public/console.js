import { $, h, usd, api, storeId, toast, initTheme } from './common.js';
import { shortLabel, tourProgress, swarmReadings, terminalState, waitingActions, swarmSummary } from './logic.js';

const POLL_MS = 2000;
const IDLE_MS = 10 * 60_000;
let SID = '';
let lastSeq = 0;
let events = [];
let catalog = [];
let orders = []; // the latest orders from the server, for each waiting order's capture-by time
let filter = 'all';
let selected = null; let userSelected = false; // the breaker whose work order is shown
const pending = new Set(); // keys of actions in flight, so a poll never re-enables a busy button
const motionOK = () => !window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// A status is always a word and a lever position, never color alone.
const STATUS = {
  live: { word: 'On', long: 'On, selling', cls: '' },
  held: { word: 'Tripped', long: 'Tripped: wrong price', cls: 'open' },
  tripped: { word: 'Tripped', long: 'Tripped: rush checkouts', cls: 'open' },
  checking: { word: 'Checking', long: 'Checking the price', cls: 'checking' },
  // review: still selling, but every order is only authorized and waits for you (a soft signal, not a trip)
  review: { word: 'Review', long: 'Selling: every order waits for your review', cls: 'review' },
};
const stopped = (s) => s === 'held' || s === 'tripped';
const needsYou = (c) => c.status !== 'live' || c.awaiting > 0 || c.apiWaiting > 0;
const GROUPABLE = ['CHECKOUT_REFUSED', 'AUTHORIZED', 'VOIDED', 'AWAITING_MERCHANT', 'CAPTURED', 'API_ALLOWED', 'API_CAPTURE', 'API_VOID', 'API_WAIT', 'ORDER_CREATED'];
const STOP_KINDS = ['PRICE_HELD', 'CHECKOUT_REFUSED', 'BREAKER_TRIPPED', 'AWAITING_MERCHANT', 'AI_ERROR', 'API_WAIT'];
const TV = 'TV-BRAVIA-65';
// When the AI check is unavailable (rate-limited, timed out, down), prices it could not vouch for stay held. Say that
// plainly instead of showing a raw error; the server's exact words stay in the tooltip.
const AI_DOWN = /rate-limited|server error|timed out|could not be reached|AI check failed|not configured/i;
const AI_BUSY_REASON = 'The AI is busy, so this new price is held safely. Confirm it to sell now, or import it again in a minute.';
const presetCsv = {}; // preset id -> csv, for the tour

// --- drawing helpers ---
const SVG = 'http://www.w3.org/2000/svg';
function s(tag, attrs = {}, ...kids) {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  el.append(...kids);
  return el;
}
function brandMark() {
  return s('svg', { width: 28, height: 18, viewBox: '0 0 28 18', 'aria-hidden': 'true' },
    s('line', { x1: 4, y1: 12, x2: 19, y2: 3, stroke: '#ff4f1a', 'stroke-width': 3, 'stroke-linecap': 'round' }),
    s('circle', { cx: 4, cy: 12, r: 3.2, fill: 'currentColor' }),
    s('circle', { cx: 23.5, cy: 12, r: 3, fill: 'none', stroke: 'currentColor', 'stroke-width': 2 }));
}
// screen readers still hear each outcome
function announce(text) { let el = $('#announce'); if (!el) { el = h('div', { id: 'announce', class: 'sr-only', role: 'status', 'aria-live': 'polite' }); document.body.append(el); } el.textContent = text; }
const clock = (at) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const nameOf = (sku) => catalog.find((c) => c.sku === sku)?.name || sku;
const shortName = (sku) => shortLabel(nameOf(sku));
const pad3 = (n) => String(Math.min(999, n)).padStart(3, '0');
let counting = null; // { sku, shown, base, pre } while bots hit an open breaker: its counter and the receipt climb spark by spark
let lastSum = null; // the latest totals from the server

// numbers roll to their new value instead of jumping (the payoff should be seen changing)
function roll(el, value, fmt) {
  const from = Number(el.dataset.v || 0);
  el.dataset.v = String(value);
  if (from === value || !motionOK()) { el.textContent = fmt(value); return; }
  const t0 = performance.now(); const dur = 700;
  const step = (t) => {
    const k = Math.min(1, (t - t0) / dur); const e = 1 - (1 - k) ** 3;
    el.textContent = fmt(Math.round(from + (value - from) * e));
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

// Runs an action with its button disabled and a spinner; refreshes state afterwards.
async function act(key, button, fn, okMessage) {
  if (pending.has(key)) return;
  pending.add(key);
  if (button) { button.disabled = true; button.classList.add('busy'); }
  try {
    const r = await fn();
    // success is shown where it happens (the breaker moves, the receipt prints); a toast would only cover the page
    if (okMessage) announce(typeof okMessage === 'function' ? okMessage(r) : okMessage);
    return r;
  } catch (e) { toast(e.message, 'error'); return null; } finally {
    pending.delete(key);
    if (button && button.isConnected) { button.disabled = false; button.classList.remove('busy'); }
    await refresh();
  }
}

// Buttons that need a second click. The armed state lives here, not in the DOM, so a re-render keeps it.
let armed = null; // { key, until }
const isArmed = (key) => Boolean(armed && armed.key === key && armed.until > Date.now());
function armable(key, button, armedText, run) {
  if (isArmed(key)) { button.replaceChildren(armedText); button.classList.add('armed'); }
  button.addEventListener('click', () => {
    if (isArmed(key)) { armed = null; run(); return; }
    armed = { key, until: Date.now() + 4000 };
    renderOrder(true);
    setTimeout(() => { if (armed && armed.key === key && armed.until <= Date.now()) { armed = null; renderOrder(true); } }, 4100);
  });
  return button;
}

// A second click within 4 seconds confirms; no browser dialogs. (For buttons that are never re-rendered.)
function twoStep(button, armedText, run) {
  let on = false; let timer;
  const original = [...button.childNodes];
  button.addEventListener('click', () => {
    if (!on) {
      on = true; button.replaceChildren(armedText); button.classList.add('armed');
      timer = setTimeout(() => { on = false; button.replaceChildren(...original); button.classList.remove('armed'); }, 4000);
      return;
    }
    clearTimeout(timer); on = false; button.replaceChildren(...original); button.classList.remove('armed');
    run();
  });
  return button;
}

// The merchant's lever: press and hold for one second to close the breaker. A keyboard press acts at once.
function holdLever(label, sub, run) {
  const b = h('button', { class: 'hold', type: 'button', 'aria-label': `${label}. Press and hold, or press Enter.` },
    h('span', { class: 'h-win', 'aria-hidden': 'true' }, h('span', { class: 'h-flag' }), h('span', { class: 'h-handle' })),
    h('span', {}, label, h('small', {}, sub)));
  let timer = null; let hint = null;
  const small = b.querySelector('small');
  const cancel = () => { // let go too soon: say so, instead of silently doing nothing
    clearTimeout(timer); timer = null; b.classList.remove('pressing');
    small.textContent = 'Keep holding for one second'; b.classList.add('early');
    clearTimeout(hint); hint = setTimeout(() => { small.textContent = sub; b.classList.remove('early'); }, 1800);
  };
  const fire = () => { b.classList.remove('pressing'); b.classList.add('done'); run(b); };
  b.addEventListener('pointerdown', (e) => {
    if (b.disabled || e.button !== 0) return;
    b.setPointerCapture(e.pointerId);
    b.classList.add('pressing');
    timer = setTimeout(() => { timer = null; fire(); }, motionOK() ? 1000 : 400);
  });
  for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) b.addEventListener(ev, () => { if (timer) cancel(); });
  b.addEventListener('click', (e) => { if (e.detail === 0) fire(); }); // keyboard
  return b;
}

// checkouts refused for one product since it last went live: the bots stopped at its open breaker
function refusedSince(sku) { return holdCounts(sku).now; }
// now: stopped since it last went live; closed: how many the hold you last closed by hand had stopped (0 if none)
function holdCounts(sku) {
  let n = 0; let closed = 0;
  for (const e of events) {
    if (e.sku !== sku) continue;
    if (e.kind === 'CHECKOUT_REFUSED') n++;
    else if (e.kind === 'MERCHANT_FIXED') { closed = n; n = 0; } else if (['MERCHANT_CONFIRMED', 'RESUMED', 'PRICE_LIVE'].includes(e.kind)) { closed = 0; n = 0; } else if (e.kind === 'PRICE_HELD' && n === 0) closed = 0;
  }
  return { now: n, closed };
}
// the fuse: rush checkouts in the last minute (the breaker trips after 5); full once tripped
function fuseFill(c) {
  if (c.status === 'tripped') return 5;
  const since = Date.now() - 60_000;
  return Math.min(5, events.filter((e) => e.sku === c.sku && (e.kind === 'AUTHORIZED' || e.kind === 'API_ALLOWED') && e.at >= since).length);
}

// The guided demo: three moves, each ticked off when the receipt shows it happened.
function tour() {
  const tv = catalog.find((c) => c.sku === TV);
  const held = Boolean(tv && (tv.status === 'held' || tv.status === 'checking'));
  const p = tourProgress(events, TV); // judged on the TV's latest hold, so a second run starts fresh
  const steps = [
    { label: 'Slip the TV’s price', short: 'Slip price', done: p.slipped, enabled: Boolean(presetCsv.decimal_slip), run: (b) => runImport(presetCsv.decimal_slip, b) },
    { label: 'Send 25 bots', short: '25 bots', done: p.swarmed, enabled: held, why: 'Do step 1 first', run: (b) => runSwarm(TV, b) },
    { label: 'Reset the TV', short: 'Reset', done: p.closed && !held, enabled: Boolean(held && tv.lastGoodCents && tv.lastGoodCents !== tv.priceCents),
      run: () => { const l = $('.hold'); if (l) { l.scrollIntoView({ behavior: motionOK() ? 'smooth' : 'auto', block: 'center' }); l.focus({ preventScroll: true }); } } },
  ];
  return { steps, current: steps.findIndex((x) => !x.done && x.enabled) };
}

let stepsSig = '';
function renderSteps() {
  const { steps, current } = tour();
  if (counting) return; // the steps move on when the last bot has sparked
  const sig = JSON.stringify(steps.map((x) => [x.done, x.enabled])) + current + [...pending].join('|');
  if (sig === stepsSig) return;
  stepsSig = sig;
  $('#steps').replaceChildren(...steps.map((x, i) => {
    if (!x.run) return h('li', { class: `tstep hint${i === current ? ' current' : ''}${x.done ? ' done' : ''}` }, h('span', { class: 'tn' }, String(i + 1)), x.done ? 'Closed again' : x.label);
    const b = h('button', { class: `btn ${i === current && (i > 0 || events.length) ? 'btn-primary' : ''}`, type: 'button', 'aria-label': x.label }, h('span', { class: 'lbl-long' }, x.label), h('span', { class: 'lbl-short', 'aria-hidden': 'true' }, x.short || x.label)); // at rest the big button under the box is the one first move
    b.disabled = !x.enabled || pending.size > 0;
    if (!x.enabled && x.why) b.title = x.why;
    b.addEventListener('click', () => x.run(b));
    return h('li', { class: `tstep${x.done ? ' done' : ''}` }, h('span', { class: 'tn' }, String(i + 1)), b);
  }));
}

// --- the rack: one breaker per product ---
let prevCls = new Map(); // sku -> last drawn lever state, so a change swings the handle instead of jumping
let rackSig = '';
function renderRack(force = false) {
  const sig = JSON.stringify(catalog) + events.length + filter + selected;
  if (!force && sig === rackSig) return;
  rackSig = sig;
  const open = catalog.filter(needsYou).length; const tripped = catalog.filter((c) => stopped(c.status)).length; const inReview = catalog.filter((c) => c.status === 'review').length;
  $('#plateSub').textContent = catalog.length ? `${catalog.length} breakers, ${[tripped ? `${tripped} tripped` : '', inReview ? `${inReview} in review` : ''].filter(Boolean).join(', ') || 'all on'}` : '';
  $('#filterStopped').textContent = open ? `Needs you (${open})` : 'Needs you'; // tripped or in review
  // Every breaker keeps its slot (like a real panel), so the bots run the whole bus to reach the one that is open.
  const ordered = [...catalog].sort((a, b) => a.name.localeCompare(b.name)).filter((c) => filter === 'all' || needsYou(c));
  const rack = $('#rack');
  rack.style.setProperty('--cols', String(Math.max(1, ordered.length <= 12 ? ordered.length : Math.ceil(ordered.length / 2))));
  const swings = []; const next = new Map();
  const items = ordered.map((c) => {
    const st = STATUS[c.status] || STATUS.held;
    const was = prevCls.get(c.sku);
    const swing = was !== undefined && was !== st.cls && motionOK();
    next.set(c.sku, st.cls);
    const isOpen = st.cls === 'open';
    // the breaker's rating is the last price you trusted; a new product with no history is unrated
    const rating = Number.isSafeInteger(c.lastGoodCents) ? c.lastGoodCents : c.status === 'live' ? c.priceCents : null;
    const aiLit = c.status === 'checking' || (c.reasons || []).some((r) => r.source === 'ai');
    const fill = fuseFill(c);
    const counts = holdCounts(c.sku);
    const piled = stopped(c.status) ? counts.now : 0;
    const shown = counting && counting.sku === c.sku ? counting.shown : piled;
    const closedBy = c.status === 'live' ? counts.closed : 0; // the mark a hold you closed leaves behind
    const label = `${c.name}, ${usd(c.priceCents)}: ${st.long}${shown ? `, ${shown} checkouts stopped` : ''}${closedBy ? `, reset by you after stopping ${closedBy}` : ''}${aiLit ? ', AI lamp lit' : ''}`;
    const b = h('button', { class: `brk ${swing ? was : st.cls}`, type: 'button', 'data-sku': c.sku, 'data-status': c.status, 'aria-pressed': String(c.sku === selected), 'aria-label': label, title: c.name },
      isOpen && shown ? h('span', { class: 'embers', 'aria-hidden': 'true' }, Array.from({ length: Math.min(25, shown) }, () => h('i'))) : null,
      h('span', { class: 'rating', 'aria-hidden': 'true' }, rating === null ? 'UNRATED' : ['RATED ', h('b', { class: 'num' }, usd(rating))]),
      h('span', { class: 'win', 'aria-hidden': 'true' }, h('span', { class: 'flag' }), h('span', { class: 'handle' })),
      h('span', { class: 'state' }, st.word),
      // the hit counter: checkouts this breaker stopped. It stays after the bots are gone, and after you close it
      h('span', { class: `tally${isOpen || shown || closedBy ? ' on' : ''}${shown || closedBy ? '' : ' zero'}${closedBy ? ' closed' : ''}`, 'aria-hidden': 'true' },
        h('span', { class: 'digits num' }, pad3(closedBy || shown)), h('span', { class: 'tl' }, closedBy ? 'reset' : 'stopped')), // white digits once you reset it: the quiet record of what it stopped
      h('span', { class: 'meters', 'aria-hidden': 'true' },
        h('span', { class: 'fuse', title: `${fill} of 5 rush checkouts`, style: `--f:${fill / 5}` }, h('i')),
        h('span', { class: `lamp${aiLit ? ' lit' : ''}` }, h('i'), 'AI')),
      // the directory label; on an open breaker it becomes a lockout tag that only your lever removes
      h('span', { class: `strip${isOpen ? ' tag' : ''}` }, isOpen ? h('span', { class: 'tag-head' }, 'TRIPPED') : null,
        h('b', {}, shortLabel(c.name)), h('span', { class: 'price num' }, usd(c.priceCents)),
        null));
    if (swing) swings.push([b, st.cls]);
    b.addEventListener('click', () => { selected = c.sku; userSelected = true; renderRack(true); renderOrder(true); });
    return b;
  });
  // a breaker you just reset drops its lockout tag: copy the old tag out before the redraw and let it fall
  const P = $('#panel').getBoundingClientRect();
  const drops = !motionOK() ? [] : swings.filter(([, cls]) => cls === '').map(([el]) => rack.querySelector(`.brk[data-sku="${CSS.escape(el.dataset.sku)}"] .strip.tag`)).filter(Boolean).map((t) => {
    const r = t.getBoundingClientRect(); const d = t.cloneNode(true);
    Object.assign(d.style, { position: 'absolute', left: `${r.left - P.left}px`, top: `${r.top - P.top}px`, width: `${r.width}px`, margin: '0', animation: 'none' });
    return d;
  });
  rack.replaceChildren(...(items.length ? items : [h('p', { class: 'empty' }, filter === 'all' ? 'No products yet. Import a price list below.' : 'No breaker is tripped. Every product is selling.')]));
  for (const d of drops) { $('#flyers').append(d); d.animate([{ transform: 'none', opacity: 1 }, { transform: 'translate(8px, 24px) rotate(8deg)', opacity: 1, offset: 0.35 }, { transform: 'translate(18px, 90px) rotate(22deg)', opacity: 1, offset: 0.7 }, { transform: 'translate(26px, 150px) rotate(32deg)', opacity: 0 }], { duration: 1600, easing: 'cubic-bezier(.45, 0, .8, .4)', fill: 'forwards' }).finished.then(() => d.remove()); }
  prevCls = new Map([...prevCls, ...next]);
  if (swings.length) requestAnimationFrame(() => requestAnimationFrame(() => {
    for (const [el, cls] of swings) { el.className = `brk ${cls}`; if (cls === '') { el.classList.add('relit'); setTimeout(() => el.classList.remove('relit'), 1600); } }
    if (swings.some(([, cls]) => cls === 'open')) { const box = $('.box'); box.classList.remove('jolt'); void box.offsetWidth; box.classList.add('jolt'); } // a trip jolts the box
  }));
}

// --- the work order for the selected breaker ---
function pickSelected() {
  if (selected && catalog.some((c) => c.sku === selected) && (userSelected || needsYou(catalog.find((c) => c.sku === selected)))) return;
  userSelected = false;
  const stoppedNow = catalog.filter(needsYou).sort((a, b) => b.updatedAt - a.updatedAt);
  selected = (stoppedNow[0] || catalog.find((c) => c.sku === TV) || catalog[0] || {}).sku || null;
}
function decisiveFirst(reasons) {
  const score = (r) => (/10x|slipped decimal/i.test(r.message) ? 3 : r.source === 'ai' ? 1 : 2);
  return [...reasons].sort((a, b) => score(b) - score(a));
}
let orderSig = '';
function renderOrder(force = false) {
  const c = catalog.find((x) => x.sku === selected);
  const sig = JSON.stringify(c || null) + [...pending].join('|') + (armed ? armed.key : '') + tour().current;
  if (!force && sig === orderSig) return;
  orderSig = sig;
  const box = $('#order');
  if (!c) { box.replaceChildren(h('p', { class: 'empty-note' }, 'Pick a breaker to see why it is on or open.')); return; }
  const st = STATUS[c.status] || STATUS.held;
  const k = (a) => `${a}:${c.sku}`;
  const busy = [...pending].some((p) => p.endsWith(`:${c.sku}`));
  const fixTo = c.status === 'tripped' ? (c.restoreCents ?? c.lastGoodCents) : c.lastGoodCents;
  const canFix = Number.isSafeInteger(fixTo) && fixTo > 0 && fixTo !== c.priceCents;
  const reasons = decisiveFirst(c.reasons || []);
  const reasonEl = (r) => {
    const aiBusy = r.code === 'UNVERIFIED' && AI_DOWN.test(r.message);
    const ai = r.source === 'ai';
    return h('div', { class: `reason${ai ? ' ai' : ''}` }, h('span', { class: `src ${ai ? 'src-ai' : 'src-rule'}` }, ai ? 'AI' : 'Code'),
      h('span', aiBusy ? { title: r.message } : {}, aiBusy ? AI_BUSY_REASON : ai ? r.message.replace(/\$(\d[\d,]*\.\d)(?!\d)/g, (m, a) => `$${a}0`) : r.message));
  };
  const decide = h('div', { class: 'decide' });
  if (stopped(c.status) || c.status === 'checking' || c.status === 'review') {
    if (canFix) {
      const voids = c.awaiting > 0 ? `Press and hold: restores the price and voids ${c.awaiting} waiting order${c.awaiting === 1 ? '' : 's'}` : (c.status === 'review' ? 'Press and hold: restores the old price' : 'Press and hold: fixes the price and turns checkout back on');
      const lever = holdLever(`Reset at ${usd(fixTo)}`, voids, (b) =>
        act(k('fix'), b, () => api(`/api/store/hold?store=${SID}`, { sku: c.sku, action: 'fix', priceCents: c.priceCents }),
          (r) => `${c.name} is selling at ${usd(fixTo)} again. Breaker reset.${r && r.voided ? ` ${r.voided} waiting order${r.voided === 1 ? '' : 's'} voided on PayPal.` : ''}`)
          .then((r) => { if (r && motionOK()) current(c.sku); })); // power runs through to PayPal again
      lever.disabled = busy;
      decide.append(lever);
    }
    if (c.status === 'tripped') {
      const resume = h('button', { class: 'btn', type: 'button' }, `Resume at ${usd(c.priceCents)}`);
      resume.disabled = busy;
      resume.addEventListener('click', () => act(k('resume'), resume, () => api(`/api/store/resume?store=${SID}`, { sku: c.sku }), `${c.name} is selling again; the breaker is re-armed.`));
      decide.append(resume);
    } else {
      const below = canFix && fixTo > c.priceCents ? `, ${usd(fixTo - c.priceCents)} under ${usd(fixTo)} on every sale` : '';
      const sell = h('button', { class: 'btn-link', type: 'button' }, `${c.status === 'review' ? `Confirm ${usd(c.priceCents)}` : `Sell at ${usd(c.priceCents)} instead`}${c.awaiting > 0 ? `, capture ${c.awaiting}` : ''}`);
      sell.disabled = busy;
      decide.append(armable(k('confirm'), sell, `Click again: sell at ${usd(c.priceCents)}${below}`,
        () => act(k('confirm'), sell, () => api(`/api/store/hold?store=${SID}`, { sku: c.sku, action: 'confirm', priceCents: c.priceCents }),
          (r) => `You confirmed ${usd(c.priceCents)}.${r && r.captured ? ` ${r.captured} waiting order${r.captured === 1 ? '' : 's'} captured on PayPal.` : ''}`)));
    }
  }
  if (c.awaiting > 0) {
    const v = h('button', { class: 'btn btn-primary', type: 'button' }, `Void ${c.awaiting}, release the money`);
    v.disabled = busy;
    v.addEventListener('click', () => act(k('void'), v, () => api(`/api/store/decide?store=${SID}`, { sku: c.sku, action: 'void' }), (r) => `Voided ${r.count} authorization${r.count === 1 ? '' : 's'} on PayPal. Nobody was charged.`));
    const honor = h('button', { class: 'btn', type: 'button' }, `Capture ${c.awaiting}`);
    honor.disabled = busy;
    decide.append(v);
    if (waitingActions(c.status).includes('honor')) decide.append(armable(k('honor'), honor, `Click again: capture ${c.awaiting} at ${usd(c.priceCents)}`, () => act(k('honor'), honor, () => api(`/api/store/decide?store=${SID}`, { sku: c.sku, action: 'honor' }), (r) => `Captured ${r.count} order${r.count === 1 ? '' : 's'} on PayPal.`)));
  }
  const ratio = canFix && fixTo > c.priceCents ? fixTo / c.priceCents : 0;
  const showMistake = (stopped(c.status) || c.status === 'review') && canFix;
  box.replaceChildren(...[
    h('div', { class: 'order-head' }, h('h2', {}, c.name), h('span', { class: `state-word ${st.cls}` }, st.long)),
    showMistake ? h('div', { class: 'mistake' }, h('span', { class: 'was num' }, usd(fixTo)), h('span', { class: 'arrow', 'aria-hidden': 'true' }, '→'),
      h('span', { class: 'now num' }, usd(c.priceCents)), ratio >= 1.5 ? h('span', { class: 'ratio' }, `${ratio >= 9.5 && ratio <= 10.5 ? '10' : ratio.toFixed(1).replace(/\.0$/, '')}× lower`) : null) : null,
    showMistake && decide.childElementCount ? decide : null, // the lever right under the price it fixes
    // the ending frame: after you close a breaker, say what it did while it was open
    !showMistake && c.status === 'live' && holdCounts(c.sku).closed ? [
      h('div', { class: 'mistake' }, h('span', { class: 'now num ok' }, usd(c.priceCents)), h('span', { class: 'ratio ok' }, 'Reset by you')),
      h('p', { class: 'outcome' }, `While it was tripped it stopped ${holdCounts(c.sku).closed} checkouts. None of them reached PayPal. It is selling at ${usd(c.priceCents)} again.`)] : null,
    !showMistake && c.status === 'live' && !holdCounts(c.sku).closed ? h('p', { class: 'empty-note' }, `Selling at ${usd(c.priceCents)}. Every check passed, so checkouts flow through to PayPal.`) : null,
    !events.length && presetCsv.decimal_slip ? (() => { const go = h('button', { class: 'btn btn-primary btn-start', type: 'button' }, h('span', { class: 'tn' }, '1'), 'Slip the TV’s price by one decimal'); go.disabled = pending.size > 0; go.addEventListener('click', () => runImport(presetCsv.decimal_slip, go)); return go; })() : null,
    // the decisive code reason, and the AI's own line when it lit its lamp; the rest fold away
    reasons.length ? (() => {
      const ai = reasons.find((r) => r.source === 'ai');
      const shownR = ai && ai !== reasons[0] ? [reasons[0], ai] : [reasons[0]];
      const rest = reasons.filter((r) => !shownR.includes(r));
      return h('div', { class: 'why' }, shownR.map(reasonEl),
        rest.length ? h('details', {}, h('summary', {}, `${rest.length} more check${rest.length > 1 ? 's' : ''} agree`), h('div', { class: 'why' }, rest.map(reasonEl))) : null);
    })() : null,
    c.awaiting > 0 ? (() => {
      const by = orders.filter((o) => o.sku === c.sku && o.honorUntil && ['awaiting_merchant', 'authorized'].includes(o.status)).map((o) => o.honorUntil);
      const when = by.length ? new Date(Math.min(...by)).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
      return h('div', { class: 'waiting' }, `${c.awaiting} authorized and waiting for you: money reserved on PayPal, nothing captured.${when ? ` Capture by ${when}.` : ''}`);
    })() : null,
    c.apiWaiting > 0 ? h('div', { class: 'waiting' }, `${c.apiWaiting} sale${c.apiWaiting === 1 ? '' : 's'} on your site wait${c.apiWaiting === 1 ? 's' : ''}: captured only if this goes live at the checked price.`) : null,
    !showMistake && decide.childElementCount ? decide : null].flat().filter(Boolean)); // replaceChildren would print a null as text
  if (showMistake && fixTo === c.priceCents * 10) slipHop(box.querySelector('.mistake .now'), `${c.sku}:${c.priceCents}:${fixTo}`);
}

// A slipped decimal, shown happening once per mistake: the point hops one digit left ($1299.0 becomes $129.90).
const slipShown = new Set();
function slipHop(el, key) {
  const text = el && el.textContent;
  const dot = text ? text.indexOf('.') : -1;
  if (!el || slipShown.has(key) || !motionOK() || dot < 2 || dot + 1 >= text.length || text.includes(',')) return;
  el.replaceChildren(...[...text].map((ch) => h('span', { class: 'ch' }, ch)));
  const kids = el.children; const pt = kids[dot]; const next = kids[dot + 1];
  const wPt = pt.getBoundingClientRect().width; const wNext = next.getBoundingClientRect().width;
  const opts = { duration: 650, delay: 450, easing: 'cubic-bezier(.5, 0, .3, 1)', fill: 'both' };
  pt.animate([{ transform: `translateX(${wNext}px)` }, { transform: `translate(${wNext / 2}px, -0.32em)`, offset: 0.5 }, { transform: 'none' }], opts);
  next.animate([{ transform: `translateX(${-wPt}px)` }, { transform: 'none' }], opts)
    .finished.then(() => slipShown.add(key)).catch(() => {});
  el.animate([{ color: 'var(--ink)' }, { color: 'var(--ink)', offset: 0.55 }, {}], { duration: 1100 });
}

// --- PayPal terminal and receipt totals ---
function renderTerminal() {
  if (counting) return; // the screen answers when the last bot has sparked
  const t = terminalState(events); const term = $('#terminal');
  $('#ppHeld').textContent = String(t.reached ? t.reached.authorized : 0); $('#ppHeld').dataset.v = $('#ppHeld').textContent;
  $('#ppLead').textContent = t.reached ? `of ${t.reached.total} bots reached PayPal` : 'orders at a tripped price';
  term.classList.toggle('reached', Boolean(t.reached));
  $('#ppStatus').textContent = t.readyCents ? `ready at ${usd(t.readyCents)}` : '';
  term.classList.toggle('ready', Boolean(t.readyCents));
}
function renderReadings(sum) {
  lastSum = sum;
  const a = sum.api || { capture: { n: 0, cents: 0 }, void: { n: 0, cents: 0 }, waiting: { n: 0, cents: 0 } };
  roll($('#ppCaptured'), sum.captured.cents + a.capture.cents, usd);
  roll($('#ppWaiting'), sum.awaiting.n + sum.authorized.n + a.waiting.n, String);
  roll($('#rVoided'), sum.voided.n + a.void.n, String);
  const bots = sum.refusedByChannel && sum.refusedByChannel.bot; // honest: the demo's own bots are part of the total
  $('#rBots').textContent = usd(bots ? bots.savedCents || 0 : 0);
  if (counting) { paintCounting(); return; }
  roll($('#rRefused'), sum.refusedCheckouts, String);
  roll($('#rKept'), sum.lossPreventedCents, usd);
}
// while the bots spark, the refused count and the kept total climb with them (never ahead of the server)
function paintCounting() {
  if (!counting || !lastSum) return;
  const r = swarmReadings(counting.pre, { refused: lastSum.refusedCheckouts, kept: lastSum.lossPreventedCents }, counting.shown - counting.base);
  const set = (el, v, fmt) => { el.dataset.v = String(v); el.textContent = fmt(v); };
  set($('#rRefused'), r.refused, String); set($('#rKept'), r.kept, usd);
}

// --- the receipt: grouped events, printed newest last ---
function grouped() {
  const out = [];
  for (const e of events) {
    const last = out[out.length - 1];
    if (last && GROUPABLE.includes(e.kind) && last.kind === e.kind && last.sku === e.sku) { last.items.push(e); continue; }
    out.push({ kind: e.kind, sku: e.sku, items: [e] });
  }
  return out;
}
function line(g) {
  const first = g.items[0]; const n = g.items.length; const amt = first.amountCents; const nm = g.sku ? shortName(g.sku) : '';
  switch (g.kind) {
    case 'CHECKOUT_REFUSED': return `${n} refused at ${usd(amt)}: ${nm}.`;
    case 'AUTHORIZED': return `${n} authorized, ${nm}. Reserved, not captured.`;
    case 'ORDER_CREATED': return `${n} PayPal order${n === 1 ? '' : 's'}, ${nm}.`;
    case 'VOIDED': return `${n} voided, ${nm}. Nobody charged.`;
    case 'CAPTURED': return `${n} captured, ${nm}.`;
    case 'AWAITING_MERCHANT': return `${n} waiting for you, ${nm}. Money reserved.`;
    case 'API_ALLOWED': return `${n} checkout${n === 1 ? '' : 's'} on your site cleared: ${nm}.`;
    case 'API_CAPTURE': return `${n} capture${n === 1 ? '' : 's'} cleared on your site: ${nm}.`;
    case 'API_VOID': return `${n} told to void on your site: ${nm}.`;
    case 'API_WAIT': return `${n} sale${n === 1 ? '' : 's'} on your site wait: ${nm}.`;
    case 'AI_ERROR': return 'AI busy: new prices it could not check are held safely.';
    case 'PRICE_HELD':
      if (!first.message.startsWith('Held ')) return `Tripped: ${nm} at ${usd(amt)}.`;
      if (AI_DOWN.test(first.message) || /never finished/.test(first.message)) return `AI busy: ${nm} stays held.`;
      return /Waiting for you/.test(first.message) ? `Held for you to confirm: ${nm}.` : `AI lamp lit: ${nm}.`;
    case 'PRICE_CHECKING': return `Checking: ${nm} at ${usd(amt)}.`;
    case 'PRICE_REVIEW': return `Review: ${nm} at ${usd(amt)}. Orders wait for you.`;
    case 'REFUNDED': return `${n} refunded on PayPal, ${nm}.`;
    case 'REVERSED': return `${n} reversed on PayPal, ${nm}.`;
    case 'EXPIRED': return `${n} authorization${n === 1 ? '' : 's'} expired, ${nm}.`;
    case 'ABANDONED': return `${n} checkout${n === 1 ? '' : 's'} abandoned, ${nm}.`;
    case 'PRICE_LIVE': return first.message.startsWith('AI check:') ? `AI vouched: ${nm} at ${usd(amt)}, selling.` : `Selling: ${nm} at ${usd(amt)}.`;
    case 'SWARM': { const m = /^(\d+) bots/.exec(first.message); return `${m ? m[1] : 'The'} bots rush ${nm}.`; }
    case 'MERCHANT_FIXED': return `You reset ${nm} to ${usd(amt)}.`;
    case 'MERCHANT_CONFIRMED': return `You confirmed ${nm} at ${usd(amt)}.`;
    case 'BREAKER_TRIPPED': return `Tripped: ${nm}, too many checkouts in a minute.`;
    case 'RESUMED': return `Resumed: ${nm}${amt ? ` at ${usd(amt)}` : ''}.`;
    case 'SWARM_DONE': { const m = /(\d+) refused.*?(\d+) authorized/.exec(first.message); return m ? `Bots gone: ${m[1]} refused, ${m[2]} to PayPal.` : first.message; }
    default: return AI_DOWN.test(first.message) ? first.message.replace(/Nothing could vouch for this price \(.*\) Confirm it to start selling\./, 'The AI is busy, so it is held safely.') : first.message;
  }
}
let printedSeq = 0; let receiptSig = '';
function renderReceipt() {
  const sig = `${events.length}:${lastSeq}`;
  if (sig === receiptSig || counting) return; // it prints when the last bot has sparked
  receiptSig = sig;
  const list = $('#timeline');
  if (!events.length) { list.replaceChildren(h('li', {}, h('span', { class: 'empty' }, 'Nothing printed yet. Start with step 1.'))); printedSeq = 0; return; }
  const groups = grouped().slice(-6).reverse(); // the latest six, newest on top, each line whole
  list.replaceChildren(...groups.map((g) => {
    const latest = g.items[g.items.length - 1];
    const ids = g.items.map((e) => e.paypalId).filter(Boolean);
    return h('li', { class: latest.seq > printedSeq ? 'new' : '' }, h('time', {}, clock(latest.at)),
      h('span', { class: STOP_KINDS.includes(g.kind) ? 'stop' : '' }, line(g),
        ids.length ? h('span', { class: 'id' }, ` ${ids[0]}${ids.length > 1 ? ` +${ids.length - 1}` : ''}`) : null));
  }));
  const newest = events[events.length - 1];
  if (newest.seq > printedSeq && ['AUTHORIZED', 'CAPTURED', 'API_CAPTURE'].includes(newest.kind)) { const t = $('#terminal'); t.classList.add('ping'); setTimeout(() => t.classList.remove('ping'), 900); }
  printedSeq = newest.seq;
  $('#rClock').textContent = clock(newest.at);
}

// The swarm target follows the product that most recently changed state, unless the merchant picked one by hand.
let userPicked = false;
function renderSwarmSelect() {
  const sel = $('#swarmSku');
  const prev = sel.value;
  const opt = (c) => `${shortLabel(c.name)}, ${usd(c.priceCents)}, ${STATUS[c.status]?.word || c.status}`;
  const labels = catalog.map((c) => `${c.sku}|${opt(c)}`).join('\n');
  if (sel.dataset.labels !== labels) {
    sel.replaceChildren(...catalog.map((c) => h('option', { value: c.sku }, opt(c))));
    sel.dataset.labels = labels;
  }
  const newest = Math.max(...catalog.map((c) => c.updatedAt));
  const recent = catalog.filter((c) => c.updatedAt === newest).length < catalog.length ? catalog.find((c) => c.updatedAt === newest) : null;
  if (!userPicked && recent) sel.value = recent.sku;
  else if (catalog.some((c) => c.sku === prev)) sel.value = prev;
}

function renderMoreDemos() {
  const pods = h('button', { class: 'btn', type: 'button' }, 'AI-only catch: new AirPods listed at $24.90');
  pods.addEventListener('click', () => runImport(presetCsv.new_products, pods));
  const lego = h('button', { class: 'btn', type: 'button' }, 'Fuse trip: a wrong price confirmed by mistake');
  lego.addEventListener('click', () => scene3(lego));
  $('#moreDemos').append(pods, lego);
}

// Scene 3: the LEGO set's price slips to $84.99 and is confirmed by mistake; the swarm is pointed at it, and its
// fuse trips the breaker after 5 checkouts.
async function scene3(button) {
  const r = await act('scene3', button, async () => {
    await api(`/api/store/price?store=${SID}`, { sku: 'LEGO-75192', price: '84.99' });
    await api(`/api/store/hold?store=${SID}`, { sku: 'LEGO-75192', action: 'confirm' });
    return true;
  }, 'The LEGO set is selling at $84.99 by mistake. Now release the bots on it.');
  if (r) { userPicked = true; $('#swarmSku').value = 'LEGO-75192'; selected = 'LEGO-75192'; userSelected = true; renderRack(true); renderOrder(true); $('#swarmBtn').focus(); }
}

// The store's checkout API key, for the merchant's own server. Masked until shown; the example uses a placeholder.
async function loadApiKey() {
  const { apiKey } = await api(`/api/store/apikey?store=${SID}`);
  const el = $('#apiKey'); let shown = false;
  const paint = () => { el.textContent = shown ? apiKey : `${apiKey.slice(0, 8)}${'•'.repeat(12)}${apiKey.slice(-4)}`; $('#revealKey').textContent = shown ? 'Hide' : 'Show'; };
  $('#revealKey').addEventListener('click', () => { shown = !shown; paint(); });
  $('#copyKey').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(apiKey); toast('API key copied. Keep it on your server only.', 'ok'); } catch { shown = true; paint(); toast('Copy is blocked here; the key is shown so you can select it.', 'error'); }
  });
  paint();
  $('#curl').textContent = `curl -X POST ${location.origin}/api/v1/check \\\n  -H "Authorization: Bearer $TRIPWIRE_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d '{"sku":"MX-ANKER-737","name":"Anker 737 Power Bank","priceCents":10999}'`;
}

// One refresh at a time; a request made while one is running is folded into a single follow-up. "generation" drops a
// response that started before a reset, so old events never come back.
let refreshing = null; let again = false; let generation = 0;
async function refresh() {
  if (refreshing) { again = true; return refreshing; }
  refreshing = (async () => {
    do {
      again = false;
      const gen = generation; const after = lastSeq;
      try {
        const st = await api(`/api/store/state?store=${SID}&after=${after}`);
        if (gen !== generation) continue;
        catalog = st.catalog; orders = st.orders || [];
        const fresh = st.timeline.filter((e) => e.seq > lastSeq);
        if (fresh.length) { events = events.concat(fresh); lastSeq = events[events.length - 1].seq; if (events.length > 600) events = events.slice(-600); }
        pickSelected();
        renderReadings(st.summary); renderRack(); renderOrder(); renderSwarmSelect(); renderReceipt(); renderSteps(); renderTerminal();
        const sync = $('#syncHint'); sync.textContent = 'Live'; sync.classList.remove('off');
      } catch (e) {
        const sync = $('#syncHint'); sync.classList.add('off');
        sync.textContent = e.status === 0 ? 'Offline, retrying…' : e.status === 429 ? 'Busy, slowing down…' : 'Sync error, retrying…';
      }
    } while (again);
  })();
  try { await refreshing; } finally { refreshing = null; }
}

async function loadPresets() {
  const { presets } = await api('/api/presets');
  $('#presets').replaceChildren(...presets.map((p) => {
    presetCsv[p.id] = p.csv;
    const lines = p.csv.trim().split('\n').length - 1;
    const b = h('button', { class: 'preset', type: 'button' }, h('div', {}, h('strong', {}, p.title), h('span', {}, `${lines} row${lines === 1 ? '' : 's'}`)));
    b.addEventListener('click', () => runImport(p.csv, b));
    return b;
  }));
}

async function runImport(csv, button) {
  const r = await act('import', button, () => api(`/api/store/import?store=${SID}`, { csv }));
  if (!r) return;
  $('#importResult').replaceChildren(...r.results.map((x) => h('div', {}, h('span', { class: 'mono' }, x.sku), ' ',
    x.error ? h('span', { style: 'color:var(--error)' }, x.error) : x.unchanged ? h('span', { class: 'faint' }, 'unchanged') : (STATUS[x.status]?.long || x.status))));
}

// The checkouts, drawn: each one runs from the shop along the top bus to its product's breaker. At an open breaker it
// sparks and stops; through a closed one it runs down to the bottom bus and on to PayPal.
// On a phone the buses run down the sides instead (the panel sets --flow: v), and the same paths turn sideways.
function pulses(sku, total, through) {
  const panel = $('#panel');
  const brk = panel.querySelector(`.brk[data-sku="${CSS.escape(sku)}"]`);
  const jack = panel.querySelector('.jack'); const term = $('#terminal');
  if (!brk || !jack || getComputedStyle(jack).display === 'none') return Promise.resolve();
  const vertical = getComputedStyle(panel).getPropertyValue('--flow').trim() === 'v';
  const P = panel.getBoundingClientRect();
  const rel = (r) => ({ x: r.left - P.left, y: r.top - P.top, w: r.width, h: r.height });
  const j = rel(jack.getBoundingClientRect()); const b = rel(brk.getBoundingClientRect());
  const win = rel(brk.querySelector('.win').getBoundingClientRect()); const t = rel(term.getBoundingClientRect());
  const jx = j.x + j.w / 2; const jy = j.y + j.h / 2;
  let start; let corner; let stopAt; let out; let end;
  if (vertical) {
    const cy = b.y + b.h / 2; const outX = P.width - jx;
    start = [jx, jy]; corner = [jx, cy]; stopAt = [win.x + win.w / 2, cy]; out = [outX, cy]; end = [outX, t.y];
  } else {
    const topY = 16; const botY = P.height - 16; const cx = b.x + b.w / 2;
    start = [jx, topY]; corner = [cx, topY]; stopAt = [cx, b.y - 3]; out = [cx, botY]; end = [t.x, botY]; // they pile up on top of the open breaker
  }
  const run = Math.hypot(corner[0] - start[0], corner[1] - start[1]);
  const layer = $('#flyers'); const runs = [];
  const frame = ([x, y], extra = {}) => ({ transform: `translate(${x}px, ${y}px)`, ...extra });
  const bump = () => {
    if (!counting || counting.sku !== sku) return;
    counting.shown++;
    const d = panel.querySelector(`.brk[data-sku="${CSS.escape(sku)}"] .digits`);
    if (!d) return;
    d.textContent = pad3(counting.shown); d.parentElement.classList.add('on'); d.parentElement.classList.remove('zero');
    const brkEl = d.closest('.brk');
    if (brkEl) { brkEl.classList.remove('hit'); void brkEl.offsetWidth; brkEl.classList.add('hit'); } // every hit flashes the breaker
    if (counting.shown <= 25 && brkEl) { let pile = brkEl.querySelector('.embers'); if (!pile) { pile = h('span', { class: 'embers', 'aria-hidden': 'true' }); brkEl.prepend(pile); } pile.append(h('i')); }
    d.animate([{ color: '#fff', transform: 'translateY(-2px)' }, { transform: 'none' }], { duration: 160, easing: 'ease-out' });
    paintCounting();
  };
  for (let i = 0; i < total; i++) {
    const pass = i < through;
    const dot = h('span', { class: `pulse${pass ? ' through' : ''}` });
    layer.append(dot);
    const delay = i * 70;
    if (pass) {
      runs.push(dot.animate([frame(start, { opacity: 0 }), frame(start, { opacity: 1, offset: 0.05 }), frame(corner, { offset: 0.45 }), frame(out, { offset: 0.68 }), frame(end, { opacity: 1, offset: 0.95 }), frame(end, { opacity: 0 })],
        { duration: 1100 + run * 0.6, delay, easing: 'cubic-bezier(.45, 0, .2, 1)', fill: 'both' }).finished.then(() => dot.remove()));
    } else {
      const a = dot.animate([frame(start, { opacity: 0 }), frame(start, { opacity: 1, offset: 0.04 }), frame(corner, { offset: 0.78 }), frame(stopAt, { opacity: 1 })],
        { duration: 520 + run * 0.75, delay, easing: 'cubic-bezier(.5, 0, .9, .6)', fill: 'both' }); // accelerates into the gap; hidden until it leaves
      runs.push(a.finished.then(() => {
        dot.remove(); bump();
        const sp = h('span', { class: 'spark' }); layer.append(sp);
        return sp.animate([frame(stopAt, { opacity: 1, transform: `translate(${stopAt[0]}px, ${stopAt[1]}px) scale(.35)` }), { opacity: 0, transform: `translate(${stopAt[0]}px, ${stopAt[1]}px) scale(1.6)` }],
          { duration: 260, easing: 'ease-out' }).finished.then(() => sp.remove());
      }));
    }
  }
  return Promise.all(runs);
}

// After you close a breaker, one glow of current runs from it down to PayPal: power restored, not a checkout.
function current(sku) {
  const panel = $('#panel'); const brk = panel.querySelector(`.brk[data-sku="${CSS.escape(sku)}"]`); const term = $('#terminal');
  if (!brk || getComputedStyle(panel).getPropertyValue('--flow').trim() === 'v') return;
  const P = panel.getBoundingClientRect(); const r = brk.getBoundingClientRect(); const t = term.getBoundingClientRect();
  const x = r.left - P.left + r.width / 2; const botY = P.height - 16; const endX = t.left - P.left;
  const glow = h('span', { class: 'surge' }); $('#flyers').append(glow);
  const at = (px, py, o = 1) => ({ transform: `translate(${px}px, ${py}px)`, opacity: o });
  panel.classList.add('energized'); setTimeout(() => panel.classList.remove('energized'), 2600);
  glow.animate([{ ...at(x, r.bottom - P.top, 0), offset: 0 }, { ...at(x, botY, 1), offset: 0.1 }, { ...at(endX, botY, 1), offset: 0.7 }, { ...at(endX, botY, 0), offset: 1 }], { duration: 1400 + (endX - x) * 0.8, easing: 'linear', fill: 'both' })
    .finished.then(() => {
      glow.remove(); const tm = $('#terminal'); tm.classList.add('ping'); setTimeout(() => tm.classList.remove('ping'), 1600);
      renderTerminal();
    });
}

async function runSwarm(sku = $('#swarmSku').value, button = $('#swarmBtn')) {
  if (!sku) return;
  const c = catalog.find((x) => x.sku === sku);
  selected = sku; userSelected = true; renderRack(true); renderOrder(true);
  // An open breaker refuses every checkout, so the bots can run the moment you click; otherwise wait for the outcome.
  const knownRefused = c && stopped(c.status) && motionOK();
  const pre = { refused: lastSum ? lastSum.refusedCheckouts : 0, kept: lastSum ? lastSum.lossPreventedCents : 0 };
  if (knownRefused) counting = { sku, shown: refusedSince(sku), base: refusedSince(sku), pre };
  const early = knownRefused ? pulses(sku, 25, 0) : null;
  const r = await act('swarm', button, () => api(`/api/store/swarm?store=${SID}`, { sku, n: 25 }),
    (x) => (x.authorized ? `${x.refused} of ${x.count} refused; ${x.authorized} reached PayPal before the fuse tripped. Nothing captured.` : `${x.refused} of ${x.count} refused before PayPal. Not one PayPal order.`));
  if (early) await early;
  else if (r && motionOK()) { const base = Math.max(0, refusedSince(sku) - (r.refused || 0)); counting = { sku, shown: base, base, pre }; paintCounting(); await pulses(sku, r.count, r.authorized || 0); }
  counting = null; renderRack(true); if (lastSum) renderReadings(lastSum); renderReceipt(); renderSteps();
  if (!r) return;
  // the PayPal screen answers the only question that matters: how many of the bots got through
  renderTerminal();
  if (!r.authorized) { const t = $('#terminal'); t.classList.remove('zero'); void t.offsetWidth; t.classList.add('zero'); }
  const [head, ...lines] = swarmSummary(r); // replaceChildren would print a null as the text "null"
  $('#swarmResult').replaceChildren(h('strong', {}, head), ...lines.map((t) => h('div', {}, t)), h('div', { class: 'faint' }, nameOf(sku)));
}

async function main() {
  $('#brandMark').append(brandMark());
  initTheme($('#themeBtn'));
  try { SID = await storeId(); } catch (e) { toast(e.message, 'error'); $('#syncHint').textContent = 'Could not start a demo store'; return; }
  $('#storeLink').href = `/store.html?store=${SID}`;
  $('#swarmBtn').addEventListener('click', () => runSwarm());
  for (const b of document.querySelectorAll('.filter button')) {
    b.addEventListener('click', () => {
      filter = b.dataset.filter;
      for (const o of document.querySelectorAll('.filter button')) o.setAttribute('aria-pressed', String(o === b));
      renderRack(true);
    });
  }
  renderMoreDemos();
  loadApiKey().catch(() => { $('#apiKey').textContent = 'Could not load the key. Reload to try again.'; });
  $('#swarmSku').addEventListener('change', () => { userPicked = true; });
  $('#importBtn').addEventListener('click', () => { const csv = $('#csvInput').value; if (csv.trim()) runImport(csv, $('#importBtn')); });
  twoStep($('#resetBtn'), 'Click again to reset', () => act('reset', $('#resetBtn'), async () => {
    const r = await api(`/api/store/reset?store=${SID}`, {});
    generation++; events = []; lastSeq = 0; receiptSig = ''; printedSeq = 0; userPicked = false; prevCls = new Map(); selected = null; userSelected = false;
    $('#importResult').replaceChildren(); $('#swarmResult').replaceChildren(); renderTerminal();
    return r;
  }, (r) => (r.voided ? `Demo store reset. ${r.voided} open authorization${r.voided === 1 ? ' was' : 's were'} voided on PayPal first.` : 'Demo store reset.')));
  loadPresets().then(() => { stepsSig = ''; renderSteps(); }).catch((e) => toast(e.message, 'error'));
  await refresh();
  // Poll while someone is looking. After 10 idle minutes polling pauses (it costs the store reads) until the next input.
  let lastInput = Date.now(); let paused = false;
  const wake = () => { lastInput = Date.now(); if (paused) { paused = false; $('#syncHint').textContent = 'Live'; refresh(); } };
  for (const ev of ['pointerdown', 'keydown', 'wheel', 'touchstart', 'focus']) window.addEventListener(ev, wake, { passive: true });
  setInterval(() => {
    if (document.hidden || paused) return;
    if (Date.now() - lastInput > IDLE_MS) { paused = true; $('#syncHint').textContent = 'Paused while idle. Click anywhere to resume.'; return; }
    refresh();
  }, POLL_MS);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) wake(); });
}

main();
