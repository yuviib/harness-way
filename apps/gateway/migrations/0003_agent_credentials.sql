-- Per-agent scoped credentials, replacing "one shared token grants access
-- to everything" with individually issued, individually revocable, and
-- individually scoped access. token_hash is a SHA-256 hex digest, never
-- the plaintext token itself -- same principle SUBSCRIBE_TOKEN's own
-- comparison already applies, extended to storage: this table is
-- compromise-worth-less even if the whole database leaked.
--
-- scope_origin_host / scope_category: NULL means "not restricted on this
-- dimension" -- a credential can be scoped to one exact origin+category
-- pair, or left open, distinctly per credential. can_subscribe/can_relay
-- separately gate the two routes, since a caller that only ever needs to
-- watch a feed has no legitimate reason to also be able to trigger
-- /relay's discrete tool-call path, and vice versa.
--
-- revoked_at, not a DELETE: revoking a credential needs to be immediate
-- and auditable (when, and implicitly by the fact a row still exists,
-- that it once existed at all) -- deleting the row would make "was this
-- credential ever issued" unanswerable later, exactly the kind of gap a
-- system calling itself audit-safe can't have in its own access control.
CREATE TABLE agent_credentials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  scope_origin_host TEXT,
  scope_category TEXT,
  can_subscribe INTEGER NOT NULL DEFAULT 1,
  can_relay INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE INDEX idx_agent_credentials_token_hash ON agent_credentials (token_hash);
