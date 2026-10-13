// Read-only MCP server over Streamable HTTP (stateless, JSON responses, no auth).
// Exposes analysis state only. Never returns secrets or raw webhook bodies.
import type { Env } from "./env";
import { healthBody } from "./http";
import { nowMs, toHkt } from "./env";
import { QUALITY_FLAGS, streamStatus } from "./quality";
import { loadOddsMovement, runnerKey } from "./oddsMovement";

const SUPPORTED_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const LATEST_VERSION = SUPPORTED_VERSIONS[0];
const SERVER_INFO = { name: "hkjc-agent-runner", version: "0.1.0" };
const MAX_BODY_BYTES = 64 * 1024;

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
interface RpcRequest { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> }

class ToolInputError extends Error {}

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

const TOOLS = [
  {
    name: "get_status",
    title: "Runner status",
    description: "Health of the HKJC agent runner: whether roles and the OpenAI model are configured, inbox counts by status, queue and model last success or error.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: READ_ONLY,
  },
  {
    name: "list_recent_events",
    title: "Recent pushed events",
    description: "Recent events pushed by hkjc-data-worker (metadata only, newest first): event type, meeting date, venue, races, snapshot time, processing status, last error.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 50, description: "Default 20." },
        event_type: { type: "string", description: "Filter, e.g. odds_update, lock, scratch, result, dividends, horse_update, injury_update, schedule." },
        meeting_date: { type: "string", description: "YYYY-MM-DD" },
      },
      additionalProperties: false,
    },
    annotations: READ_ONLY,
  },
  {
    name: "list_recent_runs",
    title: "Recent analysis runs",
    description: "Recent multi-role analysis runs, newest first, with workflow (odds_analysis, lock_analysis, scratch_impact, horse_health, post_race_review), phase, race, status and error.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 50, description: "Default 20." },
        status: { type: "string", enum: ["running", "done", "failed", "skipped"] },
        meeting_date: { type: "string", description: "YYYY-MM-DD" },
        workflow: { type: "string" },
      },
      additionalProperties: false,
    },
    annotations: READ_ONLY,
  },
  {
    name: "get_run",
    title: "One analysis run",
    description: "One analysis run: moderator conclusion, disagreements, and every role's output per round.",
    inputSchema: {
      type: "object",
      properties: { run_id: { type: "string" } },
      required: ["run_id"],
      additionalProperties: false,
    },
    annotations: READ_ONLY,
  },
  {
    name: "get_race_analysis",
    title: "Analysis for one race",
    description: "Current pre-race opinion for one race (locked or not) and the analysis runs that covered it.",
    inputSchema: {
      type: "object",
      properties: {
        meeting_date: { type: "string", description: "YYYY-MM-DD" },
        venue: { type: "string", description: "Venue code as pushed, e.g. ST or HV." },
        race_no: { type: "integer", minimum: 1, maximum: 20 },
      },
      required: ["meeting_date", "venue", "race_no"],
      additionalProperties: false,
    },
    annotations: READ_ONLY,
  },
  {
    name: "search",
    title: "Search analysis runs",
    description: "Search analysis runs by meeting date, venue, workflow or status text. Returns ids usable with fetch.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
      additionalProperties: false,
    },
    annotations: READ_ONLY,
  },
  {
    name: "fetch",
    title: "Fetch analysis run",
    description: "Fetch one analysis run by id (from search) as a full document.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    },
    annotations: READ_ONLY,
  },
  {
    name: "get_ledger",
    title: "Odds ledger replay",
    description: "Replays the append-only odds ledger for one meeting day: every WIN/PLA odds change per race and runner, in seq order (hkjc-push/1.1) then arrival order (1.0 snapshots). prev_odds is filled from the trajectory when the push did not carry it. Rows with post_race=true arrived after the race started and must not be used for pre-race analysis.",
    inputSchema: {
      type: "object",
      properties: {
        meeting_date: { type: "string", description: "YYYY-MM-DD" },
        race_no: { type: "integer", minimum: 1, maximum: 20 },
        runner_no: { type: "integer", minimum: 1, maximum: 30 },
        bet_type: { type: "string", enum: ["WIN", "PLA"] },
        since_seq: { type: "integer", minimum: 0, description: "Only rows with seq greater than this (1.1 events)." },
        exclude_post_race: { type: "boolean", description: "Drop rows received after the race started. Default false." },
        limit: { type: "integer", minimum: 1, maximum: 500, description: "Default 200." },
      },
      required: ["meeting_date"],
      additionalProperties: false,
    },
    annotations: READ_ONLY,
  },
  {
    name: "get_data_quality",
    title: "Data quality for a meeting day",
    description: "Data-quality report for one meeting day: last event time (HKT), last seq, open seq gaps, counts per quality flag (missing_source_time, gap, out_of_order, duplicate, future_timestamp, post_start, late), delay statistics, quarantined analysis fields, stream status (ok, stale, broken, no_data) and an overall data_quality_status.",
    inputSchema: {
      type: "object",
      properties: { meeting_date: { type: "string", description: "YYYY-MM-DD" } },
      required: ["meeting_date"],
      additionalProperties: false,
    },
    annotations: READ_ONLY,
  },
  {
    name: "get_odds_movement",
    title: "Odds movement / change density",
    description: "Odds change density computed from the append-only odds ledger, per race + horse + WIN/PLA and per HKT minute bucket: change count, each change's absolute and % move, implied probability (1/odds) change, cumulative drift from the first seen odds, and flags sudden_jump (odds up >= 15% in one change), sudden_drop (odds down >= 15%), prob_shift (implied probability moves >= 3 points) and burst (>= 8 changes in one minute; upstream samples every 3-5 s, max ~12-20/min). Series are keyed by runner_id (stable HKJC horse code; falls back to runner number for older data) and Standby runners are excluded. Use it to spot horses being pushed in or out.",
    inputSchema: {
      type: "object",
      properties: {
        race_date: { type: "string", description: "Meeting date YYYY-MM-DD" },
        race_no: { type: "integer", minimum: 1, maximum: 20 },
        horse: { type: "string", description: "runner_id (exact), runner number (e.g. \"7\") or part of the Chinese or English horse name." },
        bet_type: { type: "string", enum: ["WIN", "PLA"] },
        exclude_post_race: { type: "boolean", description: "Drop ledger rows received after the race started. Default true." },
        include_changes: { type: "boolean", description: "Include every individual change. Default true; set false for a compact summary." },
      },
      required: ["race_date"],
      additionalProperties: false,
    },
    annotations: READ_ONLY,
  },
];

