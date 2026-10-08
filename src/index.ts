import { handleBatch } from "./consumer";
import type { Env, QueueMessageBody } from "./env";
import { handleGetRun, handleHealth } from "./http";
import { runDispatcher } from "./outbox";
import { handleWebhook } from "./webhook";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") return handleHealth(env);
    if (request.method === "POST" && url.pathname === "/webhook") return handleWebhook(request, env, ctx);
    const run = /^\/runs\/([^/]+)$/.exec(url.pathname);
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
    ctx.waitUntil(runDispatcher(env).then(() => undefined));
  },
};
