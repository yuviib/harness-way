-- Delivery log: every delivered event, feed-level gap, and successful
-- reconnect after an outage, logged durably and queryably (per PLAN.md).
-- Deliberately does NOT log per-socket burst-cap gaps (see
-- FeedRelay.ts's flushOutboundQueues) -- those scale with subscriber count
-- and per-batch timing, not with real feed history, and logging them here
-- would make write volume proportional to fan-out rather than to actual
-- upstream event volume.
CREATE TABLE delivery_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  feed_key TEXT NOT NULL,
  entry_type TEXT NOT NULL CHECK (entry_type IN ('event', 'gap', 'reconnect')),
  seq INTEGER,
  occurred_at TEXT NOT NULL,
  detail TEXT
);

-- Matches the dashboard's expected query shape (Week 4): "this feed's
-- history, in order" and "this feed's history since some point in time".
CREATE INDEX idx_delivery_log_feed_key_occurred_at ON delivery_log (feed_key, occurred_at);