const INSTRUCTIONS =
  "Read-only access to the HKJC agent runner. Pre-race opinions and post-race reviews are separate: post-race review only uses opinions locked before the race. Probabilities are 0..1. Treat source_grade (official, reported, model, unverified) as how much to trust each claim.";

function rpcResult(id: RpcRequest["id"], result: unknown) {
  return { jsonrpc: "2.0", id: id ?? null, result };
}
function rpcError(id: RpcRequest["id"], code: number, message: string) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

function jsonResponse(status: number, body: unknown, extra: Record<string, string> = {}): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(), ...extra },
  });
}

function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Accept, Mcp-Session-Id, Mcp-Protocol-Version, Authorization",
    "Access-Control-Expose-Headers": "Mcp-Session-Id",
  };
}

export async function handleMcp(request: Request, env: Env): Promise<Response> {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders() });
  if (request.method === "GET") {
    // No server-initiated stream; allowed by Streamable HTTP.
    return new Response(null, { status: 405, headers: { Allow: "POST, OPTIONS", ...corsHeaders() } });
  }
  if (request.method === "DELETE") return new Response(null, { status: 405, headers: corsHeaders() });
  if (request.method !== "POST") return jsonResponse(405, rpcError(null, -32600, "method not allowed"));

  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return jsonResponse(413, rpcError(null, -32600, "request too large"));
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return jsonResponse(400, rpcError(null, -32700, "parse error"));
  }

  const batch = Array.isArray(parsed);
  const messages = (batch ? parsed : [parsed]) as RpcRequest[];
  if (messages.length === 0 || messages.length > 20) return jsonResponse(400, rpcError(null, -32600, "invalid batch"));

  const out: unknown[] = [];
  for (const msg of messages) {
    const res = await handleOne(msg, env);
    if (res !== undefined) out.push(res);
  }
  if (out.length === 0) return new Response(null, { status: 202, headers: corsHeaders() });
  return jsonResponse(200, batch ? out : out[0]);
}

