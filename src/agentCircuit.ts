import type { Env } from "./env";
import { envInt, nowIso, nowMs } from "./env";

export type AgentCircuitState = "closed" | "open" | "half_open";

export const DEFAULT_CIRCUIT_FAILURE_THRESHOLD = 10;
/** Consecutive HTTP 429s that open the circuit (in addition to general failures). */
export const DEFAULT_CIRCUIT_429_THRESHOLD = 3;
export const DEFAULT_CIRCUIT_HALF_OPEN_MS = 5 * 60 * 1000;

export interface AgentCircuitSnapshot {
  subscriber_id: number;
  circuit_state: AgentCircuitState;
  consecutive_failures: number;
  consecutive_429s: number;
  circuit_opened_at: string | null;
  last_success_at: string | null;
  last_failure_at: string | null;
  last_http_status: number | null;
  last_error: string | null;
}

function failureThreshold(env: Env): number {
  return Math.max(1, envInt(env.CIRCUIT_BREAKER_THRESHOLD, DEFAULT_CIRCUIT_FAILURE_THRESHOLD, 1, 10_000));
}

function threshold429(env: Env): number {
  return Math.max(1, envInt(env.CIRCUIT_BREAKER_429_THRESHOLD, DEFAULT_CIRCUIT_429_THRESHOLD, 1, 10_000));
}

function halfOpenMs(env: Env): number {
  return Math.max(1000, envInt(env.CIRCUIT_HALF_OPEN_MS, DEFAULT_CIRCUIT_HALF_OPEN_MS, 1000, 3_600_000));
}

function parseState(raw: string | null | undefined): AgentCircuitState {
  if (raw === "open" || raw === "half_open" || raw === "closed") return raw;
  return "closed";
}

export async function getAgentCircuitSnapshot(env: Env, subscriberId: number): Promise<AgentCircuitSnapshot> {
  const row = await env.DB.prepare(
    `SELECT id, consecutive_failures, consecutive_429s, circuit_state,
            circuit_opened_at, last_success_at, last_failure_at, last_http_status, last_error
     FROM agent_subscribers WHERE id = ?`,
  )
    .bind(subscriberId)
    .first<{
      id: number;
      consecutive_failures: number | null;
      consecutive_429s: number | null;
      circuit_state: string | null;
      circuit_opened_at: string | null;
      last_success_at: string | null;
      last_failure_at: string | null;
      last_http_status: number | null;
      last_error: string | null;
    }>();
  if (!row) {
    return {
      subscriber_id: subscriberId,
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

/**
 * Decide whether to attempt an HTTP delivery. May transition open → half_open
 * when the probe window has elapsed.
 */
export async function allowAgentDelivery(
  env: Env,
  subscriberId: number,
): Promise<{ allowed: boolean; reason?: string; state: AgentCircuitState }> {
  const snap = await getAgentCircuitSnapshot(env, subscriberId);
  if (snap.circuit_state === "closed" || snap.circuit_state === "half_open") {
    return { allowed: true, state: snap.circuit_state };
  }
  const openedAt = snap.circuit_opened_at ? Date.parse(snap.circuit_opened_at) : NaN;
  const elapsed = Number.isFinite(openedAt) ? nowMs() - openedAt : Infinity;
  if (elapsed >= halfOpenMs(env)) {
    const ts = nowIso();
    await env.DB.prepare(`UPDATE agent_subscribers SET circuit_state = 'half_open', updated_at = ? WHERE id = ?`)
      .bind(ts, subscriberId)
      .run();
    return { allowed: true, state: "half_open" };
  }
  return { allowed: false, reason: "circuit_open", state: "open" };
}

export async function recordAgentDeliverySuccess(
  env: Env,
  subscriberId: number,
  httpStatus: number | null,
): Promise<void> {
  const ts = nowIso();
  // D1 write-budget optimization: a healthy subscriber that just succeeded
  // needs no bookkeeping write at all.
  const snap = await getAgentCircuitSnapshot(env, subscriberId);
  if (
    snap.circuit_state === "closed" &&
    snap.consecutive_failures === 0 &&
    snap.consecutive_429s === 0
  ) {
    return;
  }
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

export async function recordAgentDeliveryFailure(
  env: Env,
  subscriberId: number,
  info: { http_status: number | null; error_message?: string },
): Promise<AgentCircuitState> {
  const ts = nowIso();
  const snap = await getAgentCircuitSnapshot(env, subscriberId);
  const failures = snap.consecutive_failures + 1;
  const is429 = info.http_status === 429;
  const consecutive429s = is429 ? snap.consecutive_429s + 1 : 0;

  const shouldOpen =
    failures >= failureThreshold(env) ||
    consecutive429s >= threshold429(env) ||
    snap.circuit_state === "half_open";

  const nextState: AgentCircuitState = shouldOpen ? "open" : "closed";
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
