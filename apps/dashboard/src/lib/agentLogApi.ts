// Typed client for the gateway's GET /api/agent-log (see
// apps/gateway/src/routes/agentLog.ts). Same shape as deliveryLogApi.ts on
// purpose -- this reads a different table with a different subject, but
// it's the same kind of route.

import type { GatewaySettings } from "./settings";

export type AgentActionType = "resync" | "reconnect_verified" | "order_check" | "summary" | "error";

export interface AgentLogRow {
  id: number;
  feed_key: string;
  agent_name: string;
  agent_role: string;
  action_type: AgentActionType;
  seq: number | null;
  detail: string | null;
  occurred_at: string;
}

export interface FetchAgentLogOptions {
  feedKey?: string;
  limit?: number;
}

export async function fetchAgentLog(settings: GatewaySettings, options: FetchAgentLogOptions = {}): Promise<AgentLogRow[]> {
  const params = new URLSearchParams();
  if (options.feedKey) params.set("feedKey", options.feedKey);
  if (options.limit) params.set("limit", String(options.limit));

  const res = await fetch(`${settings.gatewayHttpBase}/api/agent-log?${params.toString()}`, {
    headers: { Authorization: `Bearer ${settings.token}` },
  });
  if (!res.ok) {
    throw new Error(`agent-log request failed: HTTP ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as AgentLogRow[];
}

export type AgentLogCounts = Record<AgentActionType, number>;

// True per-action-type totals, not however many rows fetchAgentLog's own
// row window happens to return -- see agentLogApi.ts's counterpart in the
// gateway (routes/agentLog.ts) for why this has to be a separate query.
export async function fetchAgentLogCounts(settings: GatewaySettings, feedKey: string): Promise<AgentLogCounts> {
  const params = new URLSearchParams({ feedKey });
  const res = await fetch(`${settings.gatewayHttpBase}/api/agent-log/counts?${params.toString()}`, {
    headers: { Authorization: `Bearer ${settings.token}` },
  });
  if (!res.ok) {
    throw new Error(`agent-log counts request failed: HTTP ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as AgentLogCounts;
}
