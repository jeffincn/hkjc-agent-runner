import type { Env } from "./env";
import { envInt, nowIso, nowMs } from "./env";
import { hmacSha256Hex } from "./crypto";
import {
  listEnabledAgentSubscribers,
  getAgentSubscriber,
  subscriberWantsEvent,
  type AgentSubscriber,
} from "./agentSubscribers";
import {
  allowAgentDelivery,
  recordAgentDeliverySuccess,
  recordAgentDeliveryFailure,
  DEFAULT_CIRCUIT_HALF_OPEN_MS,
} from "./agentCircuit";

export interface FanoutInput {
  eventType: string;
  /** Exact bytes received on /webhook — forwarded unmodified. */
  rawBody: string;
  qualityFlags: string[];
  meetingDate: string | null;
  /** Inbox row id — required for pending / attempt logging. */
  inboxId: string;
  /** Push seq when present; used to flush pending in order. */
  seq: number | null;
}

export interface FanoutSkip {
  id: number;
  reason: string;
}

export interface FanoutResult {
  attempted: number;
  delivered: number;
  failed: number;
  deferred: number;
  skipped: FanoutSkip[];
}

export interface FlushResult {
  attempted: number;
  delivered: number;
  failed: number;
  deferred: number;
  gave_up: number;
}

/** Per-attempt POST timeout. */
const FORWARD_TIMEOUT_MS = 10_000;

/** Retry backoff minutes after a failed attempt. Exhausted → gave_up. */
const BACKOFF_MINUTES = [1, 5, 15];

export const GAVE_UP = "gave_up";

export type DeliveryOutcome =
  | "success"
  | "http_error"
  | "network_error"
  | "skipped_filter"
  | "skipped_window"
  | "skipped_quiet"
  | "circuit_open"
  | "deferred"
  | "gave_up";

