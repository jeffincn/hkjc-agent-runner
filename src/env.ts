export interface QueueMessageBody {
  inbox_id: string;
}

export interface Env {
  DB: D1Database;
  EVENTS_QUEUE: Queue<QueueMessageBody>;
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
  ODDS_COALESCE_SECONDS?: string;
  MAX_ROUNDS?: string;
  MAX_PROCESS_ATTEMPTS?: string;
}

export function envInt(v: string | undefined, def: number, min: number, max: number): number {
  const n = Number.parseInt(v ?? "", 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

export function nowIso(): string {
  return new Date().toISOString();
}
