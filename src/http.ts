import type { Env } from "./env";
import { getMetaMap } from "./store";
import { allRoles } from "./roles";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function bearerOk(request: Request, token: string | undefined): Response | null {
  if (!token) return json(500, { error: "RUNNER_API_TOKEN not configured" });
  const header = request.headers.get("Authorization") ?? "";
  if (header !== `Bearer ${token}`) return json(401, { error: "Unauthorized" });
  return null;
}

export async function handleHealth(env: Env): Promise<Response> {
  return json(200, await healthBody(env));
}

export async function healthBody(env: Env): Promise<Record<string, unknown>> {
  const counts = await env.DB.prepare(
    `SELECT status, COUNT(*) AS n FROM inbox_events GROUP BY status`,
  ).all<{ status: string; n: number }>();
  const inbox: Record<string, number> = {};
  for (const row of counts.results ?? []) inbox[row.status] = row.n;
  const pending = await env.DB.prepare(`SELECT COUNT(*) AS n FROM outbox WHERE status = 'pending'`).first<{ n: number }>();
  const rejected = await env.DB.prepare(`SELECT COUNT(*) AS n FROM webhook_rejections`).first<{ n: number }>();
  const meta = await getMetaMap(env.DB);
  const m = (k: string) => meta[k]?.value ?? null;
  return {
    ok: true,
    service: "hkjc-agent-runner",
    signature: env.PUSH_SECRET ? "required" : "not_configured",
    openai_key_configured: Boolean(env.OPENAI_API_KEY),
    openai_model_configured: Boolean(env.OPENAI_MODEL),
    roles_loaded: allRoles().length,
    inbox,
    outbox_pending: pending?.n ?? 0,
    rejections: rejected?.n ?? 0,
    last_queue_send_ok: m("last_queue_send_ok"),
    last_queue_send_error: m("last_queue_send_error"),
    last_model_ok: m("last_model_ok"),
    last_model_error: m("last_model_error"),
    last_dispatcher_run: m("last_dispatcher_run"),
  };
}

export async function handleGetRun(request: Request, env: Env, runId: string): Promise<Response> {
  const denied = bearerOk(request, env.RUNNER_API_TOKEN);
  if (denied) return denied;
  const run = await env.DB.prepare(`SELECT * FROM analysis_runs WHERE id = ?`).bind(runId).first<Record<string, unknown>>();
  if (!run) return json(404, { error: "not found" });
  const steps = await env.DB.prepare(
    `SELECT round, role_id, kind, status, output_json, error, created_at FROM run_steps WHERE run_id = ? ORDER BY round, role_id`,
  )
    .bind(runId)
    .all<Record<string, unknown>>();
  return json(200, {
    run: { ...run, conclusion: parse(run.conclusion_json), disagreements: parse(run.disagreements_json) },
    steps: (steps.results ?? []).map((s) => ({ ...s, output: parse(s.output_json) })),
  });
}

function parse(v: unknown): unknown {
  if (typeof v !== "string") return null;
  try { return JSON.parse(v); } catch { return null; }
}
