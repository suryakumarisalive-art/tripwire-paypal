// Tripwire as an MCP server (Model Context Protocol, Streamable HTTP, stateless, JSON responses): the merchant gate as two
// tools an AI agent or an agentic checkout calls before PayPal moves money.
//   check_price   before the PayPal order is created (wraps POST /api/v1/check)
//   check_capture before the PayPal authorization is captured (wraps POST /api/v1/capture-check)
// Where it fits: PayPal's Agent Ready has the merchant's MCP server implement complete_checkout, and the UCP-with-PayPal
// path has the merchant's server call Orders v2 (intent AUTHORIZE) in its complete step. Neither documents a price check
// before that call; check_price is that check. The transport (POST only, auth, Origin) is in router.mjs; this module is
// pure: message in, message out, with call(method, args) reaching the store.
export const MCP_VERSIONS = Object.freeze(['2025-06-18', '2025-03-26']);
const SERVER = { name: 'tripwire', title: 'Tripwire: price-mistake circuit breaker for PayPal checkout', version: '1.0.0' };
const INSTRUCTIONS = 'Call check_price before you create a PayPal order for an item, and only create one when the decision is allow, '
  + 'for exactly priceCents, with intent AUTHORIZE. Call check_capture before you capture that authorization: capture only on '
  + 'capture, void on void, and on wait ask again after retryAfterMs. On a hold with code CHECKING, SUPERSEDED or RESET, ask '
  + 'again in a few seconds. On any other hold, do not buy: tell the user the merchant is checking that price.';

