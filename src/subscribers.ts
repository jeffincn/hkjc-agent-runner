import type { Env } from "./env";
import { nowIso, nowMs } from "./env";

/** Default: 3 hours before first race post. */
export const DEFAULT_SUBSCRIBER_WINDOW_BEFORE_SEC = 10_800;

const HHMM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export type ActiveWindowMode = "always" | "raceday";

export function parseActiveWindow(raw: unknown): ActiveWindowMode {
  if (raw === "raceday") return "raceday";
  return "always";
}

export function parseWindowBeforeSec(raw: unknown): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_SUBSCRIBER_WINDOW_BEFORE_SEC;
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

/**
 * event_filter: empty array = all events; otherwise only listed types.
 * Accepts string[] or a JSON string.
 */
export function parseEventFilter(raw: unknown): string[] {
  if (raw === null || raw === undefined || raw === "") return [];
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed || trimmed === "[]" || trimmed === "*") return [];
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      return parseEventFilter(parsed);
    } catch {
      // comma-separated fallback
      return trimmed
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    }
  }
  if (!Array.isArray(raw)) {
    throw new Error("event_filter must be an array of event type strings");
  }
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string" || !item.trim()) {
      throw new Error("event_filter entries must be non-empty strings");
    }
    out.push(item.trim());
  }
  return out;
}

export function eventFilterMatches(filter: string[], eventType: string): boolean {
  if (filter.length === 0) return true;
  return filter.includes(eventType);
}

