-- Agent activity log: every decision a demo agent (apps/agents) makes in
-- response to a live notification or a gap marker, logged durably and
-- queryably so the dashboard's Agents view can show history, not just
-- whatever happens to be live in a browser tab at the moment.
--
-- Separate table from delivery_log rather than a shared one with a wider
-- entry_type CHECK: delivery_log is the relay's own record of what it did
-- (event/gap/reconnect), independent of who's listening. agent_log is a
-- consumer's record of how it reacted, a genuinely different concern with
-- a different shape (agent_name/agent_role, free-text detail rather than a
-- seq-keyed entry_type enum) -- mixing them would blur "what the relay
-- guarantees" with "what one particular consumer chose to do about it".
CREATE TABLE agent_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  feed_key TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  agent_role TEXT NOT NULL,
  action_type TEXT NOT NULL CHECK (action_type IN ('resync', 'reconnect_verified', 'order_check', 'summary', 'error')),
  seq INTEGER,
  detail TEXT,
  occurred_at TEXT NOT NULL
);

CREATE INDEX idx_agent_log_feed_key_occurred_at ON agent_log (feed_key, occurred_at);
