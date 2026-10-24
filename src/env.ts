export interface QueueMessageBody {
  inbox_id: string;
}

export interface Env {
  DB: D1Database;
  EVENTS_QUEUE: Queue<QueueMessageBody>;
  /**
   * Optional service binding to hkjc-data-worker (same account).
   * When set, the collector uses it instead of public-URL fetch to avoid
   * Worker-to-Worker / zone browser_check blocks.
   */
  HKJC_WORKER?: Fetcher;
  /** Shared with hkjc-data-worker; when set, X-Signature is required and verified. */
  PUSH_SECRET?: string;
  /** Bearer token for GET /runs/:id. */
  RUNNER_API_TOKEN?: string;
  OPENAI_API_KEY?: string;
  /** Required for analysis; no model name is hardcoded. */
  OPENAI_MODEL?: string;
  /** Optional override, e.g. a gateway. Defaults to https://api.openai.com/v1 */
  OPENAI_BASE_URL?: string;
  HKJC_API_BASE?: string;
  HKJC_API_TOKEN?: string;
  /** Explicit opt-in; pull-only archive, no analysis or fan-out. */
  HKJC_COLLECT_ENABLED?: string;
  HKJC_COLLECT_MAX_REQUESTS?: string;
  HKJC_COLLECT_LOOKBACK_DAYS?: string;
  HKJC_COLLECT_LOOKAHEAD_DAYS?: string;
  ODDS_COALESCE_SECONDS?: string;
  MAX_ROUNDS?: string;
  MAX_PROCESS_ATTEMPTS?: string;
  /** Circuit breaker tuning for agent_subscribers fan-out (mirrors hkjc-worker). */
  CIRCUIT_BREAKER_THRESHOLD?: string;
  CIRCUIT_BREAKER_429_THRESHOLD?: string;
  CIRCUIT_HALF_OPEN_MS?: string;
}

export function envInt(v: string | undefined, def: number, min: number, max: number): number {
  const n = Number.parseInt(v ?? "", 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

export function nowIso(): string {
  return new Date(nowMs()).toISOString();
}

let clockOverride: (() => number) | null = null;
/** Wall clock in ms. Tests may pin it with setClockForTest. */
export function nowMs(): number {
  return clockOverride ? clockOverride() : Date.now();
}
export function setClockForTest(fn: (() => number) | null): void {
  clockOverride = fn;
}

/** ISO-8601 in Hong Kong time with an explicit +08:00 offset, e.g. 2026-10-07T18:30:05.123+08:00. */
export function toHkt(ms: number): string {
  return new Date(ms + 8 * 3600_000).toISOString().replace("Z", "+08:00");
}

/** Parse an ISO timestamp (any offset) to epoch ms; null when absent or unparsable. */
export function parseTs(v: unknown): number | null {
  if (typeof v !== "string" || !v) return null;
  const n = Date.parse(v);
  return Number.isFinite(n) ? n : null;
}
