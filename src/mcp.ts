// Read-only MCP server over Streamable HTTP (stateless, JSON responses, no auth).
// Exposes analysis state only. Never returns secrets or raw webhook bodies.
import type { Env } from "./env";
import { healthBody } from "./http";

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
        `SELECT id, event_type, meeting_date, venue, race_nos, snapshot_time, received_at, status, workflow, attempts, last_error, duplicate_count, run_id
         FROM inbox_events ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY received_at DESC LIMIT ?`,
      ).bind(...binds, limit).all<Record<string, unknown>>();
      return { events: (rows.results ?? []).map((r) => ({ ...r, race_nos: parseJson(r.race_nos) })) as Json[] };
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
  }
  throw new ToolInputError(`unknown tool: ${name}`);
}

async function getRun(db: D1Database, runId: string): Promise<Record<string, Json>> {
  const run = await db.prepare(`SELECT ${RUN_COLUMNS}, conclusion_json, disagreements_json FROM analysis_runs WHERE id = ?`)
    .bind(runId).first<Record<string, unknown>>();
  if (!run) throw new ToolInputError(`run not found: ${runId}`);
  const steps = await db.prepare(
    `SELECT round, role_id, kind, status, output_json, error, created_at FROM run_steps WHERE run_id = ? ORDER BY round, role_id`,
  ).bind(runId).all<Record<string, unknown>>();
  const { conclusion_json, disagreements_json, ...rest } = run;
  return {
    run: { ...rest, race_nos: parseJson(rest.race_nos), conclusion: parseJson(conclusion_json), disagreements: parseJson(disagreements_json) } as Json,
    steps: (steps.results ?? []).map(({ output_json, ...s }) => ({ ...s, output: parseJson(output_json) })) as Json[],
  };
}
