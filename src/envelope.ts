import { canonicalJson, sha256Hex } from "./crypto";

/** Event names from hkjc-data-worker src/push/envelope.ts (hkjc-push/1.0). */
export const KNOWN_EVENTS = [
  "test",
  "schedule",
  "odds_update",
  "lock",
  "scratch",
  "result",
  "backfill_progress",
  "whitelist_alert",
  "horse_update",
  "injury_update",
  "runs_update",
  "dividends",
  "changes",
] as const;
export type PushEvent = (typeof KNOWN_EVENTS)[number];

export interface PushRunner {
  horse_no: number;
  horse_name: string | null;
  win_odds: number | null;
  place_odds: number | null;
  status: string | null;
  final_position: number | null;
}

export interface PushRace {
  race_no: number;
  post_time: string | null;
  snapshot_time: string;
  pool_status: string | null;
  runners: PushRunner[];
}

export interface PushEnvelope {
  schema: string;
  event: string;
  sent_at?: string;
  meeting_date: string | null;
  venue: string | null;
  races: PushRace[];
  meta?: Record<string, unknown>;
}

export type ParseResult = { ok: true; envelope: PushEnvelope } | { ok: false; error: string };

export function parseEnvelope(text: string): ParseResult {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, error: "invalid JSON" };
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { ok: false, error: "envelope must be an object" };
  }
  const e = data as Record<string, unknown>;
  if (typeof e.schema !== "string" || !e.schema.startsWith("hkjc-push/1.")) {
    return { ok: false, error: "unsupported schema" };
  }
  if (typeof e.event !== "string" || !e.event) return { ok: false, error: "missing event" };
  const races = Array.isArray(e.races) ? (e.races as PushRace[]) : [];
  return {
    ok: true,
    envelope: {
      schema: e.schema,
      event: e.event,
      sent_at: typeof e.sent_at === "string" ? e.sent_at : undefined,
      meeting_date: typeof e.meeting_date === "string" ? e.meeting_date : null,
      venue: typeof e.venue === "string" ? e.venue : null,
      races,
      meta: e.meta && typeof e.meta === "object" ? (e.meta as Record<string, unknown>) : undefined,
    },
  };
}

export function maxSnapshotTime(env: PushEnvelope): string | null {
  const times = env.races.map((r) => r?.snapshot_time).filter((t): t is string => typeof t === "string");
  if (times.length === 0) return null;
  return times.sort().at(-1) ?? null;
}

/**
 * Dedupe key.
 * 1. meta.content_hash when the sender provides it (dividends / changes / horse_update / runs_update).
 * 2. Otherwise a stable key from event + meeting + venue + (race_no@snapshot_time ...).
 *    hkjc-data-worker does NOT put meta.content_hash on odds_update / lock / scratch / result,
 *    and a retry re-sends the same stored payload, so race snapshot times are stable.
 * 3. Events without races/snapshots (injury_update, schedule, ...) fall back to a hash of
 *    the envelope minus sent_at, so a resend of identical content collapses.
 */
export async function dedupeKey(env: PushEnvelope): Promise<{ key: string; source: "meta.content_hash" | "derived" }> {
  const ch = env.meta?.content_hash;
  if (typeof ch === "string" && ch.trim()) {
    return { key: `${env.event}|ch:${ch.trim()}`, source: "meta.content_hash" };
  }
  const base = `${env.event}|${env.meeting_date ?? "-"}|${env.venue ?? "-"}`;
  const raceParts = env.races
    .filter((r) => r && typeof r.race_no === "number")
    .map((r) => `${r.race_no}@${r.snapshot_time ?? "-"}`)
    .sort();
  if (raceParts.length > 0) {
    return { key: `${base}|${raceParts.join(",")}`, source: "derived" };
  }
  const { sent_at: _drop, ...rest } = env;
  return { key: `${base}|body:${await sha256Hex(canonicalJson(rest))}`, source: "derived" };
}
