import type { Env } from "./env";
import { nowIso } from "./env";
import { setMeta } from "./store";

const BACKOFF_SECONDS = [30, 60, 300, 900, 1800];
/** A dispatched message whose inbox row is still queued after this long is re-sent (lost message guard). */
const STALE_DISPATCH_SECONDS = 1800;

interface OutboxRow {
  id: string;
  inbox_id: string;
  delay_seconds: number;
  attempts: number;
}

/** Send one outbox row to the Queue. On failure the row stays pending with a backoff. */
export async function dispatchOne(env: Env, row: OutboxRow): Promise<boolean> {
  try {
    await env.EVENTS_QUEUE.send(
      { inbox_id: row.inbox_id },
      row.delay_seconds > 0 ? { delaySeconds: row.delay_seconds } : undefined,
    );
  } catch (err) {
    const msg = (err instanceof Error ? err.message : String(err)).slice(0, 500);
    const attempts = row.attempts + 1;
    const wait = BACKOFF_SECONDS[Math.min(attempts - 1, BACKOFF_SECONDS.length - 1)];
    await env.DB.prepare(
      `UPDATE outbox SET attempts = ?, last_error = ?, next_attempt_at = ? WHERE id = ? AND status = 'pending'`,
    )
      .bind(attempts, msg, new Date(Date.now() + wait * 1000).toISOString(), row.id)
      .run();
    await setMeta(env.DB, "last_queue_send_error", msg);
    return false;
  }
  const now = nowIso();
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE outbox SET status = 'dispatched', attempts = attempts + 1, dispatched_at = ?, last_error = NULL WHERE id = ?`,
    ).bind(now, row.id),
    env.DB.prepare(
      `UPDATE inbox_events SET status = 'queued', updated_at = ? WHERE id = ? AND status = 'received'`,
    ).bind(now, row.inbox_id),
  ]);
  await setMeta(env.DB, "last_queue_send_ok", now);
  return true;
}

export async function dispatchByInbox(env: Env, inboxId: string): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT id, inbox_id, delay_seconds, attempts FROM outbox WHERE inbox_id = ? AND status = 'pending'`,
  )
    .bind(inboxId)
    .first<OutboxRow>();
  if (!row) return true;
  return dispatchOne(env, row);
}

/** Cron: re-send every due pending row, and re-arm dispatched rows whose message evidently got lost. */
export async function runDispatcher(env: Env, limit = 50): Promise<{ sent: number; failed: number; rearmed: number }> {
  const now = nowIso();
  const staleBefore = new Date(Date.now() - STALE_DISPATCH_SECONDS * 1000).toISOString();
  const rearm = await env.DB.prepare(
    `UPDATE outbox SET status = 'pending', next_attempt_at = ?, delay_seconds = 0
     WHERE status = 'dispatched' AND dispatched_at < ?
       AND inbox_id IN (SELECT id FROM inbox_events WHERE status IN ('queued','received'))`,
  )
    .bind(now, staleBefore)
    .run();
  // Expired processing leases go back to retry so the next delivery can claim them.
  await env.DB.prepare(
    `UPDATE outbox SET status = 'pending', next_attempt_at = ?, delay_seconds = 0
     WHERE inbox_id IN (SELECT id FROM inbox_events WHERE status = 'processing' AND lease_until < ?)`,
  )
    .bind(now, now)
    .run();

  const due = await env.DB.prepare(
    `SELECT id, inbox_id, delay_seconds, attempts FROM outbox WHERE status = 'pending' AND next_attempt_at <= ?
     ORDER BY next_attempt_at LIMIT ?`,
  )
    .bind(now, limit)
    .all<OutboxRow>();
  let sent = 0;
  let failed = 0;
  for (const row of due.results ?? []) {
    if (await dispatchOne(env, row)) sent++;
    else failed++;
  }
  await setMeta(env.DB, "last_dispatcher_run", now);
  return { sent, failed, rearmed: rearm.meta.changes ?? 0 };
}
