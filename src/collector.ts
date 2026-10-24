import type { Env } from "./env";
import { envInt, nowMs } from "./env";
import { sha256Hex } from "./crypto";
import { parseEnvelope } from "./envelope";

const SOURCE = "https://hkjc.cf-connect.top";
/** limit=500 pages are 15–20MB and blow the response cap; keep pages small. */
const PAGE_SIZE = 20;
const LEASE_MS = 15 * 60_000;
// Leave headroom below D1's 2,000,000-byte value/row limit.
const MAX_BYTES = 1_500_000;
type Meeting = { meeting_date: string; venue: "ST" | "HV" };
type EventRow = Meeting & { event_id: string; seq: number };

/** Coarse failure reasons only — never bodies, headers, or tokens. */
export type CollectionFailReason =
  | `${number}`
  | "size"
  | "timeout"
  | "redirect"
  | "network"
  | "json";

export type CollectionFetchPath = "binding" | "fallback";

/** Payload stored in runner_meta last_collection_error (no secrets). */
export type CollectionErrorRecord = {
  reason: CollectionFailReason;
  at: string;
  /** Whether the failing request used the service binding or public-URL fetch. */
  path: CollectionFetchPath;
  /** Present when reason is redirect (3xx status, never followed). */
  status?: number;
  /** scheme+host+pathname only; null when absent or unparsable. */
  location?: string | null;
};

/**
 * Reduce a Location header to scheme+host+pathname.
 * Strips query, fragment, and userinfo; rejects non-http(s); never returns raw input on parse failure.
 */
export function safeRedirectLocation(raw: string | null | undefined, base = SOURCE): string | null {
  if (raw == null || raw === "") return null;
  try {
    const u = new URL(raw, base);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return null;
  }
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("collector: invalid response");
  return value as Record<string, unknown>;
}
function validDate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}
function meeting(value: unknown): Meeting {
  const row = object(value);
  if (!validDate(row.meeting_date) || (row.venue !== "ST" && row.venue !== "HV")) {
    throw new Error("collector: invalid meeting");
  }
  return { meeting_date: row.meeting_date, venue: row.venue };
}
function day(offset: number): string {
  return new Date(nowMs() + 8 * 3600_000 + offset * 86400_000).toISOString().slice(0, 10);
}

function collectionFetchPath(env: Env): CollectionFetchPath {
  return env.HKJC_WORKER ? "binding" : "fallback";
}

function sourceFetch(env: Env, fetchImpl: typeof fetch): typeof fetch {
  const bound = env.HKJC_WORKER;
  if (bound) {
    return ((input: RequestInfo | URL, init?: RequestInit) => bound.fetch(input, init)) as typeof fetch;
  }
  return fetchImpl;
}

type RedirectFail = Error & { redirectStatus: number; redirectLocation: string | null };

function redirectFail(status: number, locationHeader: string | null): RedirectFail {
  const err = new Error("redirect") as RedirectFail;
  err.redirectStatus = status;
  err.redirectLocation = safeRedirectLocation(locationHeader);
  return err;
}

/** Map thrown values to a coarse reason; never include response text or tokens. */
export function classifySourceFailure(err: unknown): CollectionFailReason {
  if (err && typeof err === "object") {
    const name = "name" in err ? String((err as { name: unknown }).name) : "";
    if (name === "TimeoutError" || name === "AbortError") return "timeout";
  }
  if (err instanceof SyntaxError) return "json";
  if (err instanceof Error) {
    const msg = err.message;
    if (/^\d{3}$/.test(msg)) return msg as CollectionFailReason;
    if (msg === "size") return "size";
    if (msg === "timeout") return "timeout";
    if (msg === "redirect" || /redirect/i.test(msg)) return "redirect";
    if (msg === "json" || msg === "collector: invalid response" || /JSON/i.test(msg)) return "json";
    if (/aborted|timeout/i.test(msg)) return "timeout";
  }
  return "network";
}

async function recordCollectionError(env: Env, record: CollectionErrorRecord): Promise<void> {
  // Never bodies, full headers, query strings, or tokens — only coarse diagnostics.
  const value: CollectionErrorRecord = {
    reason: record.reason,
    at: record.at,
    path: record.path,
  };
  if (record.reason === "redirect") {
    value.status = record.status;
    value.location = record.location ?? null;
  }
  await env.DB.prepare(
    `INSERT INTO runner_meta (key,value,updated_at) VALUES ('last_collection_error',?,?)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`,
  ).bind(JSON.stringify(value), record.at).run();
}

