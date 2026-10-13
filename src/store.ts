import type { SignatureStatus } from "./crypto";
import { uuid } from "./crypto";
import { nowIso } from "./env";

export interface InboxRow {
  id: string;
  dedupe_key: string;
  dedupe_source: string;
  event_type: string;
  meeting_date: string | null;
  venue: string | null;
  race_nos: string | null;
  snapshot_time: string | null;
  raw_body: string;
  received_at: string;
  signature_status: string;
  status: string;
  workflow: string | null;
  attempts: number;
  lease_until: string | null;
  last_error: string | null;
  duplicate_count: number;
  run_id: string | null;
}

export interface NewInbox {
  dedupe_key: string;
  dedupe_source: string;
  event_type: string;
  schema_version: string;
  meeting_date: string | null;
  venue: string | null;
  race_nos: number[];
  snapshot_time: string | null;
  sent_at: string | null;
  raw_body: string;
  signature_status: Exclude<SignatureStatus, "invalid" | "missing">;
  workflow: string;
  delay_seconds: number;
  odds_races?: { race_no: number; snapshot_time: string }[];
  /** Receive instant (ms); defaults to now. */
  received_ms?: number;
  quality?: InboundQuality;
}

export interface LedgerEntry {
  race_no: number;
  runner_no: number;
  name_zh: string | null;
  name_en: string | null;
  bet_type: "WIN" | "PLA";
  runner_id?: string | null;
  horse_name?: string | null;
  status?: string | null;
  pool?: string | null;
  prev_odds: number | null;
  new_odds: number | null;
  odds_basis: string | null;
  post_race: boolean;
}

export interface InboundQuality {
  event_id: string | null;
  seq: number | null;
  captured_at: string | null;
  source_updated_at: string | null;
  source_url: string | null;
  received_at_hkt: string;
  delay_received_sent_ms: number | null;
  delay_received_captured_ms: number | null;
  delay_captured_source_ms: number | null;
  flags: string[];
  post_race: boolean;
  gap: { from_seq: number; to_seq: number } | null;
  heartbeat: { last_change_seq: number | null } | null;
  schedule: { race_no: number; post_time: string }[];
  ledger: LedgerEntry[];
}

/**
 * Persist inbox + outbox (+ odds_latest) in ONE D1 batch (D1 batches run as a transaction).
 * Returns duplicate=true when the dedupe key already existed; then nothing new is queued.
 */
