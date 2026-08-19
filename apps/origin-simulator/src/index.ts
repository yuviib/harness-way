// Synthetic MCP origin for local dev and eval. Implements just the
// `subscriptions/listen` request/long-lived-SSE-response shape -- the one
// piece of the protocol the relay actually touches -- not the full
// MCP session lifecycle (no `initialize` capability negotiation, no other
// methods). That's a deliberate scope decision: the relay is transparent to
// whatever rides over `subscriptions/listen`'s SSE stream, so faithfully
// simulating session setup wouldn't exercise anything the relay's own logic
// depends on. Clearly labeled as synthetic per the plan's own README
// requirement -- this is never meant to look like a real MCP server.

function sseEvent(event: string, data: unknown, id: number): string {
  return `id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: { category?: string; name?: string; arguments?: Record<string, unknown> };
}

function jsonRpcError(id: number | string | null | undefined, code: number, message: string, status: number): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: id ?? null, error: { code, message } }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Global (module-scope, so it persists across requests within one isolate,
// same lifetime assumption as any other in-memory dev/eval fixture in this
// simulator) counter of real tools/call invocations -- deliberately NOT
// keyed by resourceId or reset per call. This is the one honest signal the
// synthetic backend can offer that a caller can independently check: if the
// gateway's cache is genuinely serving a second identical request from
// cache rather than re-calling this origin, this counter will NOT have
// advanced between the two responses. If it silently re-hit the origin
// (a caching bug), the second response's originCallSeq would visibly differ
// even though the resourceId and content are otherwise identical. Proving
// "served from cache" this way -- by an independently observable side
// effect the cache layer cannot fake -- is a real correctness check, not
// asserted from wishful thinking.
let toolCallSeq = 0;

// Artificial latency on every real tool call, simulating a non-trivial
// origin (a slow downstream lookup, a rate-limited third-party API) --
// otherwise a cache's whole benefit (skip the slow part on a hit) is
// unobservable in a synthetic demo where the "real" call is already instant.
const SYNTHETIC_TOOL_LATENCY_MS = 250;

// One deterministic synthetic tool: same resourceId always produces the
// same snapshot content (byte-for-byte, modulo the always-advancing
// originCallSeq/computedAt fields that exist specifically to prove a given
// response came from a real call vs. a cache hit -- see toolCallSeq above).
// Scope deliberately narrow, same discipline as subscriptions/listen above:
// this simulates just enough of a real MCP tools/call to exercise the
// relay's caching logic, not a general tool-execution sandbox.
async function handleToolsCall(body: JsonRpcRequest): Promise<Response> {
  const name = body.params?.name;
  if (name !== "resource_lookup") {
    return jsonRpcError(body.id, -32602, `Unknown tool "${name ?? ""}" -- this simulator only implements "resource_lookup"`, 400);
  }
  const resourceId = body.params?.arguments?.resourceId;
  if (typeof resourceId !== "string" || resourceId.length === 0) {
    return jsonRpcError(body.id, -32602, "arguments.resourceId (non-empty string) is required", 400);
  }

  await sleep(SYNTHETIC_TOOL_LATENCY_MS);
  toolCallSeq += 1;

  // Deterministic pseudo-content derived from resourceId alone, so two
  // real (non-cached) calls for the SAME resourceId still produce
  // byte-identical `snapshot` content -- what varies between them is only
  // originCallSeq/computedAt, which is exactly what makes those two fields
  // useful as a "was this actually a fresh call" signal rather than noise.
  let hash = 0;
  for (let i = 0; i < resourceId.length; i++) {
    hash = (hash * 31 + resourceId.charCodeAt(i)) | 0;
  }
  const snapshot = `resource-${resourceId}-state-${Math.abs(hash)}`;

  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      id: body.id ?? null,
      result: {
        content: [{ type: "text", text: JSON.stringify({ resourceId, snapshot }) }],
        originCallSeq: toolCallSeq,
        computedAt: new Date().toISOString(),
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method !== "POST" || url.pathname !== "/mcp") {
      return new Response(
        "POST a JSON-RPC request to /mcp, e.g.\n" +
          '{"jsonrpc":"2.0","id":1,"method":"subscriptions/listen","params":{"category":"resource_changed"}}\n' +
          '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"resource_lookup","arguments":{"resourceId":"42"}}}\n',
        { status: 200 },
      );
    }

    let body: JsonRpcRequest;
    try {
      body = await request.json();
    } catch {
      return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: -32700, message: "Parse error" } }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }

    if (body.method === "tools/call") {
      return handleToolsCall(body);
    }

    if (body.method !== "subscriptions/listen") {
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: body.id ?? null,
          error: { code: -32601, message: "Method not found" },
        }),
        { status: 404, headers: { "content-type": "application/json" } },
      );
    }

    const category = body.params?.category ?? "default";
    let seq = 0;
    let closed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        const tick = () => {
          if (closed) return;
          seq += 1;
          // Every 3rd tick is a keep-alive comment instead of an event,
          // matching the real spec's guidance for a long-lived
          // subscriptions/listen stream: an SSE comment line to hold the
          // connection open between genuine notifications.
          if (seq % 3 === 0) {
            controller.enqueue(encoder.encode(": ping\n\n"));
          } else {
            const notification = {
              jsonrpc: "2.0",
              method: `notifications/${category}`,
              params: { seq, category, changedAt: new Date().toISOString() },
            };
            controller.enqueue(encoder.encode(sseEvent(category, notification, seq)));
          }
          timer = setTimeout(tick, 800);
        };
        timer = setTimeout(tick, 200);
      },
      cancel() {
        // fires when the reader (the relay's FeedRelay Durable Object) disconnects
        closed = true;
        if (timer) clearTimeout(timer);
      },
    });

    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      },
    });
  },
};