async function handleOne(msg: RpcRequest, env: Env): Promise<unknown | undefined> {
  if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    // Responses or junk from the client: nothing to answer.
    if (msg && typeof msg === "object" && ("result" in msg || "error" in msg)) return undefined;
    return rpcError((msg as RpcRequest)?.id ?? null, -32600, "invalid request");
  }
  const isNotification = msg.id === undefined;
  try {
    const result = await dispatch(msg.method, msg.params ?? {}, env);
    if (isNotification) return undefined;
    return rpcResult(msg.id, result);
  } catch (err) {
    if (isNotification) return undefined;
    if (err instanceof MethodNotFound) return rpcError(msg.id, -32601, `method not found: ${msg.method}`);
    if (err instanceof ToolInputError) return rpcError(msg.id, -32602, err.message);
    return rpcError(msg.id, -32603, "internal error");
  }
}

class MethodNotFound extends Error {}

async function dispatch(method: string, params: Record<string, unknown>, env: Env): Promise<unknown> {
  switch (method) {
    case "initialize": {
      const requested = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
      return {
        protocolVersion: SUPPORTED_VERSIONS.includes(requested) ? requested : LATEST_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      };
    }
    case "ping":
      return {};
    case "tools/list":
      return { tools: TOOLS };
    case "tools/call":
      return callTool(String(params.name ?? ""), (params.arguments as Record<string, unknown>) ?? {}, env);
    case "resources/list":
      return { resources: [] };
    case "prompts/list":
      return { prompts: [] };
    default:
      if (method.startsWith("notifications/")) return {};
      throw new MethodNotFound(method);
  }
}

async function callTool(name: string, args: Record<string, unknown>, env: Env): Promise<unknown> {
  if (!TOOLS.some((t) => t.name === name)) throw new ToolInputError(`unknown tool: ${name}`);
  try {
    const data = await runTool(name, args, env);
    return { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data, isError: false };
  } catch (err) {
    if (err instanceof ToolInputError) {
      return { content: [{ type: "text", text: err.message }], isError: true };
    }
    throw err;
  }
}

function limitArg(v: unknown): number {
  if (v === undefined) return 20;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 50) throw new ToolInputError("limit must be an integer between 1 and 50");
  return n;
}
function optString(v: unknown, name: string, max = 64): string | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v !== "string" || v.length > max) throw new ToolInputError(`${name} must be a string`);
  return v;
}
function reqString(v: unknown, name: string, max = 128): string {
  const s = optString(v, name, max);
  if (!s) throw new ToolInputError(`${name} is required`);
  return s;
}
function parseJson(v: unknown): Json {
  if (typeof v !== "string") return null;
  try { return JSON.parse(v) as Json; } catch { return null; }
}

const RUN_COLUMNS = `id, inbox_id, workflow, phase, meeting_date, venue, race_nos, status, rounds, error, started_at, finished_at`;

