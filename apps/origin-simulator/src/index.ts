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
  params?: { category?: string };
}

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method !== "POST" || url.pathname !== "/mcp") {
      return new Response(
        "POST a JSON-RPC subscriptions/listen request to /mcp, e.g.\n" +
          '{"jsonrpc":"2.0","id":1,"method":"subscriptions/listen","params":{"category":"resource_changed"}}\n',
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
