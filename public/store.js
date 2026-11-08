import { $, h, icon, usd, api, storeId, toast, initTheme } from './common.js';

const SDK_URL = 'https://www.sandbox.paypal.com/web-sdk/v6/core';
let SID = '';
let products = [];
let sdk = null; let paypalSession = null; let venmoSession = null;
let active = null; // { sku, channel } for the checkout in progress
const messages = new Map(); // sku -> { text, kind }


function setMessage(sku, text, kind = '') { messages.set(sku, { text, kind }); const el = document.querySelector(`[data-msg="${CSS.escape(sku)}"]`); if (el) { el.textContent = text; el.className = `order-msg ${kind}`; } }

async function createOrder(sku, channel) {
  try {
    const r = await api(`/api/store/checkout?store=${SID}`, { sku, channel });
    return { orderId: r.paypalOrderId };
  } catch (e) {
    setMessage(sku, e.status === 409 ? `Checkout paused: ${e.body?.message || 'the seller is confirming this price'}. You have not been charged.` : e.message, 'bad');
    loadProducts();
    throw e;
  }
}

async function start(sku, channel) {
  const session = channel === 'venmo' ? venmoSession : paypalSession;
  if (!session || active) return;
  active = { sku, channel };
  setMessage(sku, `Opening ${channel === 'venmo' ? 'Venmo' : 'PayPal'}…`);
  try { await session.start({ presentationMode: 'auto' }, createOrder(sku, channel)); } catch (e) {
    if (!messages.get(sku)?.kind) setMessage(sku, 'Checkout did not open. Try again.', 'bad');
    active = null;
  }
}

async function onApprove(data) {
  const sku = active?.sku;
  try {
    const r = await api(`/api/store/approve?store=${SID}`, { paypalOrderId: data.orderId });
    if (sku) setMessage(sku, `Payment authorized (${r.authorizationId}). The seller captures it once the price is confirmed; until then nothing is taken.`, 'ok');
    toast('Payment authorized on PayPal.', 'ok');
  } catch (e) {
    if (sku) setMessage(sku, e.body?.code === 'HELD' ? (e.body.message || 'The seller is confirming this price. You have not been charged.') : e.message, 'bad');
  } finally { active = null; loadProducts(); }
}

function sessionCallbacks() {
  return {
    onApprove,
    onCancel: () => { if (active) setMessage(active.sku, 'Checkout cancelled. Nothing was charged.'); active = null; },
    onError: (err) => { if (active && !messages.get(active.sku)?.kind) setMessage(active.sku, `PayPal reported an error${err?.code ? ` (${err.code})` : ''}.`, 'bad'); active = null; },
  };
}

function payArea(p) {
  // the product's open breaker, as the merchant sees it in Tripwire, and a plain promise to the buyer
  if (!p.available) return h('div', { class: 'paused' }, h('span', { class: 'mini', 'aria-hidden': 'true' }), h('strong', {}, 'Price under review'), h('span', {}, 'Checkout is paused, so you won’t be charged.'));
  if (!sdk) return h('div', { class: 'faint', style: 'font-size:13px' }, paypalOff ? 'Checkout is off on this deployment.' : 'PayPal checkout is loading…');
  const area = h('div', { class: 'pay' });
  const pp = document.createElement('paypal-button'); pp.setAttribute('type', 'pay'); pp.className = 'paypal-gold';
  pp.addEventListener('click', () => start(p.sku, 'paypal'));
  area.append(pp);
  if (venmoSession) {
    const vb = document.createElement('venmo-button'); vb.setAttribute('type', 'pay'); vb.className = 'venmo-blue';
    vb.addEventListener('click', () => start(p.sku, 'venmo'));
    area.append(vb);
  }
  return area;
}

let sig = '';
let paypalOff = false;
const FEATURED = 'TV-BRAVIA-65';
function render(force = false) {
  const s = JSON.stringify(products) + Boolean(sdk) + Boolean(venmoSession) + paypalOff;
  if (!force && s === sig) return; sig = s;
  const box = $('#products');
  if (!products.length) { box.replaceChildren(h('div', { class: 'empty' }, 'No products.')); return; }
  // the TV leads the catalog as this week's feature; every item keeps a catalog number
  const ordered = [...products].sort((a, b) => (b.sku === FEATURED) - (a.sku === FEATURED));
  box.replaceChildren(...ordered.map((p) => {
    const m = messages.get(p.sku);
    const no = String(products.indexOf(p) + 1).padStart(2, '0');
    return h('article', { class: `product${p.available ? '' : ' is-paused'}${p.sku === FEATURED ? ' featured' : ''}` },
      h('div', { class: 'item-meta' }, h('span', {}, p.sku === FEATURED ? `Feature of the week · ${p.category || 'Product'}` : p.category || 'Product'), h('span', { class: 'item-no' }, `No. ${no}`)),
      h('h3', {}, p.name),
      h('p', { class: 'desc' }, p.description || ''),
      h('div', { class: 'price' }, usd(p.priceCents)),
      payArea(p),
      h('div', { class: `order-msg ${m?.kind || ''}`, 'data-msg': p.sku }, m?.text || ''));
  }));
}

async function loadProducts() {
  try { products = (await api(`/api/store/products?store=${SID}`)).products; render(); } catch (e) { toast(e.message, 'error'); }
}

function loadScript(src) {
  return new Promise((resolve, reject) => { const s = document.createElement('script'); s.src = src; s.async = true; s.onload = resolve; s.onerror = () => reject(new Error('The PayPal SDK did not load.')); document.head.append(s); });
}

async function initPayPal() {
  const { paypalClientId } = await api('/api/config');
  if (!paypalClientId) { paypalOff = true; render(true); $('#notice').textContent = 'PayPal is not configured on this deployment, so checkout is off. The merchant console still works.'; return; }
  await loadScript(SDK_URL);
  sdk = await window.paypal.createInstance({ clientId: paypalClientId, components: ['paypal-payments', 'venmo-payments'], pageType: 'checkout' });
  const methods = await sdk.findEligibleMethods({ currencyCode: 'USD' });
  paypalSession = sdk.createPayPalOneTimePaymentSession(sessionCallbacks());
  if (methods.isEligible('venmo')) venmoSession = sdk.createVenmoOneTimePaymentSession(sessionCallbacks());
  render();
}

async function main() {
  $('#brandMark').append(icon('store'));
  $('#consoleLink').prepend(icon('shield'));
  initTheme($('#themeBtn'), 'shop.theme');
  try { SID = await storeId(); } catch (e) { toast(e.message, 'error'); return; }
  $('#consoleLink').href = `/?store=${SID}`;
  await loadProducts();
  initPayPal().catch((e) => { $('#notice').textContent = `${e.message} The merchant console still works.`; sdk = null; paypalOff = true; render(true); });
  // Availability refresh while someone is looking; pauses after 10 idle minutes until the next input.
  let lastInput = Date.now();
  for (const ev of ['pointerdown', 'keydown', 'wheel', 'touchstart', 'focus']) window.addEventListener(ev, () => { lastInput = Date.now(); }, { passive: true });
  setInterval(() => { if (!document.hidden && !active && Date.now() - lastInput < 10 * 60_000) loadProducts(); }, 4000);
}

main();
