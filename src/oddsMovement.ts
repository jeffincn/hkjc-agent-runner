// Odds change density / movement stats computed from the append-only odds_ledger.
// Pure computation lives in computeOddsMovement() so it can be tested with fixtures;
// loadOddsMovement() reads the ledger (read-only) and feeds it in.
import { parseTs, toHkt } from "./env";

/** Upstream samples odds every 3–5 s, so at most ~12–20 changes per minute per series. */
export const SAMPLE_INTERVAL_SECONDS = 3;
/** A single change whose odds rise by at least this fraction (e.g. 4.0 -> 4.6) is a sudden jump (drifting out). */
export const JUMP_PCT = 0.15;
/** A single change whose odds fall by at least this fraction (e.g. 4.0 -> 3.4) is a sudden drop (being backed). */
export const DROP_PCT = 0.15;
/** A single change that moves implied probability (1/odds) by at least this many points (0..1 scale) is also flagged. */
export const PROB_SHIFT = 0.03;
/** A minute bucket with at least this many changes for one series is flagged as a burst (high density). */
export const BURST_CHANGES_PER_MINUTE = 8;
/** Rows read from the ledger per call. */
export const MOVEMENT_SCAN_CAP = 20000;

export type MoveFlag = "sudden_jump" | "sudden_drop" | "prob_shift" | "burst";

export interface LedgerRow {
  id: number;
  seq: number | null;
  race_no: number;
  runner_no: number;
  name_zh: string | null;
  name_en: string | null;
  bet_type: string;
  runner_id?: string | null;
  status?: string | null;
  prev_odds: number | null;
  new_odds: number | null;
  captured_at: string | null;
  received_at_hkt: string;
  post_race: number | boolean;
}

export interface Change {
  seq: number | null;
  at_hkt: string;
  minute_hkt: string;
  prev_odds: number;
  new_odds: number;
  abs_change: number;
  pct_change: number;
  prev_implied_p: number;
  new_implied_p: number;
  implied_p_change: number;
  cum_odds_drift: number;
  cum_pct_drift: number;
  cum_implied_p_drift: number;
  post_race: boolean;
  flags: MoveFlag[];
}

export interface MinuteBucket {
  minute_hkt: string;
  changes: number;
  net_odds_change: number;
  net_implied_p_change: number;
  max_abs_pct_change: number;
  flags: MoveFlag[];
}

export interface Series {
  race_no: number;
  /** Stable runner identity; null for legacy rows keyed only by runner_no. */
  runner_id: string | null;
  runner_no: number;
  name_zh: string | null;
  name_en: string | null;
  bet_type: string;
  first_odds: number | null;
  last_odds: number | null;
  change_count: number;
  active_minutes: number;
  max_changes_per_minute: number;
  cum_odds_drift: number;
  cum_pct_drift: number;
  cum_implied_p_drift: number;
  jumps: number;
  drops: number;
  bursts: number;
  minutes: MinuteBucket[];
  changes: Change[];
}

const EPS = 1e-9; // float tolerance so e.g. 4.0 -> 4.6 counts as exactly 15%
const r4 = (v: number) => Math.round(v * 1e4) / 1e4;
const valid = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;

function rowTime(r: LedgerRow): number | null {
  return parseTs(r.captured_at) ?? parseTs(r.received_at_hkt);
}

/** Classify one change against the documented thresholds. */
export function changeFlags(prev: number, next: number): MoveFlag[] {
  const flags: MoveFlag[] = [];
  const pct = (next - prev) / prev;
  if (pct >= JUMP_PCT - EPS) flags.push("sudden_jump");
  if (pct <= -DROP_PCT + EPS) flags.push("sudden_drop");
  if (Math.abs(1 / next - 1 / prev) >= PROB_SHIFT - EPS) flags.push("prob_shift");
  return flags;
}

/**
 * Rows must be in replay order (seq, then id). Rows with unchanged or missing odds are not
 * counted as changes; prev_odds is filled from the trajectory when absent (1.0 snapshots).
 */
/** Series identity: runner_id when present, else runner_no (legacy 1.0/1.1 payloads). */
export function runnerKey(r: { runner_id?: string | null; runner_no: number }): string {
  return r.runner_id ? `id:${r.runner_id}` : `no:${r.runner_no}`;
}
export const isStandbyRow = (r: { status?: string | null }) => (r.status ?? "").toLowerCase() === "standby";

