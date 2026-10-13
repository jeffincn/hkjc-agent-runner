-- hkjc-worker 740b52d3+: odds_delta changes[] carry a stable runner_id (HKJC horse.code), status
-- (Declared | Standby), pool (WIN | PLA) and horse_name. Additive only: existing rows keep NULLs and
-- are keyed by runner_no as before. The append-only triggers on odds_ledger are unaffected.
ALTER TABLE odds_ledger ADD COLUMN runner_id TEXT;
ALTER TABLE odds_ledger ADD COLUMN horse_name TEXT;
ALTER TABLE odds_ledger ADD COLUMN status TEXT;
ALTER TABLE odds_ledger ADD COLUMN pool TEXT;
CREATE INDEX IF NOT EXISTS idx_ledger_runner_id ON odds_ledger(meeting_date, race_no, runner_id, bet_type, id);