/** YYYY-MM-DD in Asia/Hong_Kong for an epoch-ms instant. */
export function hktDate(ms: number): string {
  const d = new Date(ms + 8 * 3600_000);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Minutes since midnight in Asia/Hong_Kong. */
function hktMinutes(ms: number): number {
  const d = new Date(ms + 8 * 3600_000);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

/** Quiet hours check. Both set → quiet in that span (overnight wrap ok). */
export function inQuietHours(ms: number, quietStart: string, quietEnd: string): boolean {
  const mins = hktMinutes(ms);
  const [sh, sm] = quietStart.split(":").map(Number);
  const [eh, em] = quietEnd.split(":").map(Number);
  const s = sh * 60 + sm;
  const e = eh * 60 + em;
  if (s <= e) return mins >= s && mins < e;
  return mins >= s || mins < e;
}

/**
 * v1 raceday semantics: the event belongs to today's (HKT) meeting.
 * "always" subscribers are never gated here.
 */
export function windowActive(
  sub: Pick<AgentSubscriber, "active_window">,
  meetingDate: string | null,
  ms: number,
): boolean {
  if (sub.active_window !== "raceday") return true;
  return meetingDate !== null && meetingDate === hktDate(ms);
}

export function nextBackoffMinutes(retryCount: number): number | null {
  return BACKOFF_MINUTES[retryCount] ?? null;
}

function qualityFlagsCsv(flags: string[]): string | null {
  return flags.length ? flags.join(",") : null;
}

function halfOpenMs(env: Env): number {
  return Math.max(1000, envInt(env.CIRCUIT_HALF_OPEN_MS, DEFAULT_CIRCUIT_HALF_OPEN_MS, 1000, 3_600_000));
}

async function logAttempt(
  env: Env,
  args: {
    subscriber_id: number;
    inbox_id: string;
    seq: number | null;
    event_type: string;
    attempt: number;
    latency_ms: number | null;
    http_status: number | null;
    outcome: DeliveryOutcome;
    error_message?: string | null;
  },
): Promise<void> {
  try {
    await env.DB.prepare(
      `INSERT INTO agent_delivery_attempts
        (subscriber_id, inbox_id, seq, event_type, attempt, latency_ms, http_status, outcome, error_message, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        args.subscriber_id,
        args.inbox_id,
        args.seq,
        args.event_type,
        args.attempt,
        args.latency_ms,
        args.http_status,
        args.outcome,
        args.error_message ?? null,
        nowIso(),
      )
      .run();
  } catch {
    // Logging must never break the delivery path.
  }
}

async function enqueuePending(
  env: Env,
  args: {
    subscriber_id: number;
    inbox_id: string;
    event_type: string;
    quality_flags: string[];
    seq: number | null;
    retry_count: number;
    last_error: string | null;
    next_attempt_at?: string | null;
  },
): Promise<void> {
  const createdAt = nowIso();
  let next = args.next_attempt_at;
  if (next === undefined) {
    const delayMin = nextBackoffMinutes(args.retry_count);
    next = delayMin == null ? null : new Date(nowMs() + delayMin * 60_000).toISOString();
  }
  const lastError = next == null && !args.last_error ? GAVE_UP : args.last_error;
  await env.DB.prepare(
    `INSERT INTO agent_pending_forwards
      (subscriber_id, inbox_id, event_type, quality_flags, seq, retry_count, next_attempt_at, last_error, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(subscriber_id, inbox_id) DO UPDATE SET
       retry_count = excluded.retry_count,
       next_attempt_at = excluded.next_attempt_at,
       last_error = excluded.last_error,
       quality_flags = excluded.quality_flags,
       event_type = excluded.event_type,
       seq = excluded.seq`,
  )
    .bind(
      args.subscriber_id,
      args.inbox_id,
      args.event_type,
      qualityFlagsCsv(args.quality_flags),
      args.seq,
      args.retry_count,
      next,
      lastError,
      createdAt,
    )
    .run();
}

async function clearPending(env: Env, subscriberId: number, inboxId: string): Promise<void> {
  await env.DB.prepare(
    `DELETE FROM agent_pending_forwards WHERE subscriber_id = ? AND inbox_id = ?`,
  )
    .bind(subscriberId, inboxId)
    .run();
}

async function forwardOnce(
  env: Env,
  sub: AgentSubscriber,
  input: Pick<FanoutInput, "rawBody" | "qualityFlags">,
): Promise<{ ok: boolean; httpStatus: number | null; error?: string; latencyMs: number }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": "hkjc-agent-runner fanout",
  };
  if (input.qualityFlags.length > 0) {
    headers["X-Quality-Flags"] = input.qualityFlags.join(",");
  }
  const bodyBytes = new TextEncoder().encode(input.rawBody);
  if (sub.secret) {
    headers["X-Signature"] = await hmacSha256Hex(sub.secret, bodyBytes);
  }
  const started = nowMs();
  try {
    const resp = await fetch(sub.url, {
      method: "POST",
      headers,
      body: input.rawBody,
      signal: AbortSignal.timeout(FORWARD_TIMEOUT_MS),
    });
    // Drain the body so the connection can be reused; content is never logged.
    await resp.arrayBuffer().catch(() => undefined);
    return {
      ok: resp.status >= 200 && resp.status < 300,
      httpStatus: resp.status,
      latencyMs: nowMs() - started,
    };
  } catch (err) {
    return {
      ok: false,
      httpStatus: null,
      error: (err instanceof Error ? err.message : String(err)).slice(0, 200),
      latencyMs: nowMs() - started,
    };
  }
}

type GateReason = "event_filter" | "active_window" | "quiet_hours";

function gateSubscriber(
  sub: AgentSubscriber,
  input: FanoutInput,
  ms: number,
): GateReason | null {
  if (!subscriberWantsEvent(sub, input.eventType)) return "event_filter";
  if (!windowActive(sub, input.meetingDate, ms)) return "active_window";
  if (sub.quiet_start && sub.quiet_end && inQuietHours(ms, sub.quiet_start, sub.quiet_end)) {
    return "quiet_hours";
  }
  return null;
}

/**
 * Synchronously stage a pending row for every matching enabled subscriber.
 * Must run before the 202 response returns so a shed waitUntil cannot lose the
 * event — cron will flush leftovers.
 */
export async function stageFanoutPending(env: Env, input: FanoutInput): Promise<number> {
  let staged = 0;
  let subs: AgentSubscriber[];
  try {
    subs = await listEnabledAgentSubscribers(env);
  } catch {
    return 0;
  }
  const ms = nowMs();
  for (const sub of subs) {
    if (gateSubscriber(sub, input, ms)) continue;
    try {
      await enqueuePending(env, {
        subscriber_id: sub.id,
        inbox_id: input.inboxId,
        event_type: input.eventType,
        quality_flags: input.qualityFlags,
        seq: input.seq,
        retry_count: 0,
        last_error: "staged",
        next_attempt_at: nowIso(),
      });
      staged += 1;
    } catch {
      // Staging failure for one subscriber must not block the webhook 202.
    }
  }
  return staged;
}

async function deliverPendingRow(
  env: Env,
  row: {
    subscriber_id: number;
    inbox_id: string;
    event_type: string;
    quality_flags: string | null;
    seq: number | null;
    retry_count: number;
  },
  rawBody: string,
  meetingDate: string | null,
): Promise<"delivered" | "failed" | "deferred" | "gave_up" | "skipped"> {
  const sub = await getAgentSubscriber(env, row.subscriber_id);
  if (!sub || !sub.enabled) {
    await clearPending(env, row.subscriber_id, row.inbox_id);
    return "skipped";
  }

  const flags = row.quality_flags ? row.quality_flags.split(",").filter(Boolean) : [];
  const input: FanoutInput = {
    eventType: row.event_type,
    rawBody,
    qualityFlags: flags,
    meetingDate,
    inboxId: row.inbox_id,
    seq: row.seq,
  };
  const ms = nowMs();
  const gate = gateSubscriber(sub, input, ms);
  if (gate) {
    await logAttempt(env, {
      subscriber_id: sub.id,
      inbox_id: row.inbox_id,
      seq: row.seq,
      event_type: row.event_type,
      attempt: row.retry_count + 1,
      latency_ms: null,
      http_status: null,
      outcome:
        gate === "event_filter"
          ? "skipped_filter"
          : gate === "active_window"
            ? "skipped_window"
            : "skipped_quiet",
      error_message: gate,
    });
    await clearPending(env, row.subscriber_id, row.inbox_id);
    return "skipped";
  }

  const circuit = await allowAgentDelivery(env, sub.id);
  if (!circuit.allowed) {
    const next = new Date(nowMs() + halfOpenMs(env)).toISOString();
    await enqueuePending(env, {
      subscriber_id: sub.id,
      inbox_id: row.inbox_id,
      event_type: row.event_type,
      quality_flags: flags,
      seq: row.seq,
      retry_count: row.retry_count,
      last_error: "circuit_open",
      next_attempt_at: next,
    });
    await logAttempt(env, {
      subscriber_id: sub.id,
      inbox_id: row.inbox_id,
      seq: row.seq,
      event_type: row.event_type,
      attempt: row.retry_count + 1,
      latency_ms: null,
      http_status: null,
      outcome: "circuit_open",
      error_message: "circuit_open",
    });
    return "deferred";
  }

  const fwd = await forwardOnce(env, sub, input);
  const attempt = row.retry_count + 1;
  if (fwd.ok) {
    await recordAgentDeliverySuccess(env, sub.id, fwd.httpStatus);
    await logAttempt(env, {
      subscriber_id: sub.id,
      inbox_id: row.inbox_id,
      seq: row.seq,
      event_type: row.event_type,
      attempt,
      latency_ms: fwd.latencyMs,
      http_status: fwd.httpStatus,
      outcome: "success",
    });
    await clearPending(env, row.subscriber_id, row.inbox_id);
    return "delivered";
  }

  await recordAgentDeliveryFailure(env, sub.id, {
    http_status: fwd.httpStatus,
    error_message: fwd.error,
  });
  const outcome: DeliveryOutcome = fwd.httpStatus == null ? "network_error" : "http_error";
  await logAttempt(env, {
    subscriber_id: sub.id,
    inbox_id: row.inbox_id,
    seq: row.seq,
    event_type: row.event_type,
    attempt,
    latency_ms: fwd.latencyMs,
    http_status: fwd.httpStatus,
    outcome,
    error_message: fwd.error ?? (fwd.httpStatus != null ? `HTTP ${fwd.httpStatus}` : null),
  });

  const nextRetry = row.retry_count + 1;
  const delayMin = nextBackoffMinutes(nextRetry);
  if (delayMin == null) {
    await enqueuePending(env, {
      subscriber_id: sub.id,
      inbox_id: row.inbox_id,
      event_type: row.event_type,
      quality_flags: flags,
      seq: row.seq,
      retry_count: nextRetry,
      last_error: fwd.error ?? `HTTP ${fwd.httpStatus}`,
      next_attempt_at: null,
    });
    await logAttempt(env, {
      subscriber_id: sub.id,
      inbox_id: row.inbox_id,
      seq: row.seq,
      event_type: row.event_type,
      attempt: nextRetry + 1,
      latency_ms: null,
      http_status: null,
      outcome: "gave_up",
      error_message: GAVE_UP,
    });
    return "gave_up";
  }

  await enqueuePending(env, {
    subscriber_id: sub.id,
    inbox_id: row.inbox_id,
    event_type: row.event_type,
    quality_flags: flags,
    seq: row.seq,
    retry_count: nextRetry,
    last_error: fwd.error ?? `HTTP ${fwd.httpStatus}`,
    next_attempt_at: new Date(nowMs() + delayMin * 60_000).toISOString(),
  });
  return "failed";
}

/**
 * Flush due pending forwards, ordered by seq (nulls last) then next_attempt_at.
 * Used by cron and by the per-inbox waitUntil after staging.
 */
export async function flushPendingForwards(
  env: Env,
  opts: { limit?: number; inboxId?: string } = {},
): Promise<FlushResult> {
  const limit = opts.limit ?? 50;
  const now = nowIso();
  const result: FlushResult = {
    attempted: 0,
    delivered: 0,
    failed: 0,
    deferred: 0,
    gave_up: 0,
  };

  const sql = opts.inboxId
    ? `SELECT p.subscriber_id, p.inbox_id, p.event_type, p.quality_flags, p.seq, p.retry_count
       FROM agent_pending_forwards p
       WHERE p.inbox_id = ?
         AND p.next_attempt_at IS NOT NULL AND p.next_attempt_at <= ?
       ORDER BY CASE WHEN p.seq IS NULL THEN 1 ELSE 0 END, p.seq ASC, p.next_attempt_at ASC
       LIMIT ?`
    : `SELECT p.subscriber_id, p.inbox_id, p.event_type, p.quality_flags, p.seq, p.retry_count
       FROM agent_pending_forwards p
       WHERE p.next_attempt_at IS NOT NULL AND p.next_attempt_at <= ?
       ORDER BY CASE WHEN p.seq IS NULL THEN 1 ELSE 0 END, p.seq ASC, p.next_attempt_at ASC
       LIMIT ?`;

  const due = opts.inboxId
    ? await env.DB.prepare(sql).bind(opts.inboxId, now, limit).all<{
        subscriber_id: number;
        inbox_id: string;
        event_type: string;
        quality_flags: string | null;
        seq: number | null;
        retry_count: number;
      }>()
    : await env.DB.prepare(sql).bind(now, limit).all<{
        subscriber_id: number;
        inbox_id: string;
        event_type: string;
        quality_flags: string | null;
        seq: number | null;
        retry_count: number;
      }>();

  for (const row of due.results ?? []) {
    result.attempted += 1;
    try {
      const inbox = await env.DB.prepare(
        `SELECT raw_body, meeting_date FROM inbox_events WHERE id = ?`,
      )
        .bind(row.inbox_id)
        .first<{ raw_body: string; meeting_date: string | null }>();
      if (!inbox) {
        await clearPending(env, row.subscriber_id, row.inbox_id);
        result.failed += 1;
        continue;
      }
      const outcome = await deliverPendingRow(
        env,
        row,
        inbox.raw_body,
        inbox.meeting_date,
      );
      if (outcome === "delivered" || outcome === "skipped") result.delivered += 1;
      else if (outcome === "deferred") result.deferred += 1;
      else if (outcome === "gave_up") result.gave_up += 1;
      else result.failed += 1;
    } catch {
      result.failed += 1;
    }
  }
  return result;
}

/**
 * Forward an accepted inbound event to every enabled downstream agent
 * subscriber whose event_filter matches.
 *
 * Reliability model (issue #10):
 * 1. Caller stages pending rows synchronously (`stageFanoutPending`) before 202.
 * 2. This function (or cron) flushes due pending, ordered by seq.
 * 3. Failures retry with backoff; every attempt is logged to agent_delivery_attempts.
 *
 * A failing subscriber never affects other subscribers and never throws to the
 * caller — the inbox → queue path must stay intact.
 */
export async function fanoutToAgents(env: Env, input: FanoutInput): Promise<FanoutResult> {
  const result: FanoutResult = {
    attempted: 0,
    delivered: 0,
    failed: 0,
    deferred: 0,
    skipped: [],
  };

  // Record skip reasons for observability (pending was only staged for matches).
  let subs: AgentSubscriber[];
  try {
    subs = await listEnabledAgentSubscribers(env);
  } catch {
    return result;
  }
  const ms = nowMs();
  for (const sub of subs) {
    const reason = gateSubscriber(sub, input, ms);
    if (reason) {
      result.skipped.push({ id: sub.id, reason });
      await logAttempt(env, {
        subscriber_id: sub.id,
        inbox_id: input.inboxId,
        seq: input.seq,
        event_type: input.eventType,
        attempt: 1,
        latency_ms: null,
        http_status: null,
        outcome:
          reason === "event_filter"
            ? "skipped_filter"
            : reason === "active_window"
              ? "skipped_window"
              : "skipped_quiet",
        error_message: reason,
      });
    }
  }

  const flush = await flushPendingForwards(env, { inboxId: input.inboxId, limit: 100 });
  result.attempted = flush.attempted;
  result.delivered = flush.delivered;
  result.failed = flush.failed;
  result.deferred = flush.deferred + flush.gave_up;
  return result;
}
