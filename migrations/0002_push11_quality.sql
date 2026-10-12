-- hkjc-push/1.1 support, data-quality flags, append-only odds ledger, analysis validation.

-- Per-event timing and quality. received_at (UTC ISO) already exists; received_at_hkt is the same instant in +08:00.
ALTER TABLE inbox_events ADD COLUMN event_id TEXT;
ALTER TABLE inbox_events ADD COLUMN seq INTEGER;
ALTER TABLE inbox_events ADD COLUMN captured_at TEXT;
ALTER TABLE inbox_events ADD COLUMN source_updated_at TEXT;
ALTER TABLE inbox_events ADD COLUMN source_url TEXT;
ALTER TABLE inbox_events ADD COLUMN received_at_hkt TEXT;
ALTER TABLE inbox_events ADD COLUMN delay_received_sent_ms INTEGER;      -- received - sent
ALTER TABLE inbox_events ADD COLUMN delay_received_captured_ms INTEGER;  -- received - captured
ALTER TABLE inbox_events ADD COLUMN delay_captured_source_ms INTEGER;    -- captured - source.last_updated_at
ALTER TABLE inbox_events ADD COLUMN quality_flags TEXT;                  -- JSON array of flag names
ALTER TABLE inbox_events ADD COLUMN post_race INTEGER NOT NULL DEFAULT 0; -- 1 = excluded from pre-race analysis
-- Not UNIQUE: dedupe_key (eid:<event_id>) already enforces one row per event_id.
CREATE INDEX IF NOT EXISTS idx_inbox_event_id ON inbox_events(event_id);
CREATE INDEX IF NOT EXISTS idx_inbox_meeting_seq ON inbox_events(meeting_date, seq);

-- Race start times learned from schedule events and race post_time fields.
CREATE TABLE IF NOT EXISTS race_schedule (
  meeting_date TEXT NOT NULL,
  race_no INTEGER NOT NULL,
  venue TEXT,
  post_time TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (meeting_date, race_no)
);

-- Stream state per meeting day (last event, last seq, last heartbeat).
CREATE TABLE IF NOT EXISTS stream_state (
  meeting_date TEXT PRIMARY KEY,
  last_event_received_at TEXT,
  last_event_hkt TEXT,
  last_seq INTEGER,
  last_heartbeat_at TEXT,
  last_change_seq INTEGER,
  updated_at TEXT NOT NULL
);

-- Seq gaps detected on arrival (from_seq..to_seq missing). filled = 1 once a late event covers them.
CREATE TABLE IF NOT EXISTS seq_gaps (
  meeting_date TEXT NOT NULL,
  from_seq INTEGER NOT NULL,
  to_seq INTEGER NOT NULL,
  detected_at TEXT NOT NULL,
  PRIMARY KEY (meeting_date, from_seq)
);

-- Shared append-only odds ledger. One row per (event, race, runner, bet type) change.
CREATE TABLE IF NOT EXISTS odds_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  inbox_id TEXT NOT NULL REFERENCES inbox_events(id),
  event_id TEXT,
  seq INTEGER,
  schema_version TEXT,
  meeting_date TEXT NOT NULL,
  venue TEXT,
  race_no INTEGER NOT NULL,
  runner_no INTEGER NOT NULL,
  name_zh TEXT,
  name_en TEXT,
  bet_type TEXT NOT NULL,                    -- WIN | PLA
  prev_odds REAL,
  new_odds REAL,
  odds_basis TEXT,
  captured_at TEXT,
  received_at_hkt TEXT NOT NULL,
  post_race INTEGER NOT NULL DEFAULT 0,
  quality_flags TEXT
);
CREATE INDEX IF NOT EXISTS idx_ledger_replay ON odds_ledger(meeting_date, race_no, runner_no, bet_type, id);
CREATE TRIGGER IF NOT EXISTS odds_ledger_no_update BEFORE UPDATE ON odds_ledger
BEGIN SELECT RAISE(ABORT, 'odds_ledger is append-only'); END;
CREATE TRIGGER IF NOT EXISTS odds_ledger_no_delete BEFORE DELETE ON odds_ledger
BEGIN SELECT RAISE(ABORT, 'odds_ledger is append-only'); END;

-- Validated probabilities / EV per analysis output. Quarantined rows keep the reason and have no EV.
CREATE TABLE IF NOT EXISTS analysis_validation (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  role_id TEXT NOT NULL,
  race_no INTEGER,
  runner_no INTEGER,
  bet_type TEXT NOT NULL,
  p REAL,
  odds REAL,
  odds_basis TEXT,
  fair_odds REAL,
  ev REAL,
  status TEXT NOT NULL,                      -- accepted | quarantined
  reason TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_validation_run ON analysis_validation(run_id, status);