export async function persistInbound(db: D1Database, ev: NewInbox): Promise<{ id: string; duplicate: boolean }> {
  const id = uuid();
  const now = ev.received_ms !== undefined ? new Date(ev.received_ms).toISOString() : nowIso();
  const q = ev.quality;
  const stmts: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO inbox_events (id, dedupe_key, dedupe_source, event_type, schema_version, meeting_date, venue,
           race_nos, snapshot_time, sent_at, raw_body, received_at, signature_status, status, workflow, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'received',?,?)
         ON CONFLICT(dedupe_key) DO UPDATE SET duplicate_count = duplicate_count + 1, updated_at = excluded.updated_at,
           quality_flags = CASE WHEN COALESCE(quality_flags, '[]') LIKE '%"duplicate"%' THEN quality_flags
                                ELSE json_insert(COALESCE(quality_flags, '[]'), '$[#]', 'duplicate') END`,
      )
      .bind(
        id,
        ev.dedupe_key,
        ev.dedupe_source,
        ev.event_type,
        ev.schema_version,
        ev.meeting_date,
        ev.venue,
        JSON.stringify(ev.race_nos),
        ev.snapshot_time,
        ev.sent_at,
        ev.raw_body,
        now,
        ev.signature_status,
        ev.workflow,
        now,
      ),
    // Quality columns are written only on the row we just created (no-op on a duplicate).
    db
      .prepare(
        `UPDATE inbox_events SET event_id = ?, seq = ?, captured_at = ?, source_updated_at = ?, source_url = ?, received_at_hkt = ?,
           delay_received_sent_ms = ?, delay_received_captured_ms = ?, delay_captured_source_ms = ?, quality_flags = ?, post_race = ?
         WHERE id = ?`,
      )
      .bind(
        q?.event_id ?? null, q?.seq ?? null, q?.captured_at ?? null, q?.source_updated_at ?? null, q?.source_url ?? null,
        q?.received_at_hkt ?? null, q?.delay_received_sent_ms ?? null, q?.delay_received_captured_ms ?? null,
        q?.delay_captured_source_ms ?? null, JSON.stringify(q?.flags ?? []), q?.post_race ? 1 : 0, id,
      ),
    // Only creates an outbox row when the inbox row above is ours (new).
    db
      .prepare(
        `INSERT OR IGNORE INTO outbox (id, inbox_id, status, delay_seconds, next_attempt_at, created_at)
         SELECT ?, id, 'pending', ?, ?, ? FROM inbox_events WHERE id = ?`,
      )
      .bind(uuid(), ev.delay_seconds, now, now, id),
  ];
  for (const r of ev.odds_races ?? []) {
    stmts.push(
      db
        .prepare(
          `INSERT INTO odds_latest (meeting_date, venue, race_no, snapshot_time, inbox_id, updated_at)
           SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM inbox_events WHERE id = ?)
           ON CONFLICT(meeting_date, venue, race_no) DO UPDATE SET
             snapshot_time = excluded.snapshot_time, inbox_id = excluded.inbox_id, updated_at = excluded.updated_at
           WHERE excluded.snapshot_time > odds_latest.snapshot_time`,
        )
        .bind(ev.meeting_date ?? "", ev.venue ?? "", r.race_no, r.snapshot_time, id, now, id),
    );
  }
  if (q) stmts.push(...qualityStatements(db, ev, q, id, now));
  await db.batch(stmts);
  const row = await db
    .prepare(`SELECT id FROM inbox_events WHERE dedupe_key = ?`)
    .bind(ev.dedupe_key)
    .first<{ id: string }>();
  if (!row) throw new Error("inbox insert not visible");
  return { id: row.id, duplicate: row.id !== id };
}

export async function recordRejection(db: D1Database, reason: string, bodySha: string, bytes: number): Promise<void> {
  await db
    .prepare(`INSERT INTO webhook_rejections (received_at, reason, body_sha256, body_bytes) VALUES (?,?,?,?)`)
    .bind(nowIso(), reason, bodySha, bytes)
    .run();
}

export async function getInbox(db: D1Database, id: string): Promise<InboxRow | null> {
  return db.prepare(`SELECT * FROM inbox_events WHERE id = ?`).bind(id).first<InboxRow>();
}

export async function setInboxStatus(
  db: D1Database,
  id: string,
  status: string,
  extra: { last_error?: string | null; run_id?: string | null } = {},
): Promise<void> {
  await db
    .prepare(
      `UPDATE inbox_events SET status = ?, last_error = COALESCE(?, last_error), run_id = COALESCE(?, run_id),
         lease_until = NULL, updated_at = ? WHERE id = ?`,
    )
    .bind(status, extra.last_error ?? null, extra.run_id ?? null, nowIso(), id)
    .run();
}

/**
 * Atomically claim an inbox event for processing. Returns false if it is already done,
 * being processed under a live lease, or otherwise not claimable — so redelivered
 * Queue messages never run agents twice.
 */
export async function claimInbox(db: D1Database, id: string, leaseSeconds: number): Promise<boolean> {
  const now = nowIso();
  const lease = new Date(Date.now() + leaseSeconds * 1000).toISOString();
  const res = await db
    .prepare(
      `UPDATE inbox_events SET status = 'processing', attempts = attempts + 1, lease_until = ?, updated_at = ?
       WHERE id = ? AND (status IN ('received','queued','retry') OR (status = 'processing' AND lease_until < ?))`,
    )
    .bind(lease, now, id, now)
    .run();
  return (res.meta.changes ?? 0) === 1;
}

export async function setMeta(db: D1Database, key: string, value: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO runner_meta (key, value, updated_at) VALUES (?,?,?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .bind(key, value, nowIso())
    .run();
}

export async function getMetaMap(db: D1Database): Promise<Record<string, { value: string; updated_at: string }>> {
  const rows = await db.prepare(`SELECT key, value, updated_at FROM runner_meta`).all<{ key: string; value: string; updated_at: string }>();
  const out: Record<string, { value: string; updated_at: string }> = {};
  for (const r of rows.results ?? []) out[r.key] = { value: r.value, updated_at: r.updated_at };
  return out;
}

const IF_NEW = `EXISTS (SELECT 1 FROM inbox_events WHERE id = ?)`;

function qualityStatements(db: D1Database, ev: NewInbox, q: InboundQuality, id: string, now: string): D1PreparedStatement[] {
  const out: D1PreparedStatement[] = [];
  const md = ev.meeting_date;
  for (const s of q.schedule) {
    if (!md) break;
    out.push(
      db.prepare(
        `INSERT INTO race_schedule (meeting_date, race_no, venue, post_time, updated_at) SELECT ?, ?, ?, ?, ? WHERE ${IF_NEW}
         ON CONFLICT(meeting_date, race_no) DO UPDATE SET post_time = excluded.post_time, venue = COALESCE(excluded.venue, race_schedule.venue), updated_at = excluded.updated_at`,
      ).bind(md, s.race_no, ev.venue, s.post_time, now, id),
    );
  }
  if (md) {
    const hb = q.heartbeat;
    out.push(
      db.prepare(
        `INSERT INTO stream_state (meeting_date, last_event_received_at, last_event_hkt, last_seq, last_heartbeat_at, last_change_seq, updated_at)
         SELECT ?, ?, ?, ?, ?, ?, ? WHERE ${IF_NEW}
         ON CONFLICT(meeting_date) DO UPDATE SET
           last_event_received_at = MAX(COALESCE(stream_state.last_event_received_at, ''), excluded.last_event_received_at),
           last_event_hkt = CASE WHEN excluded.last_event_received_at >= COALESCE(stream_state.last_event_received_at, '') THEN excluded.last_event_hkt ELSE stream_state.last_event_hkt END,
           last_seq = CASE WHEN excluded.last_seq IS NULL THEN stream_state.last_seq ELSE MAX(COALESCE(stream_state.last_seq, excluded.last_seq), excluded.last_seq) END,
           last_heartbeat_at = COALESCE(excluded.last_heartbeat_at, stream_state.last_heartbeat_at),
           last_change_seq = COALESCE(excluded.last_change_seq, stream_state.last_change_seq),
           updated_at = excluded.updated_at`,
      ).bind(md, now, q.received_at_hkt, q.seq, hb ? now : null, hb?.last_change_seq ?? null, now, id),
    );
    if (q.gap) {
      out.push(
        db.prepare(`INSERT OR IGNORE INTO seq_gaps (meeting_date, from_seq, to_seq, detected_at) SELECT ?, ?, ?, ? WHERE ${IF_NEW}`)
          .bind(md, q.gap.from_seq, q.gap.to_seq, now, id),
      );
    }
    for (const l of q.ledger) {
      out.push(
        db.prepare(
          `INSERT INTO odds_ledger (inbox_id, event_id, seq, schema_version, meeting_date, venue, race_no, runner_no, name_zh, name_en,
             bet_type, prev_odds, new_odds, odds_basis, captured_at, received_at_hkt, post_race, quality_flags, runner_id, horse_name, status, pool)
           SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE ${IF_NEW}`,
        ).bind(
          id, q.event_id, q.seq, ev.schema_version, md, ev.venue, l.race_no, l.runner_no, l.name_zh, l.name_en,
          l.bet_type, l.prev_odds, l.new_odds, l.odds_basis, q.captured_at, q.received_at_hkt, l.post_race ? 1 : 0, JSON.stringify(q.flags),
          l.runner_id ?? null, l.horse_name ?? null, l.status ?? null, l.pool ?? null, id,
        ),
      );
    }
  }
  return out;
}
