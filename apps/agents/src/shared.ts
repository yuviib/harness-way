// Shared config, feed-key derivation, and gateway I/O helpers for every
// agent in this app. Each agent is a real, independent consumer of the
// relay: it opens its own /subscribe WebSocket (the exact same endpoint a
// browser client or any other MCP-side consumer would use) and reports
// what it does back to the gateway over plain HTTP, via the agent_log
// route added alongside this app.

export interface Config {
  gatewayHttpBase: string;
  gatewayWsBase: string;
  token: string;
  originUrl: string;
  category: string;
}

// `||`, not `??`: a bare `KEY=` line in .env is read by Node's --env-file
// as an empty string, not undefined, so a nullish-only fallback would
// silently accept "" instead of the intended default (see
// summarizerAgent.ts's own comment on exactly this, caught for real there).
function requireEnv(name: string, fallback: string): string {
  return process.env[name] || fallback;
}

export function loadConfig(): Config {
  return {
    gatewayHttpBase: requireEnv("GATEWAY_HTTP_BASE", "http://127.0.0.1:8787"),
    gatewayWsBase: requireEnv("GATEWAY_WS_BASE", "ws://127.0.0.1:8787"),
    token: requireEnv("SUBSCRIBE_TOKEN", "dev-only-shared-secret"),
    originUrl: requireEnv("ORIGIN_URL", "http://127.0.0.1:8794/mcp"),
    category: requireEnv("CATEGORY", "resource_changed"),
  };
}

// Must derive identically to apps/gateway/src/lib/feedKey.ts's
// buildFeedKey -- duplicated here rather than imported, since this is a
// separate npm package with no dependency on the gateway's source. Kept
// as a one-line pure function specifically so the two staying in sync is
// easy to verify by eye.
export function buildFeedKey(originUrl: string, category: string): string {
  return JSON.stringify([originUrl, category]);
}

export function subscribeUrl(config: Config, lastSeenSeq: number): string {
  const params = new URLSearchParams({
    originUrl: config.originUrl,
    category: config.category,
    lastSeenSeq: String(lastSeenSeq),
    token: config.token,
  });
  return `${config.gatewayWsBase}/subscribe?${params.toString()}`;
}

export interface BufferedEvent {
  seq: number;
  upstreamId: string | null;
  event: string | null;
  data: string;
}
export type RelayMessage =
  | { type: "replay"; events: BufferedEvent[] }
  | { type: "gap"; oldestAvailableSeq: number }
  | ({ type: "event" } & BufferedEvent);

export type ActionType = "resync" | "reconnect_verified" | "order_check" | "summary" | "error";

export interface LogAction {
  agentName: string;
  agentRole: string;
  actionType: ActionType;
  seq?: number | null;
  detail?: string | null;
}

// Fire-and-forget from the agent's own perspective: a failed log write
// should never stop the agent from doing its actual job (verifying
// replay, watching order, summarizing). Logged to stderr, not thrown.
export async function logAction(config: Config, action: LogAction): Promise<void> {
  const feedKey = buildFeedKey(config.originUrl, config.category);
  try {
    const res = await fetch(`${config.gatewayHttpBase}/api/agent-log`, {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${config.token}` },
      body: JSON.stringify({ feedKey, ...action }),
    });
    if (!res.ok) {
      console.error(`[${action.agentName}] agent-log POST failed: HTTP ${res.status} ${await res.text()}`);
    }
  } catch (err) {
    console.error(`[${action.agentName}] agent-log POST failed:`, err);
  }
}

export function connect(config: Config, lastSeenSeq: number): WebSocket {
  return new WebSocket(subscribeUrl(config, lastSeenSeq));
}

export function parseMessage(raw: string): RelayMessage {
  return JSON.parse(raw) as RelayMessage;
}