export function computeOddsMovement(rows: LedgerRow[], opts: { excludePostRace?: boolean } = {}): Series[] {
  const map = new Map<string, Series & { _last: number | null; _first: number | null }>();
  for (const r of rows) {
    const post = r.post_race === 1 || r.post_race === true;
    if (opts.excludePostRace && post) continue;
    // Standby runners are not in the field: never counted in density / movement stats.
    if (isStandbyRow(r)) continue;
    const k = `${r.race_no}|${runnerKey(r)}|${r.bet_type}`;
    let s = map.get(k);
    if (!s) {
      s = {
        race_no: r.race_no, runner_id: r.runner_id ?? null, runner_no: r.runner_no, name_zh: r.name_zh, name_en: r.name_en, bet_type: r.bet_type,
        first_odds: null, last_odds: null, change_count: 0, active_minutes: 0, max_changes_per_minute: 0,
        cum_odds_drift: 0, cum_pct_drift: 0, cum_implied_p_drift: 0, jumps: 0, drops: 0, bursts: 0,
        minutes: [], changes: [], _last: null, _first: null,
      };
      map.set(k, s);
    }
    s.name_zh ??= r.name_zh;
    s.name_en ??= r.name_en;
    const prev = valid(r.prev_odds) ? r.prev_odds : s._last;
    const next = r.new_odds;
    if (!valid(next)) continue;
    if (s._first === null) s._first = valid(prev) ? prev : next;
    s._last = next;
    if (!valid(prev) || prev === next) continue;
    const t = rowTime(r);
    const at = t === null ? r.received_at_hkt : toHkt(t);
    const minute = t === null ? r.received_at_hkt.slice(0, 16) : toHkt(Math.floor(t / 60_000) * 60_000).slice(0, 16);
    const first = s._first;
    s.changes.push({
      seq: r.seq, at_hkt: at, minute_hkt: minute, prev_odds: prev, new_odds: next,
      abs_change: r4(next - prev), pct_change: r4((next - prev) / prev),
      prev_implied_p: r4(1 / prev), new_implied_p: r4(1 / next), implied_p_change: r4(1 / next - 1 / prev),
      cum_odds_drift: r4(next - first), cum_pct_drift: r4((next - first) / first), cum_implied_p_drift: r4(1 / next - 1 / first),
      post_race: post, flags: changeFlags(prev, next),
    });
  }
  const out: Series[] = [];
  for (const s of map.values()) {
    const { _last, _first, ...series } = s;
    series.first_odds = _first;
    series.last_odds = _last;
    series.change_count = s.changes.length;
    if (_first !== null && _last !== null) {
      series.cum_odds_drift = r4(_last - _first);
      series.cum_pct_drift = r4((_last - _first) / _first);
      series.cum_implied_p_drift = r4(1 / _last - 1 / _first);
    }
    const buckets = new Map<string, MinuteBucket>();
    for (const c of s.changes) {
      let b = buckets.get(c.minute_hkt);
      if (!b) { b = { minute_hkt: c.minute_hkt, changes: 0, net_odds_change: 0, net_implied_p_change: 0, max_abs_pct_change: 0, flags: [] }; buckets.set(c.minute_hkt, b); }
      b.changes++;
      b.net_odds_change = r4(b.net_odds_change + c.abs_change);
      b.net_implied_p_change = r4(b.net_implied_p_change + c.implied_p_change);
      b.max_abs_pct_change = Math.max(b.max_abs_pct_change, Math.abs(c.pct_change));
      for (const f of c.flags) if (!b.flags.includes(f)) b.flags.push(f);
      if (c.flags.includes("sudden_jump")) series.jumps++;
      if (c.flags.includes("sudden_drop")) series.drops++;
    }
    series.minutes = [...buckets.values()].sort((a, b) => a.minute_hkt.localeCompare(b.minute_hkt));
    for (const b of series.minutes) {
      if (b.changes >= BURST_CHANGES_PER_MINUTE) { b.flags.push("burst"); series.bursts++; }
    }
    series.active_minutes = series.minutes.length;
    series.max_changes_per_minute = series.minutes.reduce((m, b) => Math.max(m, b.changes), 0);
    out.push(series);
  }
  return out.sort((a, b) => a.race_no - b.race_no || a.runner_no - b.runner_no || a.bet_type.localeCompare(b.bet_type));
}

export interface MovementQuery { meeting_date: string; race_no?: number; horse?: string; bet_type?: string; exclude_post_race?: boolean; include_changes?: boolean }

/** horse matches a runner_id (exact, case-insensitive), a runner number ("7") or a case-insensitive substring of name_zh / name_en. */
export function matchHorse(s: { runner_id?: string | null; runner_no: number; name_zh: string | null; name_en: string | null }, horse?: string): boolean {
  if (!horse) return true;
  const h = horse.trim().toLowerCase();
  if (s.runner_id && s.runner_id.toLowerCase() === h) return true;
  if (/^\d+$/.test(h)) return s.runner_no === Number(h);
  return (s.name_zh ?? "").toLowerCase().includes(h) || (s.name_en ?? "").toLowerCase().includes(h);
}

export async function loadOddsMovement(db: D1Database, q: MovementQuery) {
  const where = ["meeting_date = ?"];
  const binds: unknown[] = [q.meeting_date];
  if (q.race_no !== undefined) { where.push("race_no = ?"); binds.push(q.race_no); }
  if (q.bet_type) { where.push("bet_type = ?"); binds.push(q.bet_type); }
  const res = await db.prepare(
    `SELECT id, seq, race_no, runner_no, runner_id, status, name_zh, name_en, bet_type, prev_odds, new_odds, captured_at, received_at_hkt, post_race
     FROM odds_ledger WHERE ${where.join(" AND ")} ORDER BY seq IS NULL, seq, id LIMIT ?`,
  ).bind(...binds, MOVEMENT_SCAN_CAP + 1).all<LedgerRow>();
  const all = res.results ?? [];
  const series = computeOddsMovement(all.slice(0, MOVEMENT_SCAN_CAP), { excludePostRace: q.exclude_post_race })
    .filter((s) => matchHorse(s, q.horse))
    .map((s) => (q.include_changes === false ? { ...s, changes: [] } : s));
  return {
    meeting_date: q.meeting_date,
    thresholds: {
      sample_interval_seconds: SAMPLE_INTERVAL_SECONDS, jump_pct: JUMP_PCT, drop_pct: DROP_PCT,
      prob_shift: PROB_SHIFT, burst_changes_per_minute: BURST_CHANGES_PER_MINUTE,
    },
    keyed_by: "runner_id (fallback runner_no for legacy rows); Standby rows excluded",
    series_count: series.length,
    scan_truncated: all.length > MOVEMENT_SCAN_CAP,
    series,
  };
}
