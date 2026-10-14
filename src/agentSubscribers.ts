import type { Env } from "./env";
import { KNOWN_EVENTS } from "./envelope";
import { nowIso } from "./env";

/** Default: 3 hours before first race post (mirrors hkjc-worker). */
export const DEFAULT_WINDOW_BEFORE_SEC = 10_800;

const HHMM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export type AgentActiveWindow = "always" | "raceday";

export function parseActiveWindow(raw: unknown): AgentActiveWindow {
  if (raw === "raceday") return "raceday";
  return "always";
}

export function parseWindowBeforeSec(raw: unknown): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_WINDOW_BEFORE_SEC;
  return Math.floor(n);
}

/** Parse HH:MM; empty/null → null (cleared). Invalid → throws. */
export function parseQuietHhMm(raw: unknown): string | null {
  if (raw === null || raw === undefined || raw === "") return null;
  if (typeof raw !== "string") {
    throw new Error("quiet_start/quiet_end must be HH:MM strings or null");
  }
  const s = raw.trim();
  if (s === "") return null;
  if (!HHMM_RE.test(s)) {
    throw new Error("quiet_start/quiet_end must be HH:MM (Asia/Hong_Kong)");
  }
  return s;
}

const KNOWN = new Set<string>(KNOWN_EVENTS as readonly string[]);

/**
 * Parse the event_filter. null/undefined/[] → null (all events).
 * Every entry must be a known push event name; otherwise throws.
 */
export function parseEventFilter(raw: unknown): string[] | null {
  if (raw === null || raw === undefined) return null;
  if (!Array.isArray(raw)) throw new Error("event_filter must be an array of event names or null");
  const out: string[] = [];
  for (const e of raw) {
    if (typeof e !== "string" || !KNOWN.has(e)) {
      throw new Error(`event_filter: unknown event "${String(e)}"`);
    }
    if (!out.includes(e)) out.push(e);
  }
  return out.length === 0 ? null : out;
}

/** v1: event-type filtering only. null filter (or empty) matches every event. */
export function subscriberWantsEvent(
  sub: Pick<AgentSubscriber, "event_filter">,
  eventType: string,
): boolean {
  const f = sub.event_filter;
  if (!f || f.length === 0) return true;
  return f.includes(eventType);
}

export interface AgentSubscriber {
  id: number;
  url: string;
  secret: string | null;
  enabled: boolean;
  /** null = all events; otherwise the event types this subscriber wants. */
  event_filter: string[] | null;
  active_window: AgentActiveWindow;
  window_before_sec: number;
  quiet_start: string | null;
  quiet_end: string | null;
  created_at: string;
  updated_at: string;
  consecutive_failures: number;
  consecutive_429s: number;
  circuit_state: string;
  circuit_opened_at: string | null;
  last_success_at: string | null;
  last_failure_at: string | null;
  last_http_status: number | null;
  last_error: string | null;
}

/** Public shape — never expose the secret value. */
export interface AgentSubscriberPublic {
  id: number;
  url: string;
  enabled: boolean;
  has_secret: boolean;
  event_filter: string[] | null;
  active_window: AgentActiveWindow;
  window_before_sec: number;
  quiet_start: string | null;
  quiet_end: string | null;
  created_at: string;
  updated_at: string;
  circuit_state: string;
  consecutive_failures: number;
  consecutive_429s: number;
  circuit_opened_at: string | null;
  last_success_at: string | null;
  last_failure_at: string | null;
  last_http_status: number | null;
  last_error: string | null;
}

export function toPublicAgentSubscriber(row: AgentSubscriber): AgentSubscriberPublic {
  return {
    id: row.id,
    url: row.url,
    enabled: row.enabled,
    has_secret: !!(row.secret && row.secret.length > 0),
    event_filter: row.event_filter,
    active_window: row.active_window,
    window_before_sec: row.window_before_sec,
    quiet_start: row.quiet_start,
    quiet_end: row.quiet_end,
    created_at: row.created_at,
    updated_at: row.updated_at,
    circuit_state: row.circuit_state ?? "closed",
    consecutive_failures: row.consecutive_failures ?? 0,
    consecutive_429s: row.consecutive_429s ?? 0,
    circuit_opened_at: row.circuit_opened_at ?? null,
    last_success_at: row.last_success_at ?? null,
    last_failure_at: row.last_failure_at ?? null,
    last_http_status: row.last_http_status ?? null,
    last_error: row.last_error ?? null,
  };
}