export interface AgentSubscriber {
  id: number;
  url: string;
  secret: string | null;
  enabled: boolean;
  event_filter: string[];
  active_window: ActiveWindowMode;
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

/** Public list shape — never expose the secret value. */
export interface AgentSubscriberPublic {
  id: number;
  url: string;
  enabled: boolean;
  has_secret: boolean;
  event_filter: string[];
  active_window: ActiveWindowMode;
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

export function toPublicSubscriber(row: AgentSubscriber): AgentSubscriberPublic {
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

type SubscriberRow = {
  id: number;
  url: string;
  secret: string | null;
  enabled: number;
  event_filter: string;
  active_window: string;
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
};

function mapSubscriberRow(r: SubscriberRow): AgentSubscriber {
  return {
    id: r.id,
    url: r.url,
    secret: r.secret,
    enabled: r.enabled === 1,
    event_filter: parseEventFilter(r.event_filter),
    active_window: parseActiveWindow(r.active_window),
    window_before_sec: parseWindowBeforeSec(r.window_before_sec ?? DEFAULT_SUBSCRIBER_WINDOW_BEFORE_SEC),
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

const SUBSCRIBER_SELECT = `SELECT id, url, secret, enabled, event_filter,
  IFNULL(active_window, 'always') AS active_window,
  IFNULL(window_before_sec, ${DEFAULT_SUBSCRIBER_WINDOW_BEFORE_SEC}) AS window_before_sec,
  quiet_start, quiet_end, created_at, updated_at,
  IFNULL(consecutive_failures, 0) AS consecutive_failures,
  IFNULL(consecutive_429s, 0) AS consecutive_429s,
  IFNULL(circuit_state, 'closed') AS circuit_state,
  circuit_opened_at, last_success_at, last_failure_at, last_http_status, last_error
 FROM agent_subscribers`;

export async function listSubscribers(env: Env): Promise<AgentSubscriber[]> {
  const { results } = await env.DB.prepare(`${SUBSCRIBER_SELECT} ORDER BY id ASC`).all<SubscriberRow>();
  return (results ?? []).map(mapSubscriberRow);
}

export async function listEnabledSubscribers(env: Env): Promise<AgentSubscriber[]> {
  const all = await listSubscribers(env);
  return all.filter((s) => s.enabled);
}

export async function getSubscriber(env: Env, id: number): Promise<AgentSubscriber | null> {
  const r = await env.DB.prepare(`${SUBSCRIBER_SELECT} WHERE id = ?`).bind(id).first<SubscriberRow>();
  if (!r) return null;
  return mapSubscriberRow(r);
}

export interface SubscriberWriteInput {
  url: string;
  secret?: string | null;
  enabled?: boolean;
  event_filter?: string[] | string;
  active_window?: ActiveWindowMode | string;
  window_before_sec?: number;
  quiet_start?: string | null;
  quiet_end?: string | null;
}

export interface SubscriberPatch {
  url?: string;
  secret?: string | null;
  enabled?: boolean;
  event_filter?: string[] | string;
  active_window?: ActiveWindowMode | string;
  window_before_sec?: number;
  quiet_start?: string | null;
  quiet_end?: string | null;
}

function normalizeWindowFields(input: {
  active_window?: ActiveWindowMode | string;
  window_before_sec?: number;
}): { active_window: ActiveWindowMode; window_before_sec: number } {
  if (
    input.active_window !== undefined &&
    input.active_window !== "always" &&
    input.active_window !== "raceday"
  ) {
    throw new Error("active_window must be 'always' or 'raceday'");
  }
  const active_window =
    input.active_window !== undefined ? parseActiveWindow(input.active_window) : "always";
  let window_before_sec = DEFAULT_SUBSCRIBER_WINDOW_BEFORE_SEC;
  if (input.window_before_sec !== undefined) {
    const n = Number(input.window_before_sec);
    if (!Number.isFinite(n) || n < 0) {
      throw new Error("window_before_sec must be a non-negative number");
    }
    window_before_sec = Math.floor(n);
  }
  return { active_window, window_before_sec };
}

function assertAbsoluteUrl(url: string): void {
  if (!url) throw new Error("url is required");
  try {
    new URL(url);
  } catch {
    throw new Error("url must be a valid absolute URL");
  }
}

export async function createSubscriber(env: Env, input: SubscriberWriteInput): Promise<AgentSubscriber> {
  const url = input.url.trim();
  assertAbsoluteUrl(url);
  const ts = nowIso();
  const enabled = input.enabled === false ? 0 : 1;
  const secret =
    typeof input.secret === "string" && input.secret.trim() !== "" ? input.secret.trim() : null;
  const event_filter = parseEventFilter(input.event_filter);
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
      JSON.stringify(event_filter),
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
  const row = await getSubscriber(env, Number(id));
  if (!row) throw new Error("failed to load created subscriber");
  return row;
}

export async function updateSubscriber(
  env: Env,
  id: number,
  patch: SubscriberPatch,
): Promise<AgentSubscriber | null> {
  const existing = await getSubscriber(env, id);
  if (!existing) return null;

  let url = existing.url;
  if (typeof patch.url === "string") {
    url = patch.url.trim();
    assertAbsoluteUrl(url);
  }

  let secret = existing.secret;
  if (patch.secret !== undefined) {
    if (patch.secret === null || patch.secret === "") secret = null;
    else secret = patch.secret.trim();
  }

  const enabled =
    patch.enabled === undefined ? (existing.enabled ? 1 : 0) : patch.enabled ? 1 : 0;

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

  let quiet_start = existing.quiet_start;
  let quiet_end = existing.quiet_end;
  if (patch.quiet_start !== undefined || patch.quiet_end !== undefined) {
    quiet_start =
      patch.quiet_start !== undefined ? parseQuietHhMm(patch.quiet_start) : existing.quiet_start;
    quiet_end = patch.quiet_end !== undefined ? parseQuietHhMm(patch.quiet_end) : existing.quiet_end;
  }

  const ts = nowIso();
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
      JSON.stringify(event_filter),
      active_window,
      window_before_sec,
      quiet_start,
      quiet_end,
      ts,
      id,
    )
    .run();

  return getSubscriber(env, id);
}

export async function deleteSubscriber(env: Env, id: number): Promise<boolean> {
  const result = await env.DB.prepare(`DELETE FROM agent_subscribers WHERE id = ?`).bind(id).run();
  return (result.meta.changes ?? 0) > 0;
}

/**
 * Quiet hours: both quiet_start and quiet_end set → quiet in that Asia/Hong_Kong span
 * (overnight wrap ok). Either null → no quiet.
 */
export function isInQuietHours(
  quietStart: string | null,
  quietEnd: string | null,
  atMs: number = nowMs(),
): boolean {
  if (!quietStart || !quietEnd) return false;
  const startM = hhmmToMinutes(quietStart);
  const endM = hhmmToMinutes(quietEnd);
  if (startM === null || endM === null) return false;
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Hong_Kong",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date(atMs));
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  const nowM = hour * 60 + minute;
  if (startM === endM) return true; // full-day quiet
  if (startM < endM) return nowM >= startM && nowM < endM;
  // overnight wrap e.g. 23:00–08:00
  return nowM >= startM || nowM < endM;
}

function hhmmToMinutes(hhmm: string): number | null {
  const m = HHMM_RE.exec(hhmm);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/**
 * raceday window: only deliver when now is within
 * [first_post - window_before_sec, …). Without schedule rows, allow delivery
 * (unknown schedule should not silently drop).
 */
export async function isWithinActiveWindow(
  env: Env,
  sub: AgentSubscriber,
  meetingDate: string | null,
  atMs: number = nowMs(),
): Promise<boolean> {
  if (sub.active_window === "always") return true;
  if (!meetingDate) return false;
  const first = await env.DB.prepare(
    `SELECT MIN(post_time) AS post_time FROM race_schedule WHERE meeting_date = ?`,
  )
    .bind(meetingDate)
    .first<{ post_time: string | null }>();
  if (!first?.post_time) return true; // no schedule yet — do not drop
  const postMs = Date.parse(first.post_time);
  if (!Number.isFinite(postMs)) return true;
  const openAt = postMs - sub.window_before_sec * 1000;
  return atMs >= openAt;
}
