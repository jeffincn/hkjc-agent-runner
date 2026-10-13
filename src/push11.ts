/**
 * hkjc-push/1.1 field mapping. THIS IS THE ONLY PLACE that knows 1.1 field names.
 *
 * Authoritative schema: https://github.com/jeffincn/hkjc-worker/blob/main/docs/push-schema-1.1.md
 * When upstream renames fields, edit FIELD_MAP / CHANGE_FIELDS only; nothing else in the
 * runner reads 1.1 keys directly. Event type key is `event` (never `type`).
 */

type Path = readonly string[];

/** Matches hkjc-worker ODDS_BASIS / schema const for odds_delta.changes[].odds_basis. */
export const ODDS_BASIS_HKJC = "HKD total return per $1 unit incl. stake" as const;

export const FIELD_MAP = {
  event_id: [["event_id"]],
  seq: [["seq"]],
  captured_at: [["captured_at"]],
  sent_at: [["sent_at"]],
  source_name: [["source", "name"]],
  source_last_updated_at: [["source", "last_updated_at"]],
  source_url: [["source", "url"]],
  quality_missing_source_time: [["quality", "missing_source_time"]],
  quality_post_start: [["quality", "post_start"]],
  quality_late_ms: [["quality", "late_ms"]],
  changes: [["changes"]],
  pools: [["pools"]],
  last_change_seq: [["last_change_seq"]],
  last_change_at: [["last_change_at"]],
} as const satisfies Record<string, readonly Path[]>;

/**
 * Keys inside each odds_delta changes[] entry.
 * Schema names first; older aliases kept as fallbacks for desensitized / transitional fixtures.
 */
export const CHANGE_FIELDS = {
  race_no: ["race_no"],
  runner_no: ["runner_no", "horse_no"],
  name_zh: ["horse_name_ch", "name_zh", "name_ch", "horse_name_zh"],
  name_en: ["horse_name_en", "name_en", "horse_name"],
  bet_type: ["bet_type", "pool"],
  runner_id: ["runner_id"],
  horse_name: ["horse_name"],
  status: ["status"],
  pool: ["pool"],
  prev_odds: ["prev_odds"],
  new_odds: ["new_odds"],
  odds_basis: ["odds_basis"],
  source_last_updated_at: ["source_last_updated_at"],
  race_post_time: ["race_post_time"],
  pool_status: ["pool_status"],
} as const;

/** Keys inside each odds_delta pools[] entry (pool total turnover only). */
export const POOL_FIELDS = {
  race_no: ["race_no"],
  bet_type: ["bet_type"],
  investment: ["investment"],
} as const;

/** Event names introduced in 1.1. */
export const EVENTS_11 = { odds_delta: "odds_delta", no_update: "no_update" } as const;

export interface OddsChange {
  race_no: number;
  runner_no: number;
  name_zh: string | null;
  name_en: string | null;
  bet_type: "WIN" | "PLA";
  /** Stable runner identity (HKJC horse.code); null on pre-740b52d3 payloads. */
  runner_id: string | null;
  /** Raw upstream horse_name (also used as a name_en fallback). */
  horse_name: string | null;
  /** Declared | Standby (null when absent). */
  status: string | null;
  /** Raw upstream pool (WIN | PLA) when sent. */
  pool: string | null;
  prev_odds: number | null;
  new_odds: number | null;
  /** Upstream string; HKJC const is treated as total_return by validation. */
  odds_basis: string | null;
  source_last_updated_at: string | null;
  race_post_time: string | null;
  pool_status: string | null;
}

export interface PoolInvestment {
  race_no: number;
  bet_type: "WIN" | "PLA";
  investment: number | null;
}

export interface Push11Fields {
  event_id: string | null;
  seq: number | null;
  captured_at: string | null;
  sent_at: string | null;
  source_name: string | null;
  source_last_updated_at: string | null;
  source_url: string | null;
  quality: { missing_source_time: boolean | null; post_start: boolean | null; late_ms: number | null };
  changes: OddsChange[];
  /** Entries we could not map (kept so nothing is silently dropped). */
  rejected_changes: number;
  pools: PoolInvestment[] | null;
  last_change_seq: number | null;
  last_change_at: string | null;
}

function at(obj: unknown, path: Path): unknown {
  let cur: unknown = obj;
  for (const k of path) {
    if (!cur || typeof cur !== "object" || Array.isArray(cur)) return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}
function pick(obj: unknown, paths: readonly Path[]): unknown {
  for (const p of paths) {
    const v = at(obj, p);
    if (v !== undefined) return v;
  }
  return undefined;
}
function pickKey(obj: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const k of keys) if (obj[k] !== undefined) return obj[k];
  return undefined;
}
const str = (v: unknown) => (typeof v === "string" && v ? v : null);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null);
const bool = (v: unknown) => (typeof v === "boolean" ? v : null);
/** Like num, but preserves explicit null (schema allows null prev_odds / investment). */
const numOrNull = (v: unknown): number | null | undefined => {
  if (v === null) return null;
  if (v === undefined) return undefined;
  return num(v);
};

