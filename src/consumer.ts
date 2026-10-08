import { runAnalysis } from "./coordinator";
import type { Env, QueueMessageBody } from "./env";
import { envInt, nowIso } from "./env";
import { createOpenAIClient, ModelCallError, ModelConfigError, type ModelClient } from "./openai";
import { setInboxStatus, setMeta, getInbox } from "./store";

export async function handleMessage(
  env: Env,
  inboxId: string,
  model: ModelClient,
  retry: () => void,
): Promise<void> {
  const inbox = await getInbox(env.DB, inboxId);
  if (!inbox) return;
  if (inbox.status === "done" || inbox.status === "skipped" || inbox.status === "superseded" || inbox.status === "failed") {
    return;
  }
  const max = envInt(env.MAX_PROCESS_ATTEMPTS, 4, 1, 20);
  if (inbox.attempts >= max) {
    await setInboxStatus(env.DB, inboxId, "failed", { last_error: inbox.last_error ?? "max attempts" });
    return;
  }
  const claimed = await claim(env, inboxId);
  if (!claimed) return;

  if (inbox.workflow === "record_only") {
    await setInboxStatus(env.DB, inboxId, "skipped", { last_error: null });
    await setMeta(env.DB, `last_${inbox.event_type}`, nowIso());
    return;
  }
  try {
    await runAnalysis(env, { ...inbox, status: "processing" }, model);
  } catch (err) {
    const message = (err instanceof Error ? err.message : String(err)).slice(0, 500);
    await setInboxStatus(env.DB, inboxId, "retry", { last_error: message });
    if (err instanceof ModelCallError || err instanceof ModelConfigError) {
      await setMeta(env.DB, "last_model_error", message);
    }
    retry();
  }
}

async function claim(env: Env, id: string): Promise<boolean> {
  const now = nowIso();
  const lease = new Date(Date.now() + 120_000).toISOString();
  const res = await env.DB.prepare(
    `UPDATE inbox_events SET status = 'processing', attempts = attempts + 1, lease_until = ?, updated_at = ?
     WHERE id = ? AND (status IN ('received','queued','retry') OR (status = 'processing' AND lease_until < ?))`,
  )
    .bind(lease, now, id, now)
    .run();
  return (res.meta.changes ?? 0) === 1;
}

export async function handleBatch(
  batch: MessageBatch<QueueMessageBody>,
  env: Env,
  model: ModelClient = createOpenAIClient(env),
): Promise<void> {
  for (const msg of batch.messages) {
    await handleMessage(env, msg.body.inbox_id, model, () => msg.retry({ delaySeconds: 30 }));
  }
}