export const TOOLS = Object.freeze([
  {
    name: 'check_price',
    title: 'Check a price before PayPal',
    description: 'Ask Tripwire whether an item may be sold at a price, before creating the PayPal order. Returns decision '
      + '"allow" (create the order for exactly priceCents with intent AUTHORIZE; keep checkId) or "hold" (do not create an '
      + 'order: the price looks like a mistake, a breaker tripped, or the merchant is reviewing it). Code "REVIEW" is an allow '
      + 'whose capture waits for the merchant. Prices are whole US cents.',
    inputSchema: {
      type: 'object',
      properties: {
        sku: { type: 'string', description: 'The item SKU: 1-40 letters, digits, dot, dash or underscore.', maxLength: 40 },
        currency: { type: 'string', enum: ['USD'], description: 'Optional; Tripwire checks USD prices only.' },
        priceCents: { type: 'integer', minimum: 0, description: 'The price of ONE unit the checkout will charge, in whole US cents.' },
        quantity: { type: 'integer', minimum: 1, maximum: 1000, description: 'Units in this order (default 1). Create the PayPal order for exactly amountCents = priceCents × quantity.' },
        name: { type: 'string', description: 'Product name (needed the first time a SKU is seen).', maxLength: 120 },
        costCents: { type: 'integer', minimum: 0, description: 'Optional unit cost in cents; it can only add a below-cost hold.' },
        category: { type: 'string', maxLength: 60 },
        description: { type: 'string', maxLength: 300 },
      },
      required: ['sku', 'priceCents'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: 'check_capture',
    title: 'Check before capturing a PayPal authorization',
    description: 'Ask Tripwire before capturing a PayPal authorization made after check_price allowed it. Returns "capture", '
      + '"wait" (ask again after retryAfterMs) or "void" (void the authorization; never capture it).',
    inputSchema: {
      type: 'object',
      properties: {
        checkId: { type: 'string', description: 'The checkId that check_price returned.', maxLength: 80 },
        amountCents: { type: 'integer', minimum: 1, description: 'The whole amount on the PayPal authorization (every unit), in whole US cents.' },
        authorizationId: { type: 'string', description: 'The PayPal authorization id.', maxLength: 64 },
      },
      required: ['checkId', 'amountCents', 'authorizationId'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
]);

const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
const ok = (id, result) => ({ jsonrpc: '2.0', id, result });
const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');
const int = (v) => (typeof v === 'number' ? v : NaN);

// One JSON-RPC message in; the response object, or null for a notification (the transport answers 202 then).
// call(method, args) runs a store method and throws { status, message } on a store error.
export async function mcpRespond(msg, { call, ip = '' }) {
  // a response from the client (this server sends no requests, so there is nothing to match): accepted, nothing to answer
  if (msg && typeof msg === 'object' && !Array.isArray(msg) && msg.jsonrpc === '2.0' && msg.method === undefined && 'id' in msg && ('result' in msg || 'error' in msg)) return null;
  if (!msg || typeof msg !== 'object' || Array.isArray(msg) || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    return rpcError(msg && typeof msg === 'object' && !Array.isArray(msg) ? msg.id : null, -32600, 'Invalid Request: send one JSON-RPC 2.0 message.');
  }
  if (!('id' in msg)) return null; // notifications/initialized, cancellations: nothing to answer
  if (!(typeof msg.id === 'string' || Number.isInteger(msg.id))) return rpcError(null, -32600, 'Invalid Request: id must be a string or an integer.');
  const { id, method } = msg;
  const params = msg.params && typeof msg.params === 'object' ? msg.params : {};
  switch (method) {
    case 'initialize': {
      const asked = str(params.protocolVersion, 20);
      return ok(id, { protocolVersion: MCP_VERSIONS.includes(asked) ? asked : MCP_VERSIONS[0], capabilities: { tools: { listChanged: false } }, serverInfo: SERVER, instructions: INSTRUCTIONS });
    }
    case 'ping': return ok(id, {});
    case 'tools/list': return ok(id, { tools: TOOLS });
    case 'tools/call': {
      const args = params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments) ? params.arguments : {};
      if (params.name === 'check_price') {
        if (args.currency !== undefined && args.currency !== 'USD') return ok(id, { content: [{ type: 'text', text: 'Invalid input: Tripwire checks USD prices only.' }], isError: true });
        return ok(id, await toolResult(() => call('apiCheck', {
          sku: str(args.sku, 41), name: str(args.name, 120), priceCents: int(args.priceCents),
          costCents: args.costCents === undefined || args.costCents === null ? null : int(args.costCents),
          category: str(args.category, 60), description: str(args.description, 300), via: 'mcp', ip,
          quantity: args.quantity === undefined || args.quantity === null ? 1 : int(args.quantity),
        }), describeCheck));
      }
      if (params.name === 'check_capture') {
        return ok(id, await toolResult(() => call('captureCheck', { checkId: str(args.checkId, 80), amountCents: int(args.amountCents), authorizationId: str(args.authorizationId, 65) || null }), describeCapture));
      }
      return rpcError(id, -32602, `Unknown tool: ${str(params.name, 60) || '(none)'}. Tools: check_price, check_capture.`);
    }
    default: return rpcError(id, -32601, `Method not found: ${str(method, 60)}`);
  }
}

// A tool's answer: the gate's JSON as structuredContent plus one plain sentence. Bad input is a tool error (isError), so
// the agent can read it and correct the call; anything else (rate limits, server errors) is a JSON-RPC error upstream.
async function toolResult(run, describe) {
  try {
    const r = await run();
    return { content: [{ type: 'text', text: describe(r) }], structuredContent: r, isError: false };
  } catch (e) {
    if (e && e.status === 400) return { content: [{ type: 'text', text: `Invalid input: ${e.message}` }], isError: true };
    throw e;
  }
}

function describeCheck(r) {
  if (r.decision === 'allow') {
    const amount = r.quantity > 1 ? `${usd(r.amountCents)} (${r.quantity} × ${usd(r.priceCents)})` : usd(r.priceCents);
    return r.code === 'REVIEW'
      ? `ALLOW (REVIEW): sell at ${amount}, but the merchant is reviewing this price, so capture waits. Create the PayPal order for exactly ${amount} with intent AUTHORIZE; checkId ${r.checkId}.`
      : `ALLOW: create the PayPal order for exactly ${amount} with intent AUTHORIZE; checkId ${r.checkId}.`;
  }
  return `HOLD (${r.code}): do not create a PayPal order. ${r.message}`;
}
function describeCapture(r) {
  if (r.decision === 'capture') return `CAPTURE: ${r.message}`;
  if (r.decision === 'void') return `VOID (${r.reason}): void the authorization, never capture it. ${r.message}`;
  return `WAIT (${r.reason}): ask again in ${Math.ceil((r.retryAfterMs || 0) / 1000)} s. ${r.message}`;
}
const usd = (c) => `$${(c / 100).toFixed(2)}`;