/** Canonicalise runner status: "Declared" | "Standby" (case-insensitive); other strings kept as-is. */
export function normStatus(v: unknown): string | null {
  const s = typeof v === "string" ? v.trim() : "";
  if (!s) return null;
  const l = s.toLowerCase();
  return l === "declared" ? "Declared" : l === "standby" ? "Standby" : s;
}
export const isStandby = (status: string | null | undefined) => (status ?? "").toLowerCase() === "standby";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isSchema11(schema: string): boolean {
  return /^hkjc-push\/1\.(1|[2-9]|\d{2,})$/.test(schema);
}

/** True when the basis means HKJC-style total return per $1 (incl. stake). */
export function isTotalReturnBasis(basis: string | null | undefined): boolean {
  return basis === "total_return" || basis === ODDS_BASIS_HKJC;
}

export function mapChange(raw: unknown): OddsChange | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const race_no = num(pickKey(o, CHANGE_FIELDS.race_no));
  const runner_no = num(pickKey(o, CHANGE_FIELDS.runner_no));
  const bt = String(pickKey(o, CHANGE_FIELDS.bet_type) ?? "").toUpperCase();
  const bet_type = bt === "WIN" ? "WIN" : bt === "PLA" || bt === "PLACE" ? "PLA" : null;
  if (race_no === null || runner_no === null || !bet_type) return null;
  const prev = numOrNull(pickKey(o, CHANGE_FIELDS.prev_odds));
  const next = numOrNull(pickKey(o, CHANGE_FIELDS.new_odds));
  return {
    race_no,
    runner_no,
    name_zh: str(pickKey(o, CHANGE_FIELDS.name_zh)),
    name_en: str(pickKey(o, CHANGE_FIELDS.name_en)),
    bet_type,
    runner_id: str(pickKey(o, CHANGE_FIELDS.runner_id)),
    horse_name: str(pickKey(o, CHANGE_FIELDS.horse_name)),
    status: normStatus(pickKey(o, CHANGE_FIELDS.status)),
    pool: str(pickKey(o, CHANGE_FIELDS.pool))?.toUpperCase() ?? null,
    prev_odds: prev === undefined ? null : prev,
    new_odds: next === undefined ? null : next,
    odds_basis: str(pickKey(o, CHANGE_FIELDS.odds_basis)),
    source_last_updated_at: str(pickKey(o, CHANGE_FIELDS.source_last_updated_at)),
    race_post_time: str(pickKey(o, CHANGE_FIELDS.race_post_time)),
    pool_status: str(pickKey(o, CHANGE_FIELDS.pool_status)),
  };
}

export function mapPool(raw: unknown): PoolInvestment | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const race_no = num(pickKey(o, POOL_FIELDS.race_no));
  const bt = String(pickKey(o, POOL_FIELDS.bet_type) ?? "").toUpperCase();
  const bet_type = bt === "WIN" ? "WIN" : bt === "PLA" ? "PLA" : null;
  if (race_no === null || !bet_type) return null;
  const inv = numOrNull(pickKey(o, POOL_FIELDS.investment));
  return { race_no, bet_type, investment: inv === undefined ? null : inv };
}

export function extract11(raw: Record<string, unknown>): Push11Fields {
  const eid = str(pick(raw, FIELD_MAP.event_id));
  const rawChanges = pick(raw, FIELD_MAP.changes);
  const list = Array.isArray(rawChanges) ? rawChanges : [];
  const changes = list.map(mapChange).filter((c): c is OddsChange => c !== null);
  const rawPools = pick(raw, FIELD_MAP.pools);
  const poolList = Array.isArray(rawPools) ? rawPools.map(mapPool).filter((p): p is PoolInvestment => p !== null) : null;
  const seq = num(pick(raw, FIELD_MAP.seq));
  // source.last_updated_at is explicitly nullable in the schema — preserve null.
  const sourceUpdated = pick(raw, FIELD_MAP.source_last_updated_at);
  return {
    event_id: eid && UUID_RE.test(eid) ? eid.toLowerCase() : eid,
    seq: seq !== null && Number.isInteger(seq) ? seq : null,
    captured_at: str(pick(raw, FIELD_MAP.captured_at)),
    sent_at: str(pick(raw, FIELD_MAP.sent_at)),
    source_name: str(pick(raw, FIELD_MAP.source_name)),
    source_last_updated_at: sourceUpdated === null ? null : str(sourceUpdated),
    source_url: str(pick(raw, FIELD_MAP.source_url)),
    quality: {
      missing_source_time: bool(pick(raw, FIELD_MAP.quality_missing_source_time)),
      post_start: bool(pick(raw, FIELD_MAP.quality_post_start)),
      late_ms: num(pick(raw, FIELD_MAP.quality_late_ms)),
    },
    changes,
    rejected_changes: list.length - changes.length,
    pools: poolList,
    last_change_seq: num(pick(raw, FIELD_MAP.last_change_seq)),
    last_change_at: str(pick(raw, FIELD_MAP.last_change_at)),
  };
}
