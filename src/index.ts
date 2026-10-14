import { handleBatch } from "./consumer";
import type { Env, QueueMessageBody } from "./env";
import { flushPendingForwards } from "./forward";
import { handleAdminSubscribers, handleGetRun, handleHealth } from "./http";
import { runDispatcher } from "./outbox";
import { handleWebhook } from "./webhook";
import { handleMcp } from "./mcp";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    if (request.method === "GET" && path === "/health") return handleHealth(env);
    if (path === "/mcp") return handleMcp(request, env);
    if (request.method === "POST" && path === "/webhook") return handleWebhook(request, env, ctx);
    if (path === "/v1/admin/subscribers") return handleAdminSubscribers(request, env);
    const subMatch = /^\/v1\/admin\/subscribers\/(\d+)$/.exec(path);
    if (subMatch) return handleAdminSubscribers(request, env, subMatch[1]);
    const run = /^\/runs\/([^/]+)$/.exec(path);
    if (request.method === "GET" && run) return handleGetRun(request, env, decodeURIComponent(run[1]));
    return new Response(JSON.stringify({ error: "not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  },

  async queue(batch: MessageBatch<QueueMessageBody>, env: Env): Promise<void> {
    await handleBatch(batch, env);
  },

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      Promise.all([
        runDispatcher(env).then(() => undefined),
        flushPendingForwards(env).then(() => undefined),
      ]),
    );
  },
};
