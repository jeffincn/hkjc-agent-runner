/**
 * hkjc-push/1.1 field mapping. THIS IS THE ONLY PLACE that knows 1.1 field names.
 *
 * The authoritative schema will live in jeffincn/hkjc-worker docs/push-schema-1.1.md
 * (not published yet when this was written). Each logical field lists the JSON paths
 * we accept, first match wins. When upstream finalises names, edit FIELD_MAP / CHANGE_FIELDS
 * only; nothing else in the runner reads 1.1 keys directly.
 */

type Path = readonly string[];

export const FIELD_MAP = {
  event_id: [["event_id"]],
  seq: [["seq"]],
  captured_at: [["captured_at"]],
  sent_at: [["sent_at"]],
  source_last_updated_at: [["source", "last_updated_at"]],
  source_url: [["source", "url"]],
  quality_missing_source_time: [["quality", "missing_source_time"]],
  quality_post_start: [["quality", "post_start"]],
  quality_late_ms: [["quality", "late_ms"]],
  changes: [["changes"]],
  pools: [["pools"]],
  last_change_seq: [["last_change_seq"]],
} as const satisfies Record<string, readonly Path[]>;

/** Keys inside each odds_delta changes[] entry. Alternatives are tried in order. */
export const CHANGE_FIELDS = {
  race_no: ["race_no"],
  runner_no: ["runner_no", "horse_no"],
  name_zh: ["name_zh", "name_ch", "horse_name_ch", "horse_name_zh"],
  name_en: ["name_en", "horse_name_en", "horse_name"],
  bet_type: ["bet_type"],
  prev_odds: ["prev_odds"],
  new_odds: ["new_odds"],
  odds_basis: ["odds_basis"],
} as const;

/** Event names introduced in 1.1. */
export const EVENTS_11 = { odds_delta: "odds_delta", no_update: "no_update" } as const;

export interface OddsChange {
  race_no: number;
  runner_no: number;
  name_zh: string | null;
  name_en: string | null;
  bet_type: "WIN" | "PLA";
  prev_odds: number | null;
  new_odds: number | null;
  odds_basis: string | null;
}

export interface Push11Fields {
  event_id: string | null;
  seq: number | null;
  captured_at: string | null;
  sent_at: string | null;
  source_last_updated_at: string | null;
  source_url: string | null;
  quality: { missing_source_time: boolean | null; post_start: boolean | null; late_ms: number | null };
  changes: OddsChange[];
  /** Entries we could not map (kept so nothing is silently dropped). */
  rejected_changes: number;
  pools: unknown[] | null;
  last_change_seq: number | null;
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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isSchema11(schema: string): boolean {
  return /^hkjc-push\/1\.(1|[2-9]|\d{2,})$/.test(schema);
}

export function mapChange(raw: unknown): OddsChange | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const race_no = num(pickKey(o, CHANGE_FIELDS.race_no));
  const runner_no = num(pickKey(o, CHANGE_FIELDS.runner_no));
  const bt = String(pickKey(o, CHANGE_FIELDS.bet_type) ?? "").toUpperCase();
  const bet_type = bt === "WIN" ? "WIN" : bt === "PLA" || bt === "PLACE" ? "PLA" : null;
  if (race_no === null || runner_no === null || !bet_type) return null;
  return {
    race_no,
    runner_no,
    name_zh: str(pickKey(o, CHANGE_FIELDS.name_zh)),
    name_en: str(pickKey(o, CHANGE_FIELDS.name_en)),
    bet_type,
    prev_odds: num(pickKey(o, CHANGE_FIELDS.prev_odds)),
    new_odds: num(pickKey(o, CHANGE_FIELDS.new_odds)),
    odds_basis: str(pickKey(o, CHANGE_FIELDS.odds_basis)),
  };
}

export function extract11(raw: Record<string, unknown>): Push11Fields {
  const eid = str(pick(raw, FIELD_MAP.event_id));
  const rawChanges = pick(raw, FIELD_MAP.changes);
  const list = Array.isArray(rawChanges) ? rawChanges : [];
  const changes = list.map(mapChange).filter((c): c is OddsChange => c !== null);
  const pools = pick(raw, FIELD_MAP.pools);
  const seq = num(pick(raw, FIELD_MAP.seq));
  return {
    event_id: eid && UUID_RE.test(eid) ? eid.toLowerCase() : eid,
    seq: seq !== null && Number.isInteger(seq) ? seq : null,
    captured_at: str(pick(raw, FIELD_MAP.captured_at)),
    sent_at: str(pick(raw, FIELD_MAP.sent_at)),
    source_last_updated_at: str(pick(raw, FIELD_MAP.source_last_updated_at)),
    source_url: str(pick(raw, FIELD_MAP.source_url)),
    quality: {
      missing_source_time: bool(pick(raw, FIELD_MAP.quality_missing_source_time)),
      post_start: bool(pick(raw, FIELD_MAP.quality_post_start)),
      late_ms: num(pick(raw, FIELD_MAP.quality_late_ms)),
    },
    changes,
    rejected_changes: list.length - changes.length,
    pools: Array.isArray(pools) ? pools : null,
    last_change_seq: num(pick(raw, FIELD_MAP.last_change_seq)),
  };
}
