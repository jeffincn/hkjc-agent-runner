import { handleBatch } from "./consumer";
import type { Env, QueueMessageBody } from "./env";
import {
  handleCreateAgentSubscriber,
  handleDeleteAgentSubscriber,
  handleGetAgentSubscriber,
  handleGetRun,
  handleHealth,
  handleListAgentSubscribers,
  handleUpdateAgentSubscriber,
} from "./http";
import { runDispatcher } from "./outbox";
import { handleWebhook } from "./webhook";
import { handleMcp } from "./mcp";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") return handleHealth(env);
    if (url.pathname === "/mcp") return handleMcp(request, env);
    if (request.method === "POST" && url.pathname === "/webhook") return handleWebhook(request, env, ctx);
    const run = /^\/runs\/([^/]+)$/.exec(url.pathname);
    if (request.method === "GET" && run) return handleGetRun(request, env, decodeURIComponent(run[1]));
    // Downstream agent subscriber admin (Bearer RUNNER_API_TOKEN).
    if (url.pathname === "/v1/admin/agent-subscribers") {
      if (request.method === "GET") return handleListAgentSubscribers(request, env);
      if (request.method === "POST") return handleCreateAgentSubscriber(request, env);
    }
    const sub = /^\/v1\/admin\/agent-subscribers\/(\d+)$/.exec(url.pathname);
    if (sub) {
      const id = Number(sub[1]);
      if (request.method === "GET") return handleGetAgentSubscriber(request, env, id);
      if (request.method === "PATCH") return handleUpdateAgentSubscriber(request, env, id);
      if (request.method === "DELETE") return handleDeleteAgentSubscriber(request, env, id);
    }
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
