-- Multi-subscriber agent-serving hub: downstream agent fan-out registry.
-- The agent (fixed address /webhook) forwards accepted inbound events to each
-- enabled subscriber whose event_filter matches. Mirrors the hkjc-worker
-- push_subscribers model (admin CRUD, active_window, quiet hours, circuit).

CREATE TABLE IF NOT EXISTS agent_subscribers (
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
CREATE INDEX IF NOT EXISTS idx_agent_subscribers_enabled ON agent_subscribers(enabled);
