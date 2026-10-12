import type { PushEnvelope } from "./envelope";
import { parseTs, toHkt } from "./env";

export const QUALITY_FLAGS = [
  "missing_source_time",
  "gap",
  "out_of_order",
  "duplicate",
  "future_timestamp",
  "post_start",
  "late",
] as const;
export type QualityFlag = (typeof QUALITY_FLAGS)[number];

/** Allowed clock skew before a timestamp counts as "in the future" relative to our receive time. */
export const FUTURE_SKEW_MS = 30_000;
/** received - captured above this is "late" (upstream quality.late_ms > 0 also counts). */
export const LATE_THRESHOLD_MS = 60_000;

/** Events whose content feeds pre-race analysis. post_start ones are diverted to post-race/record only. */
export const PRE_RACE_INPUT_EVENTS = new Set(["odds_update", "odds_delta", "scratch", "horse_update", "injury_update"]);

/**
 * HKJC never supplies source.last_updated_at for these events (schedule, form/past-performance,
 * horse master updates, no_update heartbeats). Still store null; do not raise missing_source_time.
 * Keep flagging for odds_delta/odds_update, lock, result, dividends, scratch (and other types).
 */
export const SOURCE_TIME_NOT_EXPECTED = new Set(["schedule", "runs_update", "horse_update", "no_update"]);

export interface StreamSnapshot {
  last_seq: number | null;
}

export interface Timing {
  received_ms: number;
  received_at_hkt: string;
  sent_at: string | null;
  captured_at: string | null;
  source_updated_at: string | null;
  delay_received_sent_ms: number | null;
  delay_received_captured_ms: number | null;
  delay_captured_source_ms: number | null;
}

export interface Assessment extends Timing {
  flags: QualityFlag[];
  /** Races (by race_no) referenced by the event that had already started at receive time. */
  started_races: number[];
  referenced_races: number[];
  /** True when every referenced race had started: whole event is post-race. */
  post_race: boolean;
  gap: { from_seq: number; to_seq: number } | null;
}

function maxIso(values: (string | null | undefined)[]): string | null {
  let best: string | null = null;
  let bestMs = -Infinity;
  for (const v of values) {
    const ms = parseTs(v);
    if (ms !== null && ms > bestMs) { bestMs = ms; best = v as string; }
  }
  return best;
}

export function referencedRaces(ev: PushEnvelope): number[] {
  const set = new Set<number>();
  for (const r of ev.races) if (typeof r?.race_no === "number") set.add(r.race_no);
  for (const c of ev.v11?.changes ?? []) set.add(c.race_no);
  return [...set].sort((a, b) => a - b);
}

export function timingOf(ev: PushEnvelope, receivedMs: number): Timing {
  const v = ev.v11;
  const sent = v?.sent_at ?? ev.sent_at ?? null;
  // 1.0 has no captured_at; the latest race snapshot_time is the closest thing.
  const captured = v ? v.captured_at : maxIso(ev.races.map((r) => r?.snapshot_time));
  const source = v ? v.source_last_updated_at : null;
  const d = (a: number | null, b: number | null) => (a !== null && b !== null ? a - b : null);
  const sMs = parseTs(sent), cMs = parseTs(captured), srcMs = parseTs(source);
  return {
    received_ms: receivedMs,
    received_at_hkt: toHkt(receivedMs),
    sent_at: sent,
    captured_at: captured,
    source_updated_at: source,
    delay_received_sent_ms: d(receivedMs, sMs),
    delay_received_captured_ms: d(receivedMs, cMs),
    delay_captured_source_ms: d(cMs, srcMs),
  };
}

/**
 * Pure: decide flags for one new (non-deduplicated) event.
 * postTimes: race_no -> post time (ISO) from schedule data and the event itself.
 * seqSeen: whether this seq was already stored under a different event_id.
 */
