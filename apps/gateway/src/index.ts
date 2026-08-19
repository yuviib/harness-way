import { handleAgentLogCounts, handleAgentLogGet, handleAgentLogPost, handleAgentLogPreflight } from "./routes/agentLog";
import { handleCacheLog, handleCacheLogPreflight, handleCacheLogStats } from "./routes/cacheLog";
import { handleDeliveryLog, handleDeliveryLogCounts, handleDeliveryLogPreflight } from "./routes/deliveryLog";
import { handleRelay } from "./routes/relay";
import { handleSubscribe } from "./routes/subscribe";

export { FeedRelay } from "./do/FeedRelay";
export { ContextIndex } from "./do/ContextIndex";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/subscribe") {
      return handleSubscribe(request, env);
    }
    if (url.pathname === "/relay") {
      if (request.method !== "POST") {
        return new Response("POST a JSON body {originUrl, scope, tool, arguments} to /relay\n", { status: 200 });
      }
      return handleRelay(request, env);
    }
    if (url.pathname === "/api/cache-log" || url.pathname === "/api/cache-log/stats") {
      if (request.method === "OPTIONS") {
        return handleCacheLogPreflight();
      }
      return url.pathname.endsWith("/stats") ? handleCacheLogStats(request, env) : handleCacheLog(request, env);
    }
    if (url.pathname === "/api/delivery-log" || url.pathname === "/api/delivery-log/counts") {
      if (request.method === "OPTIONS") {
        return handleDeliveryLogPreflight();
      }
      return url.pathname.endsWith("/counts") ? handleDeliveryLogCounts(request, env) : handleDeliveryLog(request, env);
    }
    if (url.pathname === "/api/agent-log" || url.pathname === "/api/agent-log/counts") {
      if (request.method === "OPTIONS") {
        return handleAgentLogPreflight();
      }
      if (url.pathname.endsWith("/counts")) {
        return handleAgentLogCounts(request, env);
      }
      if (request.method === "POST") {
        return handleAgentLogPost(request, env);
      }
      return handleAgentLogGet(request, env);
    }
    return new Response(
      "MCP Relay Harness gateway.\n" +
        "WS /subscribe?originUrl=...&category=...&lastSeenSeq=0\n" +
        'POST /relay {"originUrl":"...","scope":"...","tool":"...","arguments":{...}}\n',
      { status: 200 },
    );
  },
};
