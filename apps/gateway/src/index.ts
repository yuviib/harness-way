import { handleAgentLogCounts, handleAgentLogGet, handleAgentLogPost, handleAgentLogPreflight } from "./routes/agentLog";
import { handleDeliveryLog, handleDeliveryLogCounts, handleDeliveryLogPreflight } from "./routes/deliveryLog";
import { handleSubscribe } from "./routes/subscribe";

export { FeedRelay } from "./do/FeedRelay";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/subscribe") {
      return handleSubscribe(request, env);
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
    return new Response("MCP Relay Harness gateway. WS /subscribe?originUrl=...&category=...&lastSeenSeq=0\n", {
      status: 200,
    });
  },
};