export function assess(
  ev: PushEnvelope,
  receivedMs: number,
  stream: StreamSnapshot,
  postTimes: Map<number, string>,
  seqSeen: boolean,
): Assessment {
  const t = timingOf(ev, receivedMs);
  const flags = new Set<QualityFlag>();
  const v = ev.v11;

  // missing_source_time: flag only when a source time is expected for this event type.
  // Source null is still recorded on the inbox row via timing / v11 fields.
  if (
    !SOURCE_TIME_NOT_EXPECTED.has(ev.event) &&
    (!v || !t.source_updated_at || v.quality.missing_source_time === true)
  ) {
    flags.add("missing_source_time");
  }

  for (const ts of [t.sent_at, t.captured_at, t.source_updated_at]) {
    const ms = parseTs(ts);
    if (ms !== null && ms - receivedMs > FUTURE_SKEW_MS) flags.add("future_timestamp");
  }
  // captured before source update is impossible too
  if (t.delay_captured_source_ms !== null && t.delay_captured_source_ms < -FUTURE_SKEW_MS) flags.add("future_timestamp");

  if ((v?.quality.late_ms ?? 0) > 0 || (t.delay_received_captured_ms ?? 0) > LATE_THRESHOLD_MS) flags.add("late");

  let gap: Assessment["gap"] = null;
  const seq = v?.seq ?? null;
  if (seq !== null) {
    if (seqSeen) flags.add("duplicate");
    else if (stream.last_seq !== null) {
      if (seq <= stream.last_seq) flags.add("out_of_order");
      else if (seq > stream.last_seq + 1) {
        flags.add("gap");
        gap = { from_seq: stream.last_seq + 1, to_seq: seq - 1 };
      }
    }
  }

  const refs = referencedRaces(ev);
  const started: number[] = [];
  for (const n of refs) {
    const pt = parseTs(postTimes.get(n));
    if (pt !== null && receivedMs >= pt) started.push(n);
  }
  if (started.length > 0 || v?.quality.post_start === true) flags.add("post_start");
  // Whole event is post-race when every referenced race had started (schedule data wins);
  // if we have no start time for any referenced race, trust upstream quality.post_start.
  const upstream = v?.quality.post_start === true;
  const known = refs.filter((n) => postTimes.has(n));
  const post_race = refs.length === 0 ? upstream : known.length === 0 ? upstream : started.length === refs.length;

  return { ...t, flags: QUALITY_FLAGS.filter((f) => flags.has(f)), started_races: started, referenced_races: refs, post_race, gap };
}

// ---------------------------------------------------------------- stream liveness

/** Expected push interval inside the fast window, and outside it. */
export const FAST_INTERVAL_MS = 60_000;
export const SLOW_INTERVAL_MS = 5 * 60_000;
/**
 * Fast window (judgment call): from 30 min before any race's post time until 10 min after it.
 * HKJC odds move fastest in the last half hour, and lock/result follow within minutes of the off.
 */
export const FAST_WINDOW_BEFORE_MS = 30 * 60_000;
export const FAST_WINDOW_AFTER_MS = 10 * 60_000;
/** Silence beyond interval × STALE_FACTOR = stale; beyond interval × BROKEN_FACTOR = broken. */
export const STALE_FACTOR = 2;
export const BROKEN_FACTOR = 5;

export type StreamStatus = "ok" | "stale" | "broken" | "no_data";

export function inFastWindow(nowMs: number, postTimes: string[]): boolean {
  return postTimes.some((p) => {
    const ms = parseTs(p);
    return ms !== null && nowMs >= ms - FAST_WINDOW_BEFORE_MS && nowMs <= ms + FAST_WINDOW_AFTER_MS;
  });
}

export function streamStatus(
  nowMs: number,
  lastSeenIso: string | null,
  postTimes: string[],
): { status: StreamStatus; fast_window: boolean; expected_interval_ms: number; silence_ms: number | null } {
  const fast = inFastWindow(nowMs, postTimes);
  const interval = fast ? FAST_INTERVAL_MS : SLOW_INTERVAL_MS;
  const last = parseTs(lastSeenIso);
  if (last === null) return { status: "no_data", fast_window: fast, expected_interval_ms: interval, silence_ms: null };
  const silence = nowMs - last;
  const status: StreamStatus = silence > interval * BROKEN_FACTOR ? "broken" : silence > interval * STALE_FACTOR ? "stale" : "ok";
  return { status, fast_window: fast, expected_interval_ms: interval, silence_ms: silence };
}
