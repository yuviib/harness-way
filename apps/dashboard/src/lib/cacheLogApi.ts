// Typed client for the gateway's GET /api/cache-log and /api/cache-log/stats
// (see apps/gateway/src/routes/cacheLog.ts). Same shape as deliveryLogApi.ts
// / agentLogApi.ts on purpose -- this reads Capability 2's cache_log table,
// a different subject, same kind of route.

import type { GatewaySettings } from "./settings";

export type CacheOutcome = "hit" | "miss" | "fail-open";

export interface CacheLogRow {
  id: number;
  scope: string;
  request_hash: string;
  outcome: CacheOutcome;
  byte_size: number;
  latency_ms: number;
  occurred_at: string;
}

export interface FetchCacheLogOptions {
  scope?: string;
  limit?: number;
}

export async function fetchCacheLog(settings: GatewaySettings, options: FetchCacheLogOptions = {}): Promise<CacheLogRow[]> {
  const params = new URLSearchParams();
  if (options.scope) params.set("scope", options.scope);
  if (options.limit) params.set("limit", String(options.limit));

  const res = await fetch(`${settings.gatewayHttpBase}/api/cache-log?${params.toString()}`, {
    headers: { Authorization: `Bearer ${settings.token}` },
  });
  if (!res.ok) {
    throw new Error(`cache-log request failed: HTTP ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as CacheLogRow[];
}

export interface CacheOutcomeStats {
  count: number;
  bytes: number;
  avgLatencyMs: number;
}

export interface CacheLogStats {
  hit: CacheOutcomeStats;
  miss: CacheOutcomeStats;
  failOpen: CacheOutcomeStats;
  totalRequests: number;
  hitRate: number;
  bytesSaved: number;
}

// True totals from a real aggregate query, not derived by summing a row
// window client-side -- same "counts must come from the server's own
// GROUP BY, not a LIMITed row array" discipline as
// fetchDeliveryLogCounts/fetchAgentLogCounts.
export async function fetchCacheLogStats(settings: GatewaySettings, scope?: string): Promise<CacheLogStats> {
  const params = new URLSearchParams();
  if (scope) params.set("scope", scope);
  const res = await fetch(`${settings.gatewayHttpBase}/api/cache-log/stats?${params.toString()}`, {
    headers: { Authorization: `Bearer ${settings.token}` },
  });
  if (!res.ok) {
    throw new Error(`cache-log stats request failed: HTTP ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as CacheLogStats;
}