function nowIsoStr(): string {
  return nowIso();
}

interface AgentSubscriberRow {
  id: number;
  url: string;
  secret: string | null;
  enabled: number;
  event_filter: string | null;
  active_window?: string | null;
  window_before_sec?: number | null;
  quiet_start?: string | null;
  quiet_end?: string | null;
  created_at: string;
  updated_at: string;
  consecutive_failures?: number | null;
  consecutive_429s?: number | null;
  circuit_state?: string | null;
  circuit_opened_at?: string | null;
  last_success_at?: string | null;
  last_failure_at?: string | null;
  last_http_status?: number | null;
  last_error?: string | null;
}

function mapRow(r: AgentSubscriberRow): AgentSubscriber {
  let event_filter: string[] | null = null;
  if (r.event_filter) {
    try {
      const parsed: unknown = JSON.parse(r.event_filter);
      event_filter = parseEventFilter(parsed);
    } catch {
      event_filter = null;
    }
  }
  return {
    id: r.id,
    url: r.url,
    secret: r.secret,
    enabled: r.enabled === 1,
    event_filter,
    active_window: parseActiveWindow(r.active_window),
    window_before_sec: parseWindowBeforeSec(r.window_before_sec ?? DEFAULT_WINDOW_BEFORE_SEC),
    quiet_start: r.quiet_start ?? null,
    quiet_end: r.quiet_end ?? null,
    created_at: r.created_at,
    updated_at: r.updated_at,
    consecutive_failures: r.consecutive_failures ?? 0,
    consecutive_429s: r.consecutive_429s ?? 0,
    circuit_state: r.circuit_state ?? "closed",
    circuit_opened_at: r.circuit_opened_at ?? null,
    last_success_at: r.last_success_at ?? null,
    last_failure_at: r.last_failure_at ?? null,
    last_http_status: r.last_http_status ?? null,
    last_error: r.last_error ?? null,
  };
}

const SELECT_COLS = `id, url, secret, enabled, event_filter, created_at, updated_at,
  IFNULL(active_window, 'always') AS active_window,
  IFNULL(window_before_sec, ${DEFAULT_WINDOW_BEFORE_SEC}) AS window_before_sec,
  quiet_start, quiet_end,
  IFNULL(consecutive_failures, 0) AS consecutive_failures,
  IFNULL(consecutive_429s, 0) AS consecutive_429s,
  IFNULL(circuit_state, 'closed') AS circuit_state,
  circuit_opened_at, last_success_at, last_failure_at, last_http_status, last_error`;

export async function listAgentSubscribers(env: Env): Promise<AgentSubscriber[]> {
  const { results } = await env.DB.prepare(
    `SELECT ${SELECT_COLS} FROM agent_subscribers ORDER BY id ASC`,
  ).all<AgentSubscriberRow>();
  return (results ?? []).map(mapRow);
}

export async function listEnabledAgentSubscribers(env: Env): Promise<AgentSubscriber[]> {
  const all = await listAgentSubscribers(env);
  return all.filter((s) => s.enabled);
}

export async function getAgentSubscriber(env: Env, id: number): Promise<AgentSubscriber | null> {
  const r = await env.DB.prepare(`SELECT ${SELECT_COLS} FROM agent_subscribers WHERE id = ?`)
    .bind(id)
    .first<AgentSubscriberRow>();
  return r ? mapRow(r) : null;
}

export interface AgentSubscriberWriteInput {
  url: string;
  secret?: string | null;
  enabled?: boolean;
  event_filter?: string[] | null;
  active_window?: AgentActiveWindow | string;
  window_before_sec?: number;
  quiet_start?: string | null;
  quiet_end?: string | null;
}

export interface AgentSubscriberPatch {
  url?: string;
  secret?: string | null;
  enabled?: boolean;
  event_filter?: string[] | null;
  active_window?: AgentActiveWindow | string;
  window_before_sec?: number;
  quiet_start?: string | null;
  quiet_end?: string | null;
}

function normalizeWindowFields(input: {
  active_window?: AgentActiveWindow | string;
  window_before_sec?: number;
}): { active_window: AgentActiveWindow; window_before_sec: number } {
  if (
    input.active_window !== undefined &&
    input.active_window !== "always" &&
    input.active_window !== "raceday"
  ) {
    throw new Error("active_window must be 'always' or 'raceday'");
  }
  const active_window =
    input.active_window !== undefined ? parseActiveWindow(input.active_window) : "always";
  let window_before_sec = DEFAULT_WINDOW_BEFORE_SEC;
  if (input.window_before_sec !== undefined) {
    const n = Number(input.window_before_sec);
    if (!Number.isFinite(n) || n < 0) {
      throw new Error("window_before_sec must be a non-negative number");
    }
    window_before_sec = Math.floor(n);
  }
  return { active_window, window_before_sec };
}

