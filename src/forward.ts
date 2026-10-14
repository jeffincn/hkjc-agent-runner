import { allowDeliveryAttempt, circuitHalfOpenMs, recordDeliveryFailure, recordDeliverySuccess } from "./circuit";
import { hmacSha256Hex } from "./crypto";
import type { Env } from "./env";
import { nowIso, nowMs } from "./env";
import { reserveDeliverySlot } from "./rateLimit";
import {
  eventFilterMatches,
  getSubscriber,
  isInQuietHours,
  isWithinActiveWindow,
  listEnabledSubscribers,
  type AgentSubscriber,
} from "./subscribers";

const USER_AGENT = "hkjc-agent-runner/1.0";
/** Retry backoff minutes (mirrors worker pending.ts). After last slot → give up (row kept). */
const BACKOFF_MINUTES = [1, 5, 15];
export const GAVE_UP = "gave_up";

let fetchOverride: typeof fetch | null = null;
/** Tests may pin fetch so waitUntil fan-out does not hit the network. */
export function setForwardFetchForTest(fn: typeof fetch | null): void {
  fetchOverride = fn;
}
function defaultFetch(): typeof fetch {
  return fetchOverride ?? fetch;
}

export interface ForwardDelivery {
  subscriber_id: number;
  url: string;
  http_status: number | null;
  success: boolean;
  error_message?: string;
  signed: boolean;
  skipped_filter?: boolean;
  skipped_window?: boolean;
  skipped_quiet?: boolean;
  skipped_circuit?: boolean;
  deferred_rate_limit?: boolean;
  deferred?: boolean;
}

export interface FanOutInput {
  inbox_id: string;
  /** Raw envelope body exactly as received (no re-processing). */
  raw_body: string;
  event_type: string;
  meeting_date: string | null;
  /** Same flags logic as webhook X-Quality-Flags response header. */
  quality_flags: string[];
  fetchImpl?: typeof fetch;
}

function qualityFlagsHeader(flags: string[]): string | null {
  return flags.length ? flags.join(",") : null;
}

async function signHeaders(
  secret: string | null,
  rawBody: string,
  qualityFlags: string[],
): Promise<Record<string, string>> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": USER_AGENT,
  };
  const qf = qualityFlagsHeader(qualityFlags);
  if (qf) headers["X-Quality-Flags"] = qf;
  if (secret && secret.length > 0) {
    headers["X-Signature"] = await hmacSha256Hex(secret, new TextEncoder().encode(rawBody));
  }
  return headers;
}

export function nextBackoffMinutes(retryCount: number): number | null {
  return BACKOFF_MINUTES[retryCount] ?? null;
}

/**
 * Enqueue a deferred/failed forward. UNIQUE(subscriber_id, inbox_id) so retries
 * update the same row instead of multiplying D1 writes.
 */