async function runTool(name: string, args: Record<string, unknown>, env: Env): Promise<Record<string, Json>> {
  const db = env.DB;
  switch (name) {
    case "get_status":
      return (await healthBody(env)) as Record<string, Json>;

    case "list_recent_events": {
      const limit = limitArg(args.limit);
      const where: string[] = [];
      const binds: unknown[] = [];
      const et = optString(args.event_type, "event_type");
      const md = optString(args.meeting_date, "meeting_date", 10);
      if (et) { where.push("event_type = ?"); binds.push(et); }
      if (md) { where.push("meeting_date = ?"); binds.push(md); }
      const rows = await db.prepare(
        `SELECT id, event_type, schema_version, meeting_date, venue, race_nos, snapshot_time, received_at, received_at_hkt, event_id, seq,
           delay_received_sent_ms, delay_received_captured_ms, delay_captured_source_ms, quality_flags, post_race,
           status, workflow, attempts, last_error, duplicate_count, run_id
         FROM inbox_events ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY received_at DESC LIMIT ?`,
      ).bind(...binds, limit).all<Record<string, unknown>>();
      return { events: (rows.results ?? []).map((r) => ({ ...r, race_nos: parseJson(r.race_nos), quality_flags: parseJson(r.quality_flags), post_race: r.post_race === 1 })) as Json[] };
    }

    case "list_recent_runs": {
      const limit = limitArg(args.limit);
      const where: string[] = [];
      const binds: unknown[] = [];
      const st = optString(args.status, "status");
      const md = optString(args.meeting_date, "meeting_date", 10);
      const wf = optString(args.workflow, "workflow");
      if (st) { where.push("status = ?"); binds.push(st); }
      if (md) { where.push("meeting_date = ?"); binds.push(md); }
      if (wf) { where.push("workflow = ?"); binds.push(wf); }
      const rows = await db.prepare(
        `SELECT ${RUN_COLUMNS} FROM analysis_runs ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY started_at DESC LIMIT ?`,
      ).bind(...binds, limit).all<Record<string, unknown>>();
      return { runs: (rows.results ?? []).map((r) => ({ ...r, race_nos: parseJson(r.race_nos) })) as Json[] };
    }

    case "get_run":
      return getRun(db, reqString(args.run_id, "run_id"));

    case "fetch": {
      const id = reqString(args.id, "id");
      const run = await getRun(db, id);
      const r = run.run as Record<string, Json>;
      return {
        id,
        title: `${r.workflow} ${r.meeting_date ?? ""} ${r.venue ?? ""} ${JSON.stringify(r.race_nos ?? [])}`.trim(),
        text: JSON.stringify(run),
        url: `https://hkjc-agent.cf-connect.top/runs/${encodeURIComponent(id)}`,
        metadata: { workflow: r.workflow, status: r.status, phase: r.phase },
      };
    }

    case "search": {
      const q = reqString(args.query, "query", 200).trim();
      const like = `%${q.replace(/[%_]/g, "")}%`;
      const rows = await db.prepare(
        `SELECT ${RUN_COLUMNS} FROM analysis_runs
         WHERE meeting_date LIKE ? OR venue LIKE ? OR workflow LIKE ? OR status LIKE ? OR race_nos LIKE ? OR id = ?
         ORDER BY started_at DESC LIMIT 20`,
      ).bind(like, like, like, like, like, q).all<Record<string, unknown>>();
      return {
        results: (rows.results ?? []).map((r) => ({
          id: String(r.id),
          title: `${r.workflow} ${r.meeting_date ?? ""} ${r.venue ?? ""} races ${r.race_nos ?? "[]"} (${r.status})`,
          url: `https://hkjc-agent.cf-connect.top/runs/${encodeURIComponent(String(r.id))}`,
        })),
      };
    }

    case "get_race_analysis": {
      const md = reqString(args.meeting_date, "meeting_date", 10);
      const venue = reqString(args.venue, "venue", 8);
      const raceNo = Number(args.race_no);
      if (!Number.isInteger(raceNo) || raceNo < 1 || raceNo > 20) throw new ToolInputError("race_no must be an integer between 1 and 20");
      const op = await db.prepare(
        `SELECT run_id, snapshot_time, locked, locked_at, opinion_json FROM race_opinions WHERE meeting_date = ? AND venue = ? AND race_no = ?`,
      ).bind(md, venue, raceNo).first<Record<string, unknown>>();
      const runs = await db.prepare(
        `SELECT ${RUN_COLUMNS}, conclusion_json FROM analysis_runs
         WHERE meeting_date = ? AND venue = ? AND EXISTS (SELECT 1 FROM json_each(analysis_runs.race_nos) WHERE CAST(value AS INTEGER) = ?)
         ORDER BY started_at DESC LIMIT 20`,
      ).bind(md, venue, raceNo).all<Record<string, unknown>>();
      return {
        meeting_date: md,
        venue,
        race_no: raceNo,
        opinion: op
          ? { run_id: op.run_id as Json, snapshot_time: op.snapshot_time as Json, locked: op.locked === 1, locked_at: op.locked_at as Json, opinion: parseJson(op.opinion_json) }
          : null,
        runs: (runs.results ?? []).map(({ conclusion_json, ...r }) => ({ ...r, race_nos: parseJson(r.race_nos), conclusion: parseJson(conclusion_json) })) as Json[],
      };
    }

    case "get_ledger":
      return getLedger(db, args);

    case "get_odds_movement": {
      const md = dateArg(args.race_date, "race_date");
      const bt = optString(args.bet_type, "bet_type", 3);
      if (bt && bt !== "WIN" && bt !== "PLA") throw new ToolInputError("bet_type must be WIN or PLA");
      return (await loadOddsMovement(db, {
        meeting_date: md,
        race_no: optInt(args.race_no, "race_no", 1, 20),
        horse: optString(args.horse, "horse", 64),
        bet_type: bt,
        exclude_post_race: args.exclude_post_race !== false,
        include_changes: args.include_changes !== false,
      })) as unknown as Record<string, Json>;
    }

    case "get_data_quality":
      return getDataQuality(db, dateArg(args.meeting_date));
  }
  throw new ToolInputError(`unknown tool: ${name}`);
}

