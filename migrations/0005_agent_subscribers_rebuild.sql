-- Production D1 already applied the PR #6 version of 0004 (event_filter NOT NULL,
-- agent_pending_forwards present). Rebuild agent_subscribers to the PR #7 hub
-- schema (nullable event_filter) and drop the unused pending-forwards queue.

-- Drop pending-forwards first (FK → agent_subscribers).
DROP INDEX IF EXISTS idx_agent_pending_due;
DROP TABLE IF EXISTS agent_pending_forwards;

CREATE TABLE agent_subscribers_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  url TEXT NOT NULL UNIQUE,
  secret TEXT,                              -- nullable; HMAC-SHA256 of forwarded body when set
  enabled INTEGER NOT NULL DEFAULT 1,
  event_filter TEXT,                        -- JSON array of event types; NULL or [] = all events
  active_window TEXT NOT NULL DEFAULT 'always', -- 'always' | 'raceday'
  window_before_sec INTEGER NOT NULL DEFAULT 10800,
  quiet_start TEXT,                         -- HH:MM Asia/Hong_Kong, nullable
  quiet_end TEXT,                           -- HH:MM Asia/Hong_Kong, nullable
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  consecutive_429s INTEGER NOT NULL DEFAULT 0,
  circuit_state TEXT NOT NULL DEFAULT 'closed', -- closed | open | half_open
  circuit_opened_at TEXT,
  last_success_at TEXT,
  last_failure_at TEXT,
  last_http_status INTEGER,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO agent_subscribers_new (
  id, url, secret, enabled, event_filter,
  active_window, window_before_sec, quiet_start, quiet_end,
  consecutive_failures, consecutive_429s, circuit_state,
  circuit_opened_at, last_success_at, last_failure_at, last_http_status, last_error,
  created_at, updated_at
)
SELECT
  id, url, secret, enabled,
  CASE WHEN event_filter IS NULL OR event_filter = '[]' THEN NULL ELSE event_filter END,
  IFNULL(active_window, 'always'),
  IFNULL(window_before_sec, 10800),
  quiet_start, quiet_end,
  IFNULL(consecutive_failures, 0),
  IFNULL(consecutive_429s, 0),
  IFNULL(circuit_state, 'closed'),
  circuit_opened_at, last_success_at, last_failure_at, last_http_status, last_error,
  created_at, updated_at
FROM agent_subscribers;

DROP TABLE agent_subscribers;
ALTER TABLE agent_subscribers_new RENAME TO agent_subscribers;

DROP INDEX IF EXISTS idx_agent_subscribers_circuit;
CREATE INDEX IF NOT EXISTS idx_agent_subscribers_enabled ON agent_subscribers(enabled);
