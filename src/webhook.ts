import { normStatus } from "./push11";
import { sha256Hex, verifySignature } from "./crypto";
import { dedupeKey, maxSnapshotTime, parseEnvelope } from "./envelope";
import type { Env } from "./env";
import { envInt, nowMs } from "./env";
import { fanOutAccepted } from "./forward";
import { assess, PRE_RACE_INPUT_EVENTS } from "./quality";
import type { LedgerEntry } from "./store";
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
  const receivedMs = nowMs();
  let route = routeEvent(ev, envInt(env.ODDS_COALESCE_SECONDS, 45, 0, 600));
  const { key, source } = await dedupeKey(ev);

  const oddsRaces =
    ev.event === "odds_update"
      ? ev.races
          .filter((r) => typeof r?.race_no === "number" && typeof r?.snapshot_time === "string")
          .map((r) => ({ race_no: r.race_no, snapshot_time: r.snapshot_time }))
      : undefined;

  // ---- data quality (timing, flags, schedule, ledger)
  const postTimes = new Map<number, string>();
  if (ev.meeting_date) {
    const sched = await env.DB.prepare(`SELECT race_no, post_time FROM race_schedule WHERE meeting_date = ?`)
      .bind(ev.meeting_date).all<{ race_no: number; post_time: string }>();
    for (const r of sched.results ?? []) postTimes.set(r.race_no, r.post_time);
  }
  const schedule = ev.races
    .filter((r) => typeof r?.race_no === "number" && typeof r?.post_time === "string" && r.post_time)
    .map((r) => ({ race_no: r.race_no, post_time: r.post_time as string }));
  for (const s of schedule) postTimes.set(s.race_no, s.post_time);
  const state = ev.meeting_date
    ? await env.DB.prepare(`SELECT last_seq FROM stream_state WHERE meeting_date = ?`).bind(ev.meeting_date).first<{ last_seq: number | null }>()
    : null;
  const seq = ev.v11?.seq ?? null;
  const seqSeen = seq !== null && ev.meeting_date
    ? Boolean(await env.DB.prepare(`SELECT 1 AS x FROM inbox_events WHERE meeting_date = ? AND seq = ? AND dedupe_key != ? LIMIT 1`)
        .bind(ev.meeting_date, seq, key).first())
    : false;
  const qa = assess(ev, receivedMs, { last_seq: state?.last_seq ?? null }, postTimes, seqSeen);
  // Post-start content never feeds pre-race analysis.
  if (qa.post_race && PRE_RACE_INPUT_EVENTS.has(ev.event) && route.workflow !== "record_only") {
    route = { ...route, workflow: "record_only", phase: "post_race", delaySeconds: 0, note: "post_start: excluded from pre-race analysis" };
  }
  const started = new Set(qa.started_races);
  const isPost = (raceNo: number) => started.has(raceNo) || (qa.post_race && !postTimes.has(raceNo));
  const ledger: LedgerEntry[] = [];
  if (ev.event === "odds_delta") {
    for (const c of ev.v11?.changes ?? []) ledger.push({ ...c, post_race: isPost(c.race_no) });
  } else if (ev.event === "odds_update") {
    for (const r of ev.races) {
      if (typeof r?.race_no !== "number") continue;
      for (const runner of r.runners ?? []) {
        if (typeof runner?.horse_no !== "number") continue;
        for (const [bet_type, odds] of [["WIN", runner.win_odds], ["PLA", runner.place_odds]] as const) {
          if (typeof odds !== "number") continue;
          // Snapshots carry no previous value; HKJC quotes are total return per $1.
          // 1.1 may add horse_name_ch alongside horse_name.
          ledger.push({
            race_no: r.race_no,
            runner_no: runner.horse_no,
            name_zh: runner.horse_name_ch ?? null,
            name_en: runner.horse_name ?? null,
            bet_type,
            runner_id: typeof runner.runner_id === "string" && runner.runner_id ? runner.runner_id : null,
            horse_name: runner.horse_name ?? null,
            status: normStatus(runner.status),
            pool: bet_type,
            prev_odds: null,
            new_odds: odds,
            odds_basis: "total_return",
            post_race: isPost(r.race_no),
          });
        }
      }
    }
  }

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
    odds_races: qa.post_race ? undefined : oddsRaces,
    received_ms: receivedMs,
    quality: {
      event_id: ev.v11?.event_id ?? null,
      seq,
      captured_at: qa.captured_at,
      source_updated_at: qa.source_updated_at,
      source_url: ev.v11?.source_url ?? null,
      received_at_hkt: qa.received_at_hkt,
      delay_received_sent_ms: qa.delay_received_sent_ms,
      delay_received_captured_ms: qa.delay_received_captured_ms,
      delay_captured_source_ms: qa.delay_captured_source_ms,
      flags: qa.flags,
      post_race: qa.post_race,
      gap: qa.gap,
      heartbeat: ev.event === "no_update" ? { last_change_seq: ev.v11?.last_change_seq ?? null } : null,
      schedule,
      ledger,
    },
  });

  if (!duplicate) {
    // Queue dispatch + downstream fan-out run after accept; 202 path unchanged.
    ctx.waitUntil(dispatchByInbox(env, id).then(() => undefined, () => undefined));
    ctx.waitUntil(
      fanOutAccepted(env, {
        inbox_id: id,
        raw_body: text,
        event_type: ev.event,
        meeting_date: ev.meeting_date,
        quality_flags: qa.flags,
      }).then(() => undefined, () => undefined),
    );
  }
  return json(202, { received: true }, {
    "X-Inbox-Id": id,
    ...(duplicate ? { "X-Duplicate": "1" } : {}),
    ...(!duplicate && qa.flags.length ? { "X-Quality-Flags": qa.flags.join(",") } : {}),
  });
}
