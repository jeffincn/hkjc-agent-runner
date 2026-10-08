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
}

/**
 * Persist inbox + outbox (+ odds_latest) in ONE D1 batch (D1 batches run as a transaction).
 * Returns duplicate=true when the dedupe key already existed; then nothing new is queued.
 */
export async function persistInbound(db: D1Database, ev: NewInbox): Promise<{ id: string; duplicate: boolean }> {
  const id = uuid();
  const now = nowIso();
  const stmts: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO inbox_events (id, dedupe_key, dedupe_source, event_type, schema_version, meeting_date, venue,
           race_nos, snapshot_time, sent_at, raw_body, received_at, signature_status, status, workflow, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'received',?,?)
         ON CONFLICT(dedupe_key) DO UPDATE SET duplicate_count = duplicate_count + 1, updated_at = excluded.updated_at`,
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
