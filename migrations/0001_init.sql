-- hkjc-agent-runner D1 schema

-- Every accepted webhook delivery (deduplicated). raw_body is the exact bytes received.
CREATE TABLE IF NOT EXISTS inbox_events (
  id TEXT PRIMARY KEY,
  dedupe_key TEXT NOT NULL UNIQUE,
  dedupe_source TEXT NOT NULL,              -- 'meta.content_hash' | 'derived'
  event_type TEXT NOT NULL,
  schema_version TEXT,
  meeting_date TEXT,
  venue TEXT,
  race_nos TEXT,                            -- JSON array
  snapshot_time TEXT,                       -- max snapshot_time in races[], if any
  sent_at TEXT,
  raw_body TEXT NOT NULL,
  received_at TEXT NOT NULL,
  signature_status TEXT NOT NULL,           -- 'valid' | 'not_configured'
  status TEXT NOT NULL,                     -- received|queued|processing|retry|done|skipped|superseded|failed
  workflow TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_until TEXT,
  last_error TEXT,
  duplicate_count INTEGER NOT NULL DEFAULT 0,
  run_id TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_inbox_status ON inbox_events(status, updated_at);
CREATE INDEX IF NOT EXISTS idx_inbox_meeting ON inbox_events(meeting_date, venue, event_type);

-- Transactional outbox: one row per inbox event that still needs to reach the Queue.
CREATE TABLE IF NOT EXISTS outbox (
  id TEXT PRIMARY KEY,
  inbox_id TEXT NOT NULL UNIQUE REFERENCES inbox_events(id),
  status TEXT NOT NULL,                     -- pending | dispatched
  delay_seconds INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  last_error TEXT,
  created_at TEXT NOT NULL,
  dispatched_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_outbox_due ON outbox(status, next_attempt_at);

-- Rejected deliveries (bad signature / bad JSON). Raw body is NOT kept, only its hash.
CREATE TABLE IF NOT EXISTS webhook_rejections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  received_at TEXT NOT NULL,
  reason TEXT NOT NULL,
  body_sha256 TEXT NOT NULL,
  body_bytes INTEGER NOT NULL
);

-- Latest odds snapshot seen per race, used to coalesce bursts of odds_update.
CREATE TABLE IF NOT EXISTS odds_latest (
  meeting_date TEXT NOT NULL,
  venue TEXT NOT NULL,
  race_no INTEGER NOT NULL,
  snapshot_time TEXT NOT NULL,
  inbox_id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (meeting_date, venue, race_no)
);

-- One analysis run per inbox event (UNIQUE inbox_id = agents never run twice for one event).
CREATE TABLE IF NOT EXISTS analysis_runs (
  id TEXT PRIMARY KEY,
  inbox_id TEXT NOT NULL UNIQUE REFERENCES inbox_events(id),
  workflow TEXT NOT NULL,
  phase TEXT NOT NULL,                      -- pre_race | post_race | none
  meeting_date TEXT,
  venue TEXT,
  race_nos TEXT,
  status TEXT NOT NULL,                     -- running | done | failed | skipped
  rounds INTEGER NOT NULL DEFAULT 0,
  conclusion_json TEXT,
  disagreements_json TEXT,
  error TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT
);

-- Every role output per round (independent / cross-exam / moderator). Cached so retries skip finished steps.
CREATE TABLE IF NOT EXISTS run_steps (
  run_id TEXT NOT NULL REFERENCES analysis_runs(id),
  round INTEGER NOT NULL,
  role_id TEXT NOT NULL,
  kind TEXT NOT NULL,                       -- independent | cross | moderator | repair
  status TEXT NOT NULL,                     -- ok | invalid | failed
  output_json TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (run_id, round, role_id)
);

-- Pre-race opinions. Only rows with locked = 1 may be used by post-race review.
CREATE TABLE IF NOT EXISTS race_opinions (
  meeting_date TEXT NOT NULL,
  venue TEXT NOT NULL,
  race_no INTEGER NOT NULL,
  run_id TEXT NOT NULL,
  snapshot_time TEXT,
  locked INTEGER NOT NULL DEFAULT 0,
  locked_at TEXT,
  opinion_json TEXT NOT NULL,
  PRIMARY KEY (meeting_date, venue, race_no)
);

CREATE TABLE IF NOT EXISTS runner_meta (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TEXT NOT NULL
);
