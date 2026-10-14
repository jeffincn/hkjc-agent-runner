-- Downstream agent fan-out (issue #5). Agent becomes a multi-subscriber hub;
-- worker pushes only to this agent; downstream agents subscribe here.

CREATE TABLE IF NOT EXISTS agent_subscribers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  url TEXT NOT NULL UNIQUE,
  secret TEXT,                                      -- nullable HMAC secret
  enabled INTEGER NOT NULL DEFAULT 1,
  event_filter TEXT NOT NULL DEFAULT '[]',          -- JSON array of event types; empty = all
  active_window TEXT NOT NULL DEFAULT 'always',      -- always | raceday
  window_before_sec INTEGER NOT NULL DEFAULT 10800,  -- raceday: seconds before first post
  quiet_start TEXT,                                 -- HH:MM Asia/Hong_Kong, nullable
  quiet_end TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  -- Per-subscriber circuit breaker (mirrors hkjc-worker push/circuit.ts)
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  consecutive_429s INTEGER NOT NULL DEFAULT 0,
  circuit_state TEXT NOT NULL DEFAULT 'closed',     -- closed | open | half_open
  circuit_opened_at TEXT,
  last_success_at TEXT,
  last_failure_at TEXT,
  last_http_status INTEGER,
  last_error TEXT
);

CREATE INDEX IF NOT EXISTS idx_agent_subscribers_enabled
  ON agent_subscribers (enabled);
CREATE INDEX IF NOT EXISTS idx_agent_subscribers_circuit
  ON agent_subscribers (circuit_state);

-- Failed / rate-limited / circuit-deferred forwards. Never drop: delay + retry.
-- Bookkeeping only on failure/deferral (C3: avoid D1 write exhaustion on happy path).
CREATE TABLE IF NOT EXISTS agent_pending_forwards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subscriber_id INTEGER NOT NULL REFERENCES agent_subscribers(id) ON DELETE CASCADE,
  inbox_id TEXT NOT NULL REFERENCES inbox_events(id),
  event_type TEXT NOT NULL,
  quality_flags TEXT,                               -- comma-separated, for X-Quality-Flags header
  retry_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,                             -- NULL = gave up
  last_error TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (subscriber_id, inbox_id)
);

CREATE INDEX IF NOT EXISTS idx_agent_pending_due
  ON agent_pending_forwards (next_attempt_at);
