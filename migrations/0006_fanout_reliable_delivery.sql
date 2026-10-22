-- Issue #10: restore durable per-subscriber fan-out delivery.
-- PR #7 shipped best-effort fanout; PR #8 dropped agent_pending_forwards.
-- Without a pending queue, waitUntil cut-off or a single HTTP failure drops the
-- event for that subscriber with no automatic retry — downstream then needs
-- Hookdeck MANUAL retries. Re-introduce pending + attempt logging.

CREATE TABLE IF NOT EXISTS agent_pending_forwards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subscriber_id INTEGER NOT NULL REFERENCES agent_subscribers(id) ON DELETE CASCADE,
  inbox_id TEXT NOT NULL REFERENCES inbox_events(id),
  event_type TEXT NOT NULL,
  quality_flags TEXT,                               -- comma-separated, for X-Quality-Flags
  seq INTEGER,                                      -- denormalised for ORDER BY seq flush
  retry_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,                             -- NULL = gave up
  last_error TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (subscriber_id, inbox_id)
);

CREATE INDEX IF NOT EXISTS idx_agent_pending_due
  ON agent_pending_forwards (next_attempt_at);

CREATE INDEX IF NOT EXISTS idx_agent_pending_seq
  ON agent_pending_forwards (seq);

-- Every forward attempt (success, failure, skip, give-up) for incident tracing.
-- No payload body — only metadata.
CREATE TABLE IF NOT EXISTS agent_delivery_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subscriber_id INTEGER NOT NULL,
  inbox_id TEXT NOT NULL,
  seq INTEGER,
  event_type TEXT NOT NULL,
  attempt INTEGER NOT NULL,                          -- 1-based
  latency_ms INTEGER,
  http_status INTEGER,
  outcome TEXT NOT NULL,                            -- success | http_error | network_error | skipped_* | circuit_open | deferred | gave_up
  error_message TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_delivery_inbox
  ON agent_delivery_attempts (inbox_id, subscriber_id);
CREATE INDEX IF NOT EXISTS idx_agent_delivery_created
  ON agent_delivery_attempts (created_at);
CREATE INDEX IF NOT EXISTS idx_agent_delivery_seq
  ON agent_delivery_attempts (seq);
