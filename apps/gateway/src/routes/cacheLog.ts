// Read-only API for the dashboard's CacheMetrics view to query the
// cache_log D1 table (see migrations/0002_cache_log.sql). Same shape,
// same auth/CORS story, and same reasoning as deliveryLog.ts -- this is
// the discrete-call-cache counterpart to that route, not a different kind
// of route. Rows are written internally by routes/relay.ts via
// lib/cacheLog.ts's logCacheAccess, not by an external POST, so (like
// deliveryLog.ts, unlike agentLog.ts) this file only ever reads.

import { corsHeaders } from "../lib/cors";
import { isAuthorized } from "./subscribe";

const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 100;

export function handleCacheLogPreflight(request: Request): Response {
  return new Response(null, { status: 204, headers: corsHeaders(request, "GET, OPTIONS", "Authorization") });
}

export async function handleCacheLog(request: Request, env: Env): Promise<Response> {
  const cors = corsHeaders(request, "GET, OPTIONS", "Authorization");
  if (!(await isAuthorized(request, env)).authorized) {
    return new Response("Unauthorized", { status: 401, headers: cors });
  }

  const url = new URL(request.url);
  const scope = url.searchParams.get("scope");
  const requestedLimit = Number(url.searchParams.get("limit") ?? DEFAULT_LIMIT);
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number.isFinite(requestedLimit) ? requestedLimit : DEFAULT_LIMIT));

  const where = scope ? "WHERE scope = ?" : "";
  const query = `SELECT id, scope, request_hash, outcome, byte_size, latency_ms, occurred_at FROM cache_log ${where} ORDER BY id DESC LIMIT ?`;
  const binds = scope ? [scope, limit] : [limit];

  const { results } = await env.DB.prepare(query)
    .bind(...binds)
    .all();

  return new Response(JSON.stringify(results), {
    status: 200,
    headers: { "content-type": "application/json", ...cors },
  });
}

// Aggregate stats, not a row window -- same "true totals need their own
// query" reasoning as deliveryLog.ts's/agentLog.ts's own *Counts routes.
// bytesSaved sums byte_size only over 'hit' rows: each hit is a real
// origin round-trip (of that many response bytes) the caller did NOT have
// to make, which is the literal, defensible meaning of "saved" here --
// not an estimate or a multiplier applied after the fact.
export async function handleCacheLogStats(request: Request, env: Env): Promise<Response> {
  const cors = corsHeaders(request, "GET, OPTIONS", "Authorization");
  if (!(await isAuthorized(request, env)).authorized) {
    return new Response("Unauthorized", { status: 401, headers: cors });
  }

  const url = new URL(request.url);
  const scope = url.searchParams.get("scope");

  const query = scope
    ? "SELECT outcome, COUNT(*) as n, COALESCE(SUM(byte_size), 0) as bytes, COALESCE(AVG(latency_ms), 0) as avg_latency_ms FROM cache_log WHERE scope = ? GROUP BY outcome"
    : "SELECT outcome, COUNT(*) as n, COALESCE(SUM(byte_size), 0) as bytes, COALESCE(AVG(latency_ms), 0) as avg_latency_ms FROM cache_log GROUP BY outcome";
  const { results } = await env.DB.prepare(query)
    .bind(...(scope ? [scope] : []))
    .all<{ outcome: string; n: number; bytes: number; avg_latency_ms: number }>();

  const byOutcome: Record<"hit" | "miss" | "fail-open", { count: number; bytes: number; avgLatencyMs: number }> = {
    hit: { count: 0, bytes: 0, avgLatencyMs: 0 },
    miss: { count: 0, bytes: 0, avgLatencyMs: 0 },
    "fail-open": { count: 0, bytes: 0, avgLatencyMs: 0 },
  };
  for (const row of results) {
    if (row.outcome in byOutcome) {
      byOutcome[row.outcome as keyof typeof byOutcome] = { count: row.n, bytes: row.bytes, avgLatencyMs: row.avg_latency_ms };
    }
  }

  const totalRequests = byOutcome.hit.count + byOutcome.miss.count + byOutcome["fail-open"].count;
  const hitRate = totalRequests > 0 ? byOutcome.hit.count / totalRequests : 0;

  return new Response(
    JSON.stringify({
      hit: byOutcome.hit,
      miss: byOutcome.miss,
      failOpen: byOutcome["fail-open"],
      totalRequests,
      hitRate,
      bytesSaved: byOutcome.hit.bytes,
    }),
    { status: 200, headers: { "content-type": "application/json", ...cors } },
  );
}
