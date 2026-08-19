-- Cache-access log for Capability 2's discrete tool-call cache: every real
-- /relay call, logged with its outcome so the dashboard's CacheMetrics view
-- can show hit rate and bytes saved over real history, not just whatever's
-- live in one browser tab. Same append-only-log shape as delivery_log and
-- agent_log on purpose (see agent_log.sql's own comment on why this
-- project keeps each concern in its own table rather than one wide one):
-- this is a genuinely different subject (a caller's cache outcome) from
-- either of those.
CREATE TABLE cache_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  -- 'fail-open' is distinct from 'miss': both result in a real origin call,
  -- but 'fail-open' specifically means the cache-index lookup itself
  -- failed (see cacheClient.ts's lookupCache) rather than cleanly reporting
  -- "not present" -- worth keeping visible in the log rather than folding
  -- into 'miss' silently, since a sustained run of fail-opens signals a
  -- real ContextIndex problem a plain miss rate wouldn't surface.
  outcome TEXT NOT NULL CHECK (outcome IN ('hit', 'miss', 'fail-open')),
  byte_size INTEGER NOT NULL,
  latency_ms INTEGER NOT NULL,
  occurred_at TEXT NOT NULL
);

CREATE INDEX idx_cache_log_scope_occurred_at ON cache_log (scope, occurred_at);
