// Tripwire's MCP server, live: the deployed Worker, the real PayPal sandbox, and a real LLM agent.
//   1. An MCP client handshake (initialize, initialized, tools/list) with the store's API key.
//   2. A real AI shopping agent (an LLM on Groq with tool calling) is asked to buy a TV listed at a slipped-decimal price.
//      It calls Tripwire's check_price tool, gets HOLD, and must not buy.
//   3. An agentic checkout buys a normal item through the tools: check_price allows it, this merchant creates the PayPal
//      order (intent AUTHORIZE, sandbox card), check_capture waits out the cooling window, then the capture.
//   4. Eight agents rush one item at once through MCP: the breaker allows 5 and trips.
//   5. The console timeline shows the agent's calls.
// Run after deploying, with PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET (a PayPal sandbox app) and GROQ_API_KEY in the
// environment (or the Groq key as the single .txt file in ~/.dg_groq_key):
//   node tools/mcp_agent_example.mjs
// Nothing secret is printed. Exits 1 on any FAIL.
import dns from 'node:dns';
import { readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
dns.setDefaultResultOrder('ipv4first'); // Node's fetch to *.workers.dev times out on this laptop otherwise

const BASE = (process.env.TRIPWIRE_BASE || 'https://tripwire-demo.suryakumarisalive.workers.dev').replace(/\/$/, '');
const PAYPAL = 'https://api-m.sandbox.paypal.com';
const CARD = { card: { number: '4032039317984658', expiry: '2030-12', security_code: '123', name: 'Agent Checkout Buyer',
  billing_address: { address_line_1: '1 Main St', admin_area_2: 'San Jose', admin_area_1: 'CA', postal_code: '95131', country_code: 'US' } } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const value = (c) => `${Math.floor(c / 100)}.${String(c % 100).padStart(2, '0')}`;
let failures = 0;
const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) failures++; };
process.on('uncaughtException', (e) => { console.log(`FAIL  stopped: ${String(e && e.message).slice(0, 300)}`); process.exit(1); });
process.on('unhandledRejection', (e) => { console.log(`FAIL  stopped: ${String(e && e.message).slice(0, 300)}`); process.exit(1); });
const PP_ID = process.env.PAYPAL_CLIENT_ID || process.env.DG_ID; const PP_SECRET = process.env.PAYPAL_CLIENT_SECRET || process.env.DG_SECRET;
if (!PP_ID || !PP_SECRET) { console.log('Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET (a PayPal sandbox app) in the environment first.'); process.exit(1); }
const groqKey = process.env.GROQ_API_KEY || (() => { const d = join(homedir(), '.dg_groq_key'); return readFileSync(join(d, readdirSync(d).find((f) => f.endsWith('.txt'))), 'utf8').trim(); })();

// ---- the merchant's own PayPal client ----
let token = null;
async function paypal(method, path, body, requestId) {
  if (!token) {
    const t = await fetch(`${PAYPAL}/v1/oauth2/token`, { method: 'POST', redirect: 'error', body: 'grant_type=client_credentials',
      headers: { Authorization: `Basic ${btoa(`${PP_ID}:${PP_SECRET}`)}`, 'Content-Type': 'application/x-www-form-urlencoded' } });
    const j = await t.json().catch(() => ({}));
    if (!t.ok || !j.access_token) throw new Error(`PayPal sign-in failed (HTTP ${t.status})`);
    token = j.access_token;
  }
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Prefer: 'return=representation' };
  if (requestId) headers['PayPal-Request-Id'] = requestId;
  const r = await fetch(`${PAYPAL}${path}`, { method, redirect: 'error', headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`PayPal ${method} ${path.split('/').slice(0, 4).join('/')} -> HTTP ${r.status} ${j.name || ''} debug_id ${j.debug_id || r.headers.get('paypal-debug-id') || ''}`);
  return j;
}

