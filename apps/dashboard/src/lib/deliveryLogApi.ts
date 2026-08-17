// Typed client for the gateway's GET /api/delivery-log (see
// apps/gateway/src/routes/deliveryLog.ts). Kept as its own module rather
// than inlined in GapAudit.tsx so LiveFanoutView (or anything else) could
// reuse it without depending on a view component.

import type { GatewaySettings } from "./settings";

export type DeliveryLogEntryType = "event" | "gap" | "reconnect";

export interface DeliveryLogRow {
  id: number;
  feed_key: string;
  entry_type: DeliveryLogEntryType;
  seq: number | null;
  occurred_at: string;
  detail: string | null;
}

export interface FetchDeliveryLogOptions {
  feedKey?: string;
  entryType?: DeliveryLogEntryType;
  limit?: number;
}

export async function fetchDeliveryLog(
  settings: GatewaySettings,
  options: FetchDeliveryLogOptions = {},
): Promise<DeliveryLogRow[]> {
  const params = new URLSearchParams();
  if (options.feedKey) params.set("feedKey", options.feedKey);
  if (options.entryType) params.set("entryType", options.entryType);
  if (options.limit) params.set("limit", String(options.limit));

  const res = await fetch(`${settings.gatewayHttpBase}/api/delivery-log?${params.toString()}`, {
    headers: { Authorization: `Bearer ${settings.token}` },
  });
  if (!res.ok) {
    throw new Error(`delivery-log request failed: HTTP ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as DeliveryLogRow[];
}

export interface DeliveryLogCounts {
  event: number;
  gap: number;
  reconnect: number;
}

// True per-type totals, not "however many rows a LIMIT window happened to
// return" -- see apps/gateway/src/routes/deliveryLog.ts's own comment on
// why this had to be a separate endpoint: on a long-running feed, "event"
// rows arrive roughly once a second and silently push rare gap/reconnect
// rows outside any reasonably-sized row window. Any KPI claiming to be a
// total (not "recent N") must come from here, not from counting a row array.
export async function fetchDeliveryLogCounts(settings: GatewaySettings, feedKey: string): Promise<DeliveryLogCounts> {
  const params = new URLSearchParams({ feedKey });
  const res = await fetch(`${settings.gatewayHttpBase}/api/delivery-log/counts?${params.toString()}`, {
    headers: { Authorization: `Bearer ${settings.token}` },
  });
  if (!res.ok) {
    throw new Error(`delivery-log counts request failed: HTTP ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as DeliveryLogCounts;
}

// Mirrors buildFeedKey in apps/gateway/src/lib/feedKey.ts exactly (JSON
// array of [originUrl, category]) -- the dashboard needs to derive the
// same key the gateway itself uses to route/tag, or feedKey-filtered
// queries would silently never match anything.
export function buildFeedKey(originUrl: string, category: string): string {
  return JSON.stringify([originUrl, category]);
}