export async function enqueuePendingForward(
  env: Env,
  args: {
    subscriber_id: number;
    inbox_id: string;
    event_type: string;
    quality_flags: string[];
    retry_count: number;
    last_error: string | null;
    /** Absolute next attempt; when omitted, derived from retry_count backoff. */
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
  const flags = qualityFlagsHeader(args.quality_flags);

  await env.DB.prepare(
    `INSERT INTO agent_pending_forwards
      (subscriber_id, inbox_id, event_type, quality_flags, retry_count, next_attempt_at, last_error, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(subscriber_id, inbox_id) DO UPDATE SET
       retry_count = excluded.retry_count,
       next_attempt_at = excluded.next_attempt_at,
       last_error = excluded.last_error,
       quality_flags = excluded.quality_flags,
       event_type = excluded.event_type`,
  )
    .bind(
      args.subscriber_id,
      args.inbox_id,
      args.event_type,
      flags,
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

export async function postToSubscriber(
  env: Env,
  sub: AgentSubscriber,
  rawBody: string,
  qualityFlags: string[],
  fetchImpl: typeof fetch,
): Promise<ForwardDelivery> {
  const signed = !!(sub.secret && sub.secret.length > 0);
  const headers = await signHeaders(sub.secret, rawBody, qualityFlags);
  try {
    const res = await fetchImpl(sub.url, { method: "POST", headers, body: rawBody });
    const success = res.status === 202 || res.ok;
    const error_message = success ? undefined : `HTTP ${res.status}`;
    if (success) {
      await recordDeliverySuccess(env, sub.id, res.status);
    } else {
      await recordDeliveryFailure(env, sub.id, {
        http_status: res.status,
        error_message,
      });
    }
    return {
      subscriber_id: sub.id,
      url: sub.url,
      http_status: res.status,
      success,
      error_message,
      signed,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await recordDeliveryFailure(env, sub.id, { http_status: null, error_message: msg });
    return {
      subscriber_id: sub.id,
      url: sub.url,
      http_status: null,
      success: false,
      error_message: msg,
      signed,
    };
  }
}

async function gateSubscriber(
  env: Env,
  sub: AgentSubscriber,
  input: FanOutInput,
): Promise<ForwardDelivery | null> {
  const signed = !!(sub.secret && sub.secret.length > 0);
  if (!eventFilterMatches(sub.event_filter, input.event_type)) {
    return {
      subscriber_id: sub.id,
      url: sub.url,
      http_status: null,
      success: true,
      signed,
      skipped_filter: true,
      error_message: "skipped: event_filter",
    };
  }
  if (isInQuietHours(sub.quiet_start, sub.quiet_end)) {
    return {
      subscriber_id: sub.id,
      url: sub.url,
      http_status: null,
      success: true,
      signed,
      skipped_quiet: true,
      error_message: "skipped: quiet hours",
    };
  }
  if (!(await isWithinActiveWindow(env, sub, input.meeting_date))) {
    return {
      subscriber_id: sub.id,
      url: sub.url,
      http_status: null,
      success: true,
      signed,
      skipped_window: true,
      error_message: "skipped: outside active window",
    };
  }
  return null;
}

/**
 * Fan-out one accepted inbound event to every enabled matching subscriber.
 * Happy-path: HTTP POST only (no pending row). Failures / rate-limit / open
 * circuit → pending row with backoff (never drop). Does not throw into webhook 202 path.
 */
export async function fanOutAccepted(env: Env, input: FanOutInput): Promise<ForwardDelivery[]> {
  const fetchImpl = input.fetchImpl ?? defaultFetch();
  const enabled = await listEnabledSubscribers(env);
  const out: ForwardDelivery[] = [];

  for (const sub of enabled) {
    const gated = await gateSubscriber(env, sub, input);
    if (gated) {
      out.push(gated);
      continue;
    }

    const gate = await allowDeliveryAttempt(env, sub.id);
    if (!gate.allowed) {
      const halfOpenMs = circuitHalfOpenMs(env);
      const next = new Date(nowMs() + halfOpenMs).toISOString();
      await enqueuePendingForward(env, {
        subscriber_id: sub.id,
        inbox_id: input.inbox_id,
        event_type: input.event_type,
        quality_flags: input.quality_flags,
        retry_count: 0,
        last_error: `circuit_${gate.state}`,
        next_attempt_at: next,
      });
      out.push({
        subscriber_id: sub.id,
        url: sub.url,
        http_status: null,
        success: false,
        error_message: `deferred: circuit ${gate.state}`,
        signed: !!(sub.secret && sub.secret.length > 0),
        skipped_circuit: true,
        deferred: true,
      });
      continue;
    }

    const slot = await reserveDeliverySlot(env, sub.id, nowMs());
    if (slot.delaySeconds > 0) {
      await enqueuePendingForward(env, {
        subscriber_id: sub.id,
        inbox_id: input.inbox_id,
        event_type: input.event_type,
        quality_flags: input.quality_flags,
        retry_count: 0,
        last_error: `rate_limit_delay_${slot.delaySeconds}s`,
        next_attempt_at: new Date(slot.slotAtMs).toISOString(),
      });
      out.push({
        subscriber_id: sub.id,
        url: sub.url,
        http_status: null,
        success: true,
        signed: !!(sub.secret && sub.secret.length > 0),
        deferred_rate_limit: true,
        deferred: true,
        error_message: `deferred: rate_limit ${slot.delaySeconds}s`,
      });
      continue;
    }

    const delivery = await postToSubscriber(env, sub, input.raw_body, input.quality_flags, fetchImpl);
    if (!delivery.success) {
      await enqueuePendingForward(env, {
        subscriber_id: sub.id,
        inbox_id: input.inbox_id,
        event_type: input.event_type,
        quality_flags: input.quality_flags,
        retry_count: 0,
        last_error: delivery.error_message ?? "delivery failed",
      });
      out.push({ ...delivery, deferred: true });
    } else {
      out.push(delivery);
    }
  }
  return out;
}

interface PendingRow {
  id: number;
  subscriber_id: number;
  inbox_id: string;
  event_type: string;
  quality_flags: string | null;
  retry_count: number;
  last_error: string | null;
}

/**
 * Cron: flush due pending forwards. Rate-limited deliveries delayed again if needed;
 * never dropped. Circuit-open subscribers skip until half-open probe window.
 */
export async function flushPendingForwards(
  env: Env,
  opts: { limit?: number; fetchImpl?: typeof fetch } = {},
): Promise<{ attempted: number; succeeded: number; deferred: number; failed: number }> {
  const limit = opts.limit ?? 50;
  const fetchImpl = opts.fetchImpl ?? defaultFetch();
  const now = nowIso();
  const due = await env.DB.prepare(
    `SELECT id, subscriber_id, inbox_id, event_type, quality_flags, retry_count, last_error
     FROM agent_pending_forwards
     WHERE next_attempt_at IS NOT NULL AND next_attempt_at <= ?
     ORDER BY next_attempt_at LIMIT ?`,
  )
    .bind(now, limit)
    .all<PendingRow>();

  let attempted = 0;
  let succeeded = 0;
  let deferred = 0;
  let failed = 0;

  for (const row of due.results ?? []) {
    attempted++;
    const sub = await getSubscriber(env, row.subscriber_id);
    if (!sub || !sub.enabled) {
      await clearPending(env, row.subscriber_id, row.inbox_id);
      deferred++;
      continue;
    }

    const inbox = await env.DB.prepare(`SELECT raw_body, meeting_date FROM inbox_events WHERE id = ?`)
      .bind(row.inbox_id)
      .first<{ raw_body: string; meeting_date: string | null }>();
    if (!inbox) {
      await clearPending(env, row.subscriber_id, row.inbox_id);
      failed++;
      continue;
    }

    const flags = row.quality_flags ? row.quality_flags.split(",").filter(Boolean) : [];
    const gateInput: FanOutInput = {
      inbox_id: row.inbox_id,
      raw_body: inbox.raw_body,
      event_type: row.event_type,
      meeting_date: inbox.meeting_date,
      quality_flags: flags,
    };
    const gated = await gateSubscriber(env, sub, gateInput);
    if (gated?.skipped_filter || gated?.skipped_quiet || gated?.skipped_window) {
      await clearPending(env, row.subscriber_id, row.inbox_id);
      deferred++;
      continue;
    }

    const circuit = await allowDeliveryAttempt(env, sub.id);
    if (!circuit.allowed) {
      const halfOpenMs = circuitHalfOpenMs(env);
      await enqueuePendingForward(env, {
        subscriber_id: sub.id,
        inbox_id: row.inbox_id,
        event_type: row.event_type,
        quality_flags: flags,
        retry_count: row.retry_count,
        last_error: `circuit_${circuit.state}`,
        next_attempt_at: new Date(nowMs() + halfOpenMs).toISOString(),
      });
      deferred++;
      continue;
    }

    const slot = await reserveDeliverySlot(env, sub.id, nowMs());
    if (slot.delaySeconds > 0) {
      await enqueuePendingForward(env, {
        subscriber_id: sub.id,
        inbox_id: row.inbox_id,
        event_type: row.event_type,
        quality_flags: flags,
        retry_count: row.retry_count,
        last_error: `rate_limit_delay_${slot.delaySeconds}s`,
        next_attempt_at: new Date(slot.slotAtMs).toISOString(),
      });
      deferred++;
      continue;
    }

    const delivery = await postToSubscriber(env, sub, inbox.raw_body, flags, fetchImpl);
    if (delivery.success) {
      await clearPending(env, row.subscriber_id, row.inbox_id);
      succeeded++;
    } else {
      const nextRetry = row.retry_count + 1;
      const delayMin = nextBackoffMinutes(nextRetry);
      await enqueuePendingForward(env, {
        subscriber_id: sub.id,
        inbox_id: row.inbox_id,
        event_type: row.event_type,
        quality_flags: flags,
        retry_count: nextRetry,
        last_error: delivery.error_message ?? "delivery failed",
        next_attempt_at: delayMin == null ? null : new Date(nowMs() + delayMin * 60_000).toISOString(),
      });
      failed++;
    }
  }

  return { attempted, succeeded, deferred, failed };
}