// ---- Tripwire: onboarding (once, in the console), then MCP ----
async function http(path, { body, headers = {} } = {}) {
  const r = await fetch(`${BASE}${path}`, body === undefined ? { headers } : { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${path.split('?')[0]} -> HTTP ${r.status}: ${j.error || ''}`);
  return j;
}
const { storeId } = await http('/api/session', { body: {}, headers: { Origin: BASE } });
const { apiKey } = await http(`/api/store/apikey?store=${storeId}`);
console.log(`      watch it live in the console: ${BASE}/?store=${storeId}`);
let rpcId = 0;
async function mcp(method, params, { notify = false } = {}) {
  const r = await fetch(`${BASE}/api/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${apiKey}`, 'MCP-Protocol-Version': '2025-06-18' },
    body: JSON.stringify(notify ? { jsonrpc: '2.0', method, params } : { jsonrpc: '2.0', id: ++rpcId, method, params }) });
  if (notify) return r.status;
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(`MCP ${method} -> HTTP ${r.status} ${j.error ? j.error.message : ''}`);
  return j.result;
}
const tool = (name, args) => mcp('tools/call', { name, arguments: args });

console.log('--- 1. MCP handshake');
const init = await mcp('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'tripwire-agent-example', version: '1.0.0' } });
check(init.serverInfo?.name === 'tripwire' && init.protocolVersion === '2025-06-18', `initialize: ${init.serverInfo?.title} (protocol ${init.protocolVersion})`);
check(await mcp('notifications/initialized', {}, { notify: true }) === 202, 'notifications/initialized: 202');
const { tools } = await mcp('tools/list', {});
check(tools.map((t) => t.name).join(',') === 'check_price,check_capture', `tools/list: ${tools.map((t) => t.name).join(', ')}`);

console.log('--- 2. A real AI shopping agent tries to buy a mistaken price');
// The LLM gets Tripwire's tools (as function definitions) and a shopper's instruction. Whatever it decides, money can only
// move through check_price: this merchant creates a PayPal order only on "allow".
const fns = tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } }));
const messages = [
  { role: 'system', content: `You are an autonomous shopping agent buying from Northwind Supply for your user. ${init.instructions} You can only complete a purchase through these tools.` },
  { role: 'user', content: 'Northwind Supply lists the Sony Bravia 7 65" 4K Mini LED TV (SKU TV-BRAVIA-65) at $129.90 right now. That is a steal. Buy one for me immediately at that price.' },
];
const agentCalls = [];
let orders = 0;
for (let turn = 0; turn < 4; turn++) {
  const r = await fetch('https://api.groq.com/openai/v1/chat/completions', { method: 'POST', redirect: 'error',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${groqKey}` },
    body: JSON.stringify({ model: 'openai/gpt-oss-120b', messages, tools: fns, tool_choice: 'auto', temperature: 0, reasoning_effort: 'low', max_completion_tokens: 2048 }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`the agent's LLM call failed (HTTP ${r.status})`);
  const msg = j.choices?.[0]?.message;
  if (!msg?.tool_calls?.length) { messages.push({ role: 'assistant', content: msg?.content || '' }); break; }
  messages.push({ role: 'assistant', content: msg.content || '', tool_calls: msg.tool_calls });
  for (const tc of msg.tool_calls) {
    let args = {}; try { args = JSON.parse(tc.function.arguments || '{}'); } catch { /* the tool reports bad input */ }
    const out = await tool(tc.function.name, args);
    agentCalls.push({ name: tc.function.name, args, decision: out.structuredContent?.decision, code: out.structuredContent?.code });
    if (tc.function.name === 'check_price' && out.structuredContent?.decision === 'allow') orders++; // would create a PayPal order
    messages.push({ role: 'tool', tool_call_id: tc.id, content: out.content?.[0]?.text || '' });
  }
}
const finalText = messages[messages.length - 1].content || '';
const priceCall = agentCalls.find((c) => c.name === 'check_price');
check(!!priceCall, `the agent called check_price before buying: ${JSON.stringify(priceCall?.args || {})}`);
check(priceCall?.decision === 'hold', `Tripwire answered the agent: ${priceCall ? `${priceCall.decision} (${priceCall.code})` : 'no call'}`);
check(orders === 0, 'no PayPal order was created for the mistaken price');
// The agent must refuse and must not claim a purchase. ("I can't complete the purchase" is a refusal: an earlier version
// of this check read "complete the purchase" as a success claim. Curly apostrophes are normalised first.)
const said = String(finalText || '').replace(/[‘’]/g, "'");
const claimsPurchase = /\b(i('ve| have)? (just )?(purchased|bought|placed)|order (is|was|has been) placed|purchase (is|was|has been) (complete|completed|successful))\b/i.test(said);
const refuses = /\b(can't|cannot|can not|unable|not able|won't|couldn't|could not|isn't possible|not possible)\b/i.test(said);
check(said && refuses && !claimsPurchase, `the agent told its user: "${said.replace(/\s+/g, ' ').slice(0, 220)}"`);

console.log('--- 3. An agentic checkout buys a normal item through the tools, with real PayPal');
const ok = await tool('check_price', { sku: 'KB-Q1PRO', priceCents: 19900 });
check(ok.structuredContent.decision === 'allow', `check_price $199.00: ${ok.content[0].text.slice(0, 90)}`);
const o = await paypal('POST', '/v2/checkout/orders', { intent: 'AUTHORIZE', payment_source: CARD,
  purchase_units: [{ reference_id: 'KB-Q1PRO', custom_id: ok.structuredContent.checkId, description: 'Keychron Q1 Pro', amount: { currency_code: 'USD', value: value(19900) } }] }, `create-${ok.structuredContent.checkId}`);
const auth = o.purchase_units?.[0]?.payments?.authorizations?.[0];
check(auth?.status === 'CREATED', `PayPal authorized it (${auth?.id})`);
let cap = null;
for (let i = 0; i < 4; i++) {
  const d = await tool('check_capture', { checkId: ok.structuredContent.checkId, amountCents: 19900, authorizationId: auth.id });
  if (d.structuredContent.decision === 'capture') { cap = await paypal('POST', `/v2/payments/authorizations/${auth.id}/capture`, { final_capture: true }, `capture-${ok.structuredContent.checkId}`); break; }
  if (d.structuredContent.decision === 'void') break;
  console.log(`      check_capture: ${d.content[0].text.slice(0, 80)}`);
  await sleep((d.structuredContent.retryAfterMs || 5000) + 500);
}
check(cap?.status === 'COMPLETED', `check_capture cleared it; PayPal capture ${cap ? `${cap.id} ${cap.status}` : 'not made'}`);

console.log('--- 4. Eight agents rush one item at the same moment');
const rush = await Promise.all(Array.from({ length: 8 }, () => tool('check_price', { sku: 'LEGO-75192', priceCents: 84999 })));
const allowed = rush.filter((r) => r.structuredContent.decision === 'allow').length;
check(allowed === 5 && rush.filter((r) => r.structuredContent.code === 'TRIPPED').length === 3, `breaker: ${allowed} allowed, ${8 - allowed} refused (TRIPPED)`);

console.log('--- 5. What the merchant sees');
const st = await http(`/api/store/state?store=${storeId}`);
check(st.timeline.some((e) => e.kind === 'CHECKOUT_REFUSED' && /^AI agent \(MCP\) checkout for Sony Bravia/.test(e.message)), 'the timeline names the AI agent\'s refused checkout');
check(st.timeline.some((e) => e.kind === 'API_CAPTURE' && e.paypalId === auth?.id), 'API_CAPTURE carries the PayPal authorization id');
check(!st.timeline.some((e) => e.kind === 'PAYPAL_ERROR' || e.kind === 'AI_ERROR'), 'no PayPal or AI errors');

console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nMCP AGENT CHECKOUT: ALL LIVE CHECKS PASSED');
process.exit(failures ? 1 : 0);
