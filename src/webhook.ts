import { sha256Hex, verifySignature } from "./crypto";
import { dedupeKey, maxSnapshotTime, parseEnvelope } from "./envelope";
import type { Env } from "./env";
import { envInt } from "./env";
import { dispatchByInbox } from "./outbox";
import { routeEvent } from "./router";
import { persistInbound, recordRejection } from "./store";

const MAX_BODY_BYTES = 2 * 1024 * 1024;

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

/**
 * POST /webhook
 * 1. read raw bytes; 2. verify X-Signature when PUSH_SECRET is set;
 * 3. persist inbox + outbox in D1 (one batch); 4. return 202 {"received":true};
 * 5. hand the outbox row to the Queue via waitUntil (cron dispatcher retries on failure).
 */
export async function handleWebhook(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const raw = new Uint8Array(await request.arrayBuffer());
  if (raw.byteLength > MAX_BODY_BYTES) {
    await recordRejection(env.DB, "body too large", await sha256Hex(raw), raw.byteLength);
    return json(413, { error: "payload too large" });
  }
  const sig = await verifySignature(env.PUSH_SECRET, raw, request.headers.get("X-Signature"));
  if (sig === "invalid" || sig === "missing") {
    await recordRejection(env.DB, `signature ${sig}`, await sha256Hex(raw), raw.byteLength);
    return json(401, { error: "bad signature" });
  }

  const text = new TextDecoder().decode(raw);
  const parsed = parseEnvelope(text);
  if (!parsed.ok) {
    await recordRejection(env.DB, parsed.error, await sha256Hex(raw), raw.byteLength);
    return json(400, { error: parsed.error });
  }
  const ev = parsed.envelope;
  const route = routeEvent(ev, envInt(env.ODDS_COALESCE_SECONDS, 45, 0, 600));
  const { key, source } = await dedupeKey(ev);

  const oddsRaces =
    ev.event === "odds_update"
      ? ev.races
          .filter((r) => typeof r?.race_no === "number" && typeof r?.snapshot_time === "string")
          .map((r) => ({ race_no: r.race_no, snapshot_time: r.snapshot_time }))
      : undefined;

  const { id, duplicate } = await persistInbound(env.DB, {
    dedupe_key: key,
    dedupe_source: source,
    event_type: ev.event,
    schema_version: ev.schema,
    meeting_date: ev.meeting_date,
    venue: ev.venue,
    race_nos: ev.races.map((r) => r?.race_no).filter((n): n is number => typeof n === "number"),
    snapshot_time: maxSnapshotTime(ev),
    sent_at: ev.sent_at ?? null,
    raw_body: text,
    signature_status: sig,
    workflow: route.workflow,
    delay_seconds: route.delaySeconds,
    odds_races: oddsRaces,
  });

  if (!duplicate) {
    ctx.waitUntil(dispatchByInbox(env, id).then(() => undefined, () => undefined));
  }
  return json(202, { received: true }, { "X-Inbox-Id": id, ...(duplicate ? { "X-Duplicate": "1" } : {}) });
}