function normalizeSecret(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  return raw.trim();
}

export async function createAgentSubscriber(
  env: Env,
  input: AgentSubscriberWriteInput,
): Promise<AgentSubscriber> {
  const url = (input.url ?? "").trim();
  if (!url) throw new Error("url is required");
  try {
    new URL(url);
  } catch {
    throw new Error("url must be a valid absolute URL");
  }
  const ts = nowIsoStr();
  const enabled = input.enabled === false ? 0 : 1;
  const secret = normalizeSecret(input.secret);
  const event_filter = parseEventFilter(input.event_filter ?? null);
  const { active_window, window_before_sec } = normalizeWindowFields({
    active_window: input.active_window ?? "always",
    window_before_sec: input.window_before_sec,
  });
  const quiet_start = input.quiet_start !== undefined ? parseQuietHhMm(input.quiet_start) : null;
  const quiet_end = input.quiet_end !== undefined ? parseQuietHhMm(input.quiet_end) : null;

  const result = await env.DB.prepare(
    `INSERT INTO agent_subscribers
      (url, secret, enabled, event_filter, active_window, window_before_sec, quiet_start, quiet_end, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      url,
      secret,
      enabled,
      event_filter ? JSON.stringify(event_filter) : null,
      active_window,
      window_before_sec,
      quiet_start,
      quiet_end,
      ts,
      ts,
    )
    .run();

  const id = result.meta.last_row_id;
  if (!id) throw new Error("failed to create subscriber");
  const row = await getAgentSubscriber(env, Number(id));
  if (!row) throw new Error("failed to load created subscriber");
  return row;
}

export async function updateAgentSubscriber(
  env: Env,
  id: number,
  patch: AgentSubscriberPatch,
): Promise<AgentSubscriber | null> {
  const existing = await getAgentSubscriber(env, id);
  if (!existing) return null;

  let url = existing.url;
  if (typeof patch.url === "string") {
    url = patch.url.trim();
    if (!url) throw new Error("url is required");
    try {
      new URL(url);
    } catch {
      throw new Error("url must be a valid absolute URL");
    }
  }

  const secret = patch.secret !== undefined ? normalizeSecret(patch.secret) : existing.secret;
  const enabled = patch.enabled === undefined ? (existing.enabled ? 1 : 0) : patch.enabled ? 1 : 0;
  const event_filter =
    patch.event_filter !== undefined ? parseEventFilter(patch.event_filter) : existing.event_filter;

  let active_window = existing.active_window;
  let window_before_sec = existing.window_before_sec;
  if (patch.active_window !== undefined || patch.window_before_sec !== undefined) {
    const normalized = normalizeWindowFields({
      active_window: patch.active_window ?? existing.active_window,
      window_before_sec:
        patch.window_before_sec !== undefined ? patch.window_before_sec : existing.window_before_sec,
    });
    active_window = normalized.active_window;
    window_before_sec = normalized.window_before_sec;
  }

  const quiet_start =
    patch.quiet_start !== undefined ? parseQuietHhMm(patch.quiet_start) : existing.quiet_start;
  const quiet_end =
    patch.quiet_end !== undefined ? parseQuietHhMm(patch.quiet_end) : existing.quiet_end;

  const ts = nowIsoStr();
  await env.DB.prepare(
    `UPDATE agent_subscribers
     SET url = ?, secret = ?, enabled = ?, event_filter = ?, active_window = ?, window_before_sec = ?,
         quiet_start = ?, quiet_end = ?, updated_at = ?
     WHERE id = ?`,
  )
    .bind(
      url,
      secret,
      enabled,
      event_filter ? JSON.stringify(event_filter) : null,
      active_window,
      window_before_sec,
      quiet_start,
      quiet_end,
      ts,
      id,
    )
    .run();

  return getAgentSubscriber(env, id);
}

export async function deleteAgentSubscriber(env: Env, id: number): Promise<boolean> {
  const result = await env.DB.prepare(`DELETE FROM agent_subscribers WHERE id = ?`).bind(id).run();
  return (result.meta.changes ?? 0) > 0;
}