/** Archive only: never invokes webhook handling, agents, queues, or subscriber fan-out. */
export async function collectWorker(env: Env, fetchImpl: typeof fetch = fetch): Promise<{
  meetings: number; events: number; requests: number; skipped: boolean;
}> {
  const report = { meetings: 0, events: 0, requests: 0, skipped: false };
  if (env.HKJC_COLLECT_ENABLED !== "true") return { ...report, skipped: true };
  if (env.HKJC_API_BASE?.replace(/\/$/, "") !== SOURCE || !env.HKJC_API_TOKEN?.trim()) {
    throw new Error("collector: configure approved source and token");
  }
  const owner = crypto.randomUUID();
  const locked = await env.DB.prepare(
    `INSERT INTO collection_lock (id, owner, lease_until) VALUES (1, ?, ?)
     ON CONFLICT(id) DO UPDATE SET owner=excluded.owner, lease_until=excluded.lease_until
     WHERE collection_lock.lease_until <= ?`,
  ).bind(owner, nowMs() + LEASE_MS, nowMs()).run();
  if (!locked.meta.changes) return { ...report, skipped: true };
  const budget = envInt(env.HKJC_COLLECT_MAX_REQUESTS, 20, 1, 40);
  const from = day(-envInt(env.HKJC_COLLECT_LOOKBACK_DAYS, 2, 0, 60));
  const to = day(envInt(env.HKJC_COLLECT_LOOKAHEAD_DAYS, 7, 0, 30));
  const timestamp = () => new Date(nowMs()).toISOString();
  const fetchPath = collectionFetchPath(env);
  const doFetch = sourceFetch(env, fetchImpl);
  async function get(path: string, params: Record<string, string>): Promise<{ text: string; data: Record<string, unknown> }> {
    const url = new URL(path, SOURCE);
    url.search = new URLSearchParams(params).toString();
    report.requests++;
    let response: Response;
    try {
      // redirect:"manual" — never follow; inspect 3xx status + Location for diagnostics.
      response = await doFetch(url.toString(), {
        headers: { Authorization: `Bearer ${env.HKJC_API_TOKEN}`, "User-Agent": "hkjc-agent-runner/collector", Accept: "application/json" },
        redirect: "manual",
        signal: AbortSignal.timeout(10_000),
      });
      if (response.status >= 300 && response.status < 400) {
        throw redirectFail(response.status, response.headers.get("Location"));
      }
      if (!response.ok) throw new Error(String(response.status));
      // Bound both declared and streamed bodies; never log error bodies or headers.
      if (Number(response.headers.get("Content-Length")) > MAX_BYTES) throw new Error("size");
      const reader = response.body?.getReader();
      if (!reader) throw new Error("body");
      const chunks: Uint8Array[] = [];
      let size = 0;
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > MAX_BYTES) { await reader.cancel(); throw new Error("size"); }
        chunks.push(chunk.value);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      const text = new TextDecoder().decode(bytes);
      let data: Record<string, unknown>;
      try {
        data = object(JSON.parse(text));
      } catch {
        throw new Error("json");
      }
      return { text, data };
    } catch (err) {
      const reason = classifySourceFailure(err);
      const at = timestamp();
      const record: CollectionErrorRecord = { reason, at, path: fetchPath };
      if (reason === "redirect") {
        const redir = err as Partial<RedirectFail>;
        if (typeof redir.redirectStatus === "number") record.status = redir.redirectStatus;
        if ("redirectLocation" in (err as object)) record.location = redir.redirectLocation ?? null;
        else record.location = null;
      }
      try {
        await recordCollectionError(env, record);
      } catch {
        // Meta write must not hide the original source failure.
      }
      throw new Error(`collector: source request failed (${reason})`);
    }
  }
  async function archive(kind: string, date: string, venue: string, text: string): Promise<void> {
    const hash = await sha256Hex(new TextEncoder().encode(text));
    await env.DB.prepare(
      `INSERT OR IGNORE INTO collection_documents (kind, meeting_date, venue, content_hash, raw_body, collected_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(kind, date, venue, hash, text, timestamp()).run();
  }
  try {
    const listing = await get("/v1/meetings", { from, to });
    if (!Array.isArray(listing.data.meetings)) throw new Error("collector: invalid meetings response");
    const meetings = listing.data.meetings.map(meeting);
    if (meetings.some((m) => m.meeting_date < from || m.meeting_date > to)) throw new Error("collector: meeting outside requested range");
    await archive("meetings", from, to, listing.text);
    for (const m of meetings) {
      if (report.requests >= budget) break;
      let cursor = (await env.DB.prepare(
        `SELECT last_seq FROM collection_cursors WHERE meeting_date=? AND venue=?`,
      ).bind(m.meeting_date, m.venue).first<{ last_seq: number }>())?.last_seq ?? 0;
      while (report.requests < budget) {
        const page = await get("/v1/events", {
          meeting_date: m.meeting_date, venue: m.venue, since_seq: String(cursor), limit: String(PAGE_SIZE),
        });
        if (!Array.isArray(page.data.events) || page.data.events.length > PAGE_SIZE) throw new Error("collector: invalid events response");
        const events: { row: EventRow; text: string }[] = [];
        const ids = new Set<string>();
        let next = cursor;
        // Validate the ENTIRE page before writing anything or advancing the cursor.
        for (const value of page.data.events) {
          const row = object(value);
          const text = JSON.stringify(value);
          if (row.schema !== "hkjc-push/1.1" || typeof row.event_id !== "string" || !row.event_id.trim() ||
              !Number.isSafeInteger(row.seq) || (row.seq as number) <= next || ids.has(row.event_id) ||
              row.meeting_date !== m.meeting_date || row.venue !== m.venue || !parseEnvelope(text).ok) {
            throw new Error("collector: invalid event page");
          }
          ids.add(row.event_id);
          next = row.seq as number;
          events.push({ row: row as unknown as EventRow, text });
        }
        // Upcoming worker may byte-truncate pages and return next_since_seq; absent today → length paging.
        const truncatedByBytes = page.data.truncated_by_bytes === true;
        const nextSinceSeq = page.data.next_since_seq;
        if (truncatedByBytes) {
          if (!Number.isSafeInteger(nextSinceSeq) || (nextSinceSeq as number) < next ||
              (events.length === 0 && (nextSinceSeq as number) <= cursor)) {
            throw new Error("collector: invalid events response");
          }
          next = nextSinceSeq as number;
        }
        if (events.length || (truncatedByBytes && next > cursor)) {
          // One JSON insert per page keeps D1 query/subrequest use bounded.
          // The immutable trigger rejects identity conflicts atomically with the cursor.
          const chunks: string[] = [];
          let group: typeof events = [];
          let groupBytes = 2;
          for (const event of events) {
            const bytes = new TextEncoder().encode(JSON.stringify(event)).byteLength + 1;
            if (bytes + 2 > MAX_BYTES) throw new Error("collector: event exceeds storage limit");
            if (groupBytes + bytes > MAX_BYTES) {
              chunks.push(JSON.stringify(group));
              group = []; groupBytes = 2;
            }
            group.push(event); groupBytes += bytes;
          }
          if (group.length) chunks.push(JSON.stringify(group));
          const statements = chunks.map((chunk) => env.DB.prepare(
            `INSERT INTO collection_events (event_id,meeting_date,venue,seq,raw_body,collected_at)
             SELECT json_extract(value,'$.row.event_id'),json_extract(value,'$.row.meeting_date'),
               json_extract(value,'$.row.venue'),json_extract(value,'$.row.seq'),json_extract(value,'$.text'),?
             FROM json_each(?) WHERE true
             ON CONFLICT(event_id) DO UPDATE SET meeting_date=excluded.meeting_date,venue=excluded.venue,
               seq=excluded.seq,raw_body=excluded.raw_body`,
          ).bind(timestamp(), chunk));
          statements.push(env.DB.prepare(
            `INSERT INTO collection_cursors (meeting_date, venue, last_seq, updated_at) VALUES (?, ?, ?, ?)
             ON CONFLICT(meeting_date, venue) DO UPDATE SET last_seq=MAX(collection_cursors.last_seq,excluded.last_seq), updated_at=excluded.updated_at`,
          ).bind(m.meeting_date, m.venue, next, timestamp()));
          await env.DB.batch(statements);
          cursor = next;
          report.events += events.length;
        }
        // Byte-truncated pages may be shorter than limit but still have more data.
        if (truncatedByBytes) continue;
        if (events.length < PAGE_SIZE) break;
      }
      report.meetings++;
      for (const kind of ["races", "results"]) {
        if (report.requests >= budget) break;
        const document = await get(`/v1/${kind}`, { date: m.meeting_date, venue: m.venue });
        if (!Array.isArray(document.data[kind])) throw new Error("collector: invalid document response");
        await archive(kind, m.meeting_date, m.venue, document.text);
      }
    }
    await env.DB.prepare(`INSERT INTO runner_meta (key,value,updated_at) VALUES ('last_collection_ok',?,?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`)
      .bind(JSON.stringify(report), timestamp()).run();
    return report;
  } finally {
    await env.DB.prepare(`DELETE FROM collection_lock WHERE id=1 AND owner=?`).bind(owner).run();
  }
}