function dateArg(v: unknown, name = "meeting_date"): string {
  const s = reqString(v, name, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new ToolInputError(`${name} must be YYYY-MM-DD`);
  return s;
}
function optInt(v: unknown, name: string, min: number, max: number): number | undefined {
  if (v === undefined || v === null) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new ToolInputError(`${name} must be an integer between ${min} and ${max}`);
  return n;
}

const LEDGER_SCAN_CAP = 5000;

async function getLedger(db: D1Database, args: Record<string, unknown>): Promise<Record<string, Json>> {
  const md = dateArg(args.meeting_date);
  const raceNo = optInt(args.race_no, "race_no", 1, 20);
  const runnerNo = optInt(args.runner_no, "runner_no", 1, 30);
  const sinceSeq = optInt(args.since_seq, "since_seq", 0, Number.MAX_SAFE_INTEGER);
  const limit = optInt(args.limit, "limit", 1, 500) ?? 200;
  const bt = optString(args.bet_type, "bet_type", 3);
  if (bt && bt !== "WIN" && bt !== "PLA") throw new ToolInputError("bet_type must be WIN or PLA");
  const excludePost = args.exclude_post_race === true;
  const where = ["meeting_date = ?"];
  const binds: unknown[] = [md];
  if (raceNo !== undefined) { where.push("race_no = ?"); binds.push(raceNo); }
  if (runnerNo !== undefined) { where.push("runner_no = ?"); binds.push(runnerNo); }
  if (bt) { where.push("bet_type = ?"); binds.push(bt); }
  // since_seq is applied after replay so prev_odds can still be derived from earlier rows.
  const rows = await db.prepare(
    `SELECT id, event_id, seq, schema_version, venue, race_no, runner_no, runner_id, horse_name, status, pool, name_zh, name_en, bet_type, prev_odds, new_odds, odds_basis,
            captured_at, received_at_hkt, post_race, quality_flags
     FROM odds_ledger WHERE ${where.join(" AND ")} ORDER BY seq IS NULL, seq, id LIMIT ?`,
  ).bind(...binds, LEDGER_SCAN_CAP + 1).all<Record<string, unknown>>();
  const all = rows.results ?? [];
  const truncated = all.length > LEDGER_SCAN_CAP;
  const last = new Map<string, number | null>();
  const replay: Record<string, Json>[] = [];
  for (const r of all.slice(0, LEDGER_SCAN_CAP)) {
    const k = `${r.race_no}|${runnerKey(r as { runner_id: string | null; runner_no: number })}|${r.bet_type}`;
    const prev = (r.prev_odds as number | null) ?? last.get(k) ?? null;
    if (!(excludePost && r.post_race === 1)) last.set(k, r.new_odds as number | null);
    replay.push({ ...(r as Record<string, Json>), prev_odds: prev, post_race: r.post_race === 1, quality_flags: parseJson(r.quality_flags) });
  }
  const filtered = replay.filter((r) => (!excludePost || r.post_race === false) && (sinceSeq === undefined || (typeof r.seq === "number" && r.seq > sinceSeq)));
  return {
    meeting_date: md,
    count: Math.min(filtered.length, limit),
    has_more: filtered.length > limit,
    scan_truncated: truncated,
    entries: filtered.slice(0, limit) as Json[],
  };
}

async function getDataQuality(db: D1Database, md: string): Promise<Record<string, Json>> {
  const st = await db.prepare(`SELECT * FROM stream_state WHERE meeting_date = ?`).bind(md).first<Record<string, unknown>>();
  const sched = await db.prepare(`SELECT race_no, post_time FROM race_schedule WHERE meeting_date = ? ORDER BY race_no`).bind(md)
    .all<{ race_no: number; post_time: string }>();
  const postTimes = (sched.results ?? []).map((r) => r.post_time);
  const lastEvent = (st?.last_event_received_at as string | null) ?? null;
  const lastHb = (st?.last_heartbeat_at as string | null) ?? null;
  const lastSeen = [lastEvent, lastHb].filter((x): x is string => !!x).sort().pop() ?? null;
  const now = nowMs();
  const stream = streamStatus(now, lastSeen, postTimes);

  const flagRows = await db.prepare(
    `SELECT j.value AS flag, COUNT(*) AS n FROM inbox_events, json_each(COALESCE(inbox_events.quality_flags, '[]')) AS j
     WHERE inbox_events.meeting_date = ? GROUP BY j.value`,
  ).bind(md).all<{ flag: string; n: number }>();
  const flag_counts: Record<string, number> = Object.fromEntries(QUALITY_FLAGS.map((f) => [f, 0]));
  for (const r of flagRows.results ?? []) flag_counts[r.flag] = r.n;

  const seqs = await db.prepare(`SELECT DISTINCT seq FROM inbox_events WHERE meeting_date = ? AND seq IS NOT NULL ORDER BY seq`).bind(md)
    .all<{ seq: number }>();
  const open_gaps: Json[] = [];
  const list = (seqs.results ?? []).map((r) => r.seq);
  for (let i = 1; i < list.length; i++) {
    if (list[i] > list[i - 1] + 1) open_gaps.push({ from_seq: list[i - 1] + 1, to_seq: list[i] - 1 });
  }
  const detected = await db.prepare(`SELECT COUNT(*) AS n FROM seq_gaps WHERE meeting_date = ?`).bind(md).first<{ n: number }>();

  const delays = await db.prepare(
    `SELECT COUNT(*) AS events,
       AVG(delay_received_sent_ms) AS avg_received_sent_ms, MAX(delay_received_sent_ms) AS max_received_sent_ms,
       AVG(delay_received_captured_ms) AS avg_received_captured_ms, MAX(delay_received_captured_ms) AS max_received_captured_ms,
       AVG(delay_captured_source_ms) AS avg_captured_source_ms, MAX(delay_captured_source_ms) AS max_captured_source_ms,
       SUM(post_race) AS post_race_events
     FROM inbox_events WHERE meeting_date = ?`,
  ).bind(md).first<Record<string, number | null>>();
  const quarantine = await db.prepare(
    `SELECT COUNT(*) AS n FROM analysis_validation v JOIN analysis_runs r ON r.id = v.run_id
     WHERE r.meeting_date = ? AND v.status = 'quarantined'`,
  ).bind(md).first<{ n: number }>();

  const serious = flag_counts.gap + flag_counts.out_of_order + flag_counts.future_timestamp + flag_counts.late;
  const data_quality_status =
    stream.status === "no_data" ? "no_data"
      : stream.status === "broken" || open_gaps.length > 0 ? "bad"
      : stream.status === "stale" || serious > 0 ? "degraded"
      : "ok";
  const round = (v: number | null | undefined) => (v === null || v === undefined ? null : Math.round(v));
  return {
    meeting_date: md,
    now_hkt: toHkt(now),
    last_event_received_at: lastEvent,
    last_event_hkt: (st?.last_event_hkt as string | null) ?? null,
    last_heartbeat_at: lastHb,
    last_seq: (st?.last_seq as number | null) ?? null,
    last_change_seq: (st?.last_change_seq as number | null) ?? null,
    stream_status: stream.status,
    fast_window: stream.fast_window,
    expected_interval_ms: stream.expected_interval_ms,
    silence_ms: stream.silence_ms,
    open_gaps,
    gaps_detected: detected?.n ?? 0,
    flag_counts,
    delays: {
      events: delays?.events ?? 0,
      avg_received_sent_ms: round(delays?.avg_received_sent_ms), max_received_sent_ms: delays?.max_received_sent_ms ?? null,
      avg_received_captured_ms: round(delays?.avg_received_captured_ms), max_received_captured_ms: delays?.max_received_captured_ms ?? null,
      avg_captured_source_ms: round(delays?.avg_captured_source_ms), max_captured_source_ms: delays?.max_captured_source_ms ?? null,
    },
    post_race_events: delays?.post_race_events ?? 0,
    quarantined_fields: quarantine?.n ?? 0,
    data_quality_status,
  };
}

async function getRun(db: D1Database, runId: string): Promise<Record<string, Json>> {
  const run = await db.prepare(`SELECT ${RUN_COLUMNS}, conclusion_json, disagreements_json FROM analysis_runs WHERE id = ?`)
    .bind(runId).first<Record<string, unknown>>();
  if (!run) throw new ToolInputError(`run not found: ${runId}`);
  const steps = await db.prepare(
    `SELECT round, role_id, kind, status, output_json, error, created_at FROM run_steps WHERE run_id = ? ORDER BY round, role_id`,
  ).bind(runId).all<Record<string, unknown>>();
  const { conclusion_json, disagreements_json, ...rest } = run;
  const validation = await db.prepare(
    `SELECT role_id, race_no, runner_no, bet_type, p, odds, odds_basis, fair_odds, ev, status, reason FROM analysis_validation WHERE run_id = ? ORDER BY id`,
  ).bind(runId).all<Record<string, Json>>();
  return {
    validation: (validation.results ?? []) as Json[],
    run: { ...rest, race_nos: parseJson(rest.race_nos), conclusion: parseJson(conclusion_json), disagreements: parseJson(disagreements_json) } as Json,
    steps: (steps.results ?? []).map(({ output_json, ...s }) => ({ ...s, output: parseJson(output_json) })) as Json[],
  };
}
