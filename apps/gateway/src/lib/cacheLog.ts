// D1 writer for cache_log (see migrations/0002_cache_log.sql). Called
// directly (awaited) from routes/relay.ts rather than via ctx.waitUntil --
// unlike FeedRelay's delivery-log writes, which happen deep inside a live
// WebSocket fan-out loop that must never block on a cross-service D1 call,
// relay.ts is a single request/response HTTP route with nothing further to
// do after this write completes, and no separate `ctx: ExecutionContext`
// is threaded into route handlers in this codebase (see index.ts's fetch
// signature) for a waitUntil to attach to anyway. Same synchronous-await
// pattern routes/agentLog.ts already uses for its own D1 write.
export type CacheLogOutcome = "hit" | "miss" | "fail-open";

export interface CacheLogEntry {
  scope: string;
  requestHash: string;
  outcome: CacheLogOutcome;
  byteSize: number;
  latencyMs: number;
  occurredAt: string;
}

export async function logCacheAccess(db: D1Database, entry: CacheLogEntry): Promise<void> {
  await db
    .prepare("INSERT INTO cache_log (scope, request_hash, outcome, byte_size, latency_ms, occurred_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(entry.scope, entry.requestHash, entry.outcome, entry.byteSize, entry.latencyMs, entry.occurredAt)
    .run();
}
