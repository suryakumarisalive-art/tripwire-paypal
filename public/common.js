// Shared by the console and the store. All text from the server or a CSV is rendered with textContent, never innerHTML.
export const $ = (sel, root = document) => root.querySelector(sel);

// h('div', { class: 'x', onclick }, 'text', childNode, ...) — builds DOM safely.
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const ICONS = {
  live: 'M20 6 9 17l-5-5',
  held: 'M10 15V9M14 15V9M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z',
  checking: 'M21 12a9 9 0 1 1-6.22-8.56',
  tripped: 'M13 2 3 14h9l-1 8 10-12h-9l1-8zM2 2l20 20',
  bot: 'M12 8V4H8M4 12h16v8H4zM2 14h2M20 14h2M9 13v2M15 13v2M8 8h8a2 2 0 0 1 2 2v2H6v-2a2 2 0 0 1 2-2z',
  upload: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12',
  store: 'M3 9l1-5h16l1 5M3 9h18v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9zM9 21v-6h6v6',
  reset: 'M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5',
  sun: 'M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4',
  moon: 'M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z',
  external: 'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14 21 3',
  shield: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z',
  card: 'M2 5h20v14H2zM2 10h20',
  x: 'M18 6 6 18M6 6l12 12',
  money: 'M12 1v22M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6',
  undo: 'M3 7v6h6M21 17a9 9 0 0 0-15-6.7L3 13',
  play: 'M5 3l14 9-14 9V3z',
  // product categories for the demo store (Lucide-style outlines)
  tv: 'M3 7h18v12H3zM16 3l-4 4-4-4',
  headphones: 'M3 14h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a9 9 0 0 1 18 0v7a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3',
  camera: 'M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3zM12 17a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
  home: 'M3 10l9-7 9 7v10a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1V10z',
  cup: 'M17 8h1a4 4 0 1 1 0 8h-1M3 8h14v9a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4V8zM6 2v2M10 2v2M14 2v2',
  briefcase: 'M3 7h18v13H3zM16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2',
  keyboard: 'M2 6h20v12H2zM6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10',
  box: 'M21 8 12 3 3 8v8l9 5 9-5V8zM3 8l9 5 9-5M12 13v8',
  battery: 'M2 7h16v10H2zM22 11v2M6 11v2M10 11v2',
};

export function icon(name, cls = 'ico') {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('class', cls); svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round');
  const p = document.createElementNS(ns, 'path'); p.setAttribute('d', ICONS[name] || ICONS.shield); svg.append(p);
  return svg;
}

export function usd(cents) {
  if (!Number.isSafeInteger(cents)) return '—';
  const sign = cents < 0 ? '-' : ''; const a = Math.abs(cents);
  return `${sign}$${Math.floor(a / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${String(a % 100).padStart(2, '0')}`;
}

export class ApiError extends Error { constructor(status, message, body) { super(message); this.status = status; this.body = body; } }

export async function api(path, body) {
  const init = body === undefined ? { method: 'GET' } : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
  let r;
  try { r = await fetch(path, { ...init, credentials: 'same-origin' }); } catch { throw new ApiError(0, 'Network error. Check your connection.'); }
  let j = {};
  try { j = await r.json(); } catch { /* empty */ }
  if (!r.ok) throw new ApiError(r.status, j.error || j.message || `Request failed (${r.status}).`, j);
  return j;
}

const KEY = 'tripwire.store';
// One demo store per browser. The store page receives it in ?store= so it can open in another tab or device.
// Ids are signed by the server; one it no longer accepts (an old or edited id) is replaced with a fresh store.
export async function storeId() {
  const remember = (id) => { try { localStorage.setItem(KEY, id); } catch { /* private mode */ } return id; };
  const valid = async (id) => {
    try { await api(`/api/store/products?store=${id}`); return true; } catch (e) { if (e.status === 400) return false; throw e; }
  };
  const fromUrl = new URLSearchParams(location.search).get('store');
  if (fromUrl && /^[a-f0-9]{32}$/.test(fromUrl) && await valid(fromUrl)) return remember(fromUrl);
  let saved = null;
  try { saved = localStorage.getItem(KEY); } catch { /* private mode */ }
  if (saved && /^[a-f0-9]{32}$/.test(saved) && saved !== fromUrl && await valid(saved)) return saved;
  const { storeId: id } = await api('/api/session', {});
  return remember(id);
}

export function toast(message, kind = 'info') {
  let box = $('#toasts');
  if (!box) { box = h('div', { id: 'toasts', class: 'toasts', role: 'status', 'aria-live': 'polite' }); document.body.append(box); }
  const t = h('div', { class: `toast toast-${kind}` }, message);
  box.append(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 300); }, kind === 'error' ? 6000 : 3500);
}

// Light/dark: follows the system until the visitor picks one.
// key: where the visitor's choice is remembered (the demo shop keeps its own, so the two windows never flip together)
export function initTheme(button, key = 'tripwire.theme') {
  const root = document.documentElement;
  const saved = (() => { try { return localStorage.getItem(key); } catch { return null; } })();
  if (saved === 'light' || saved === 'dark') root.dataset.theme = saved;
  const current = () => root.dataset.theme || 'light'; // light by default (docs/DESIGN.md); dark only on request
  // a word, not a sun/moon glyph: it says what the click does
  const paint = () => { button.textContent = current() === 'dark' ? 'Light' : 'Dark'; button.setAttribute('aria-label', current() === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'); };
  button.addEventListener('click', () => { root.dataset.theme = current() === 'dark' ? 'light' : 'dark'; try { localStorage.setItem(key, root.dataset.theme); } catch { /* ignore */ } paint(); });
  paint();
}

export function timeAgo(at) {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return new Date(at).toLocaleTimeString();
}
