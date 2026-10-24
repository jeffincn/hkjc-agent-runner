-- Pull-only archive. No webhook subscription, analysis, or outbound delivery.
CREATE TABLE collection_events (
  event_id TEXT PRIMARY KEY,
  meeting_date TEXT NOT NULL,
  venue TEXT NOT NULL,
  seq INTEGER NOT NULL CHECK(seq > 0),
  raw_body TEXT NOT NULL,
  collected_at TEXT NOT NULL,
  UNIQUE(meeting_date, venue, seq)
);
CREATE TRIGGER collection_events_immutable BEFORE UPDATE ON collection_events
WHEN OLD.meeting_date != NEW.meeting_date OR OLD.venue != NEW.venue
  OR OLD.seq != NEW.seq OR OLD.raw_body != NEW.raw_body
BEGIN SELECT RAISE(ABORT, 'conflicting immutable collection event'); END;
CREATE TABLE collection_cursors (
  meeting_date TEXT NOT NULL,
  venue TEXT NOT NULL,
  last_seq INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(meeting_date, venue)
);
CREATE TABLE collection_documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  meeting_date TEXT NOT NULL,
  venue TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  raw_body TEXT NOT NULL,
  collected_at TEXT NOT NULL,
  UNIQUE(kind, meeting_date, venue, content_hash)
);
CREATE TABLE collection_lock (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  owner TEXT NOT NULL,
  lease_until INTEGER NOT NULL
);
