import type { Env } from "./env";
import { envInt, nowIso, nowMs } from "./env";

export type CircuitStateName = "closed" | "open" | "half_open";

export const DEFAULT_CIRCUIT_FAILURE_THRESHOLD = 10;
/** Consecutive HTTP 429s that open the circuit (in addition to general failures). */
export const DEFAULT_CIRCUIT_429_THRESHOLD = 3;
export const DEFAULT_CIRCUIT_HALF_OPEN_MS = 5 * 60 * 1000;

export interface CircuitSnapshot {
  subscriber_id: number;
  url: string | null;
  circuit_state: CircuitStateName;
  consecutive_failures: number;
  consecutive_429s: number;
  circuit_opened_at: string | null;
  last_success_at: string | null;
  last_failure_at: string | null;
  last_http_status: number | null;
  last_error: string | null;
}

export function circuitFailureThreshold(env: Env): number {
  return Math.max(1, envInt(env.CIRCUIT_BREAKER_THRESHOLD, DEFAULT_CIRCUIT_FAILURE_THRESHOLD, 1, 10_000));
}

export function circuit429Threshold(env: Env): number {
  return Math.max(1, envInt(env.CIRCUIT_BREAKER_429_THRESHOLD, DEFAULT_CIRCUIT_429_THRESHOLD, 1, 10_000));
}

export function circuitHalfOpenMs(env: Env): number {
  return Math.max(1000, envInt(env.CIRCUIT_HALF_OPEN_MS, DEFAULT_CIRCUIT_HALF_OPEN_MS, 1000, 86_400_000));
}

function parseState(raw: string | null | undefined): CircuitStateName {
  if (raw === "open" || raw === "half_open" || raw === "closed") return raw;
  return "closed";
}

/**
 * Decide whether to attempt an HTTP delivery. May transition open → half_open
 * when the probe window has elapsed.
 */
export async function allowDeliveryAttempt(
  env: Env,
  subscriberId: number,
): Promise<{ allowed: boolean; reason?: string; state: CircuitStateName }> {
  const snap = await getCircuitSnapshot(env, subscriberId);
  if (snap.circuit_state === "closed") {
    return { allowed: true, state: "closed" };
  }
  if (snap.circuit_state === "half_open") {
    return { allowed: true, state: "half_open" };
  }

  const openedAt = snap.circuit_opened_at ? Date.parse(snap.circuit_opened_at) : NaN;
  const elapsed = Number.isFinite(openedAt) ? nowMs() - openedAt : Infinity;
  if (elapsed >= circuitHalfOpenMs(env)) {
    await setCircuitState(env, subscriberId, "half_open");
    return { allowed: true, state: "half_open" };
  }
  return {
    allowed: false,
    reason: "circuit_open",
    state: "open",
  };
}

export async function recordDeliverySuccess(
  env: Env,
  subscriberId: number,
  httpStatus: number | null,
): Promise<void> {
  const ts = nowIso();
  await env.DB.prepare(
    `UPDATE agent_subscribers SET
      consecutive_failures = 0,
      consecutive_429s = 0,
      circuit_state = 'closed',
      circuit_opened_at = NULL,
      last_success_at = ?,
      last_http_status = ?,
      last_error = NULL,
      updated_at = ?
     WHERE id = ?`,
  )
    .bind(ts, httpStatus, ts, subscriberId)
    .run();
}

export async function recordDeliveryFailure(
  env: Env,
  subscriberId: number,
  info: { http_status: number | null; error_message?: string },
): Promise<CircuitStateName> {
  const ts = nowIso();
  const snap = await getCircuitSnapshot(env, subscriberId);
  const failures = snap.consecutive_failures + 1;
  const is429 = info.http_status === 429;
  const consecutive429s = is429 ? snap.consecutive_429s + 1 : 0;

  const failThresh = circuitFailureThreshold(env);
  const thresh429 = circuit429Threshold(env);
  const shouldOpen =
    failures >= failThresh || consecutive429s >= thresh429 || snap.circuit_state === "half_open";

  const nextState: CircuitStateName = shouldOpen ? "open" : "closed";
  const openedAt =
    nextState === "open"
      ? snap.circuit_state === "open" && snap.circuit_opened_at
        ? snap.circuit_opened_at
        : ts
      : null;

  await env.DB.prepare(
    `UPDATE agent_subscribers SET
      consecutive_failures = ?,
      consecutive_429s = ?,
      circuit_state = ?,
      circuit_opened_at = ?,
      last_failure_at = ?,
      last_http_status = ?,
      last_error = ?,
      updated_at = ?
     WHERE id = ?`,
  )
    .bind(
      failures,
      consecutive429s,
      nextState,
      openedAt,
      ts,
      info.http_status,
      info.error_message ?? null,
      ts,
      subscriberId,
    )
    .run();

  return nextState;
}

async function setCircuitState(env: Env, subscriberId: number, state: CircuitStateName): Promise<void> {
  const ts = nowIso();
  await env.DB.prepare(`UPDATE agent_subscribers SET circuit_state = ?, updated_at = ? WHERE id = ?`)
    .bind(state, ts, subscriberId)
    .run();
}

export async function getCircuitSnapshot(env: Env, subscriberId: number): Promise<CircuitSnapshot> {
  const row = await env.DB.prepare(
    `SELECT id, url, consecutive_failures, consecutive_429s, circuit_state,
       circuit_opened_at, last_success_at, last_failure_at, last_http_status, last_error
     FROM agent_subscribers WHERE id = ?`,
  )
    .bind(subscriberId)
    .first<{
      id: number;
      url: string;
      consecutive_failures: number;
      consecutive_429s: number;
      circuit_state: string;
      circuit_opened_at: string | null;
      last_success_at: string | null;
      last_failure_at: string | null;
      last_http_status: number | null;
      last_error: string | null;
    }>();

  if (!row) {
    return {
      subscriber_id: subscriberId,
      url: null,
      circuit_state: "closed",
      consecutive_failures: 0,
      consecutive_429s: 0,
      circuit_opened_at: null,
      last_success_at: null,
      last_failure_at: null,
      last_http_status: null,
      last_error: null,
    };
  }

  return {
    subscriber_id: row.id,
    url: row.url,
    circuit_state: parseState(row.circuit_state),
    consecutive_failures: row.consecutive_failures ?? 0,
    consecutive_429s: row.consecutive_429s ?? 0,
    circuit_opened_at: row.circuit_opened_at,
    last_success_at: row.last_success_at,
    last_failure_at: row.last_failure_at,
    last_http_status: row.last_http_status,
    last_error: row.last_error,
  };
}
