import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handleMessage } from "../src/consumer";
import { routeEvent } from "../src/router";
import { setRolesForTest } from "../src/roles";
import { handleWebhook } from "../src/webhook";
import { runDispatcher } from "../src/outbox";
import { handleHealth, handleGetRun } from "../src/http";
import type { ModelClient } from "../src/openai";
import { ctxOf, envelope, freshDb, fakeQueue, race, signed, testEnv, useFixtureRoles } from "./helpers";

function okOutput(over: Record<string, unknown> = {}) {
  return {
    stance: "no bet",
    picks: [{ horse_no: 1, p_win: 0.2, p_place: 0.45, note: "fixture" }],
    uncertainties: [],
    disagreements: [],
    record_labels: [],
    ...over,
  };
}

function scripted(handler: (input: string, schemaName: string) => unknown, calls: string[]): ModelClient {
  return {
    async complete(req) {
      calls.push(req.input);
      const value = handler(req.input, req.schemaName);
      if (value instanceof Error) throw value;
      return value;
    },
  };
}

beforeEach(useFixtureRoles);
afterEach(() => setRolesForTest(null));

describe("webhook signature and dedupe", () => {
  it("accepts a correct signature and rejects a wrong one", async () => {
    const db = await freshDb();
    const env = testEnv(db, fakeQueue());
    const body = envelope({ event: "test" });
    const good = await handleWebhook(new Request("https://x/webhook", { method: "POST", headers: await signed("test-secret", body), body }), env, ctxOf().ctx);
    expect(good.status).toBe(202);
    expect(await good.json()).toEqual({ received: true });

    const bad = await handleWebhook(
      new Request("https://x/webhook", { method: "POST", headers: { "X-Signature": "00".repeat(32) }, body }),
      env,
      ctxOf().ctx,
    );
    expect(bad.status).toBe(401);
    const rejected = await db.prepare(`SELECT COUNT(*) AS n FROM webhook_rejections`).first<{ n: number }>();
    expect(rejected?.n).toBe(1);
    const rows = await db.prepare(`SELECT COUNT(*) AS n FROM inbox_events`).first<{ n: number }>();
    expect(rows?.n).toBe(1);
  });

  it("stores the raw body once when the same event is retried", async () => {
    const db = await freshDb();
    const env = testEnv(db, fakeQueue());
    const body = envelope({
      event: "odds_update",
      races: [race(1, "2026-10-07T18:40:00+08:00")],
    });
    const { ctx, done } = ctxOf();
    const first = await handleWebhook(new Request("https://x/webhook", { method: "POST", headers: await signed("test-secret", body), body }), env, ctx);
    const second = await handleWebhook(new Request("https://x/webhook", { method: "POST", headers: await signed("test-secret", body), body }), env, ctx);
    expect(first.status).toBe(202);
    expect(second.headers.get("X-Duplicate")).toBe("1");
    await done();
    const row = await db.prepare(`SELECT duplicate_count, signature_status, raw_body FROM inbox_events`).first<{ duplicate_count: number; signature_status: string; raw_body: string }>();
    expect(row?.duplicate_count).toBe(1);
    expect(row?.signature_status).toBe("valid");
    expect(row?.raw_body).toBe(body);
    const out = await db.prepare(`SELECT COUNT(*) AS n FROM outbox`).first<{ n: number }>();
    expect(out?.n).toBe(1);
  });

  it("dedupes on meta.content_hash when present, else on meeting, race, event and snapshot", async () => {
    const db = await freshDb();
    const env = testEnv(db, fakeQueue());
    const post = async (body: string) =>
      handleWebhook(new Request("https://x/webhook", { method: "POST", headers: await signed("test-secret", body), body }), env, ctxOf().ctx);
    await post(envelope({ event: "horse_update", races: [], meta: { content_hash: "abc", horse_codes: ["H000"] } }));
    await post(envelope({ event: "horse_update", sent_at: "2026-10-07T13:00:00+08:00", races: [], meta: { content_hash: "abc", horse_codes: ["H000"] } }));
    await post(envelope({ event: "horse_update", races: [], meta: { content_hash: "def", horse_codes: ["H000"] } }));
    const n = await db.prepare(`SELECT COUNT(*) AS n FROM inbox_events WHERE event_type = 'horse_update'`).first<{ n: number }>();
    expect(n?.n).toBe(2);
    const src = await db.prepare(`SELECT dedupe_source FROM inbox_events WHERE event_type = 'odds_update'`).all();
    await post(envelope({ event: "lock", races: [race(2, "2026-10-07T18:45:00+08:00")] }));
    const lock = await db.prepare(`SELECT dedupe_key, dedupe_source FROM inbox_events WHERE event_type = 'lock'`).first<{ dedupe_key: string; dedupe_source: string }>();
    expect(lock?.dedupe_source).toBe("derived");
    expect(lock?.dedupe_key).toContain("lock|2026-10-07|HV|2@2026-10-07T18:45:00+08:00");
    expect(src).toBeTruthy();
  });
});

describe("outbox survives a queue outage", () => {
  it("keeps the event when the queue send fails, then delivers it once the queue recovers", async () => {
    const db = await freshDb();
    const queue = fakeQueue();
    queue.fail = true;
    const env = testEnv(db, queue);
    const body = envelope({ event: "schedule", meeting_date: null, venue: null });
    const { ctx, done } = ctxOf();
    const res = await handleWebhook(new Request("https://x/webhook", { method: "POST", headers: await signed("test-secret", body), body }), env, ctx);
    expect(res.status).toBe(202);
    await done();
    expect(queue.sent).toHaveLength(0);
    const pending = await db.prepare(`SELECT status, attempts, last_error FROM outbox`).first<{ status: string; attempts: number; last_error: string }>();
    expect(pending?.status).toBe("pending");
    expect(pending?.attempts).toBe(1);
    expect(pending?.last_error).toContain("queue temporarily unavailable");

    queue.fail = false;
    await db.prepare(`UPDATE outbox SET next_attempt_at = '2000-01-01T00:00:00.000Z'`).run();
    const report = await runDispatcher(env);
    expect(report.sent).toBe(1);
    expect(queue.sent).toHaveLength(1);
    const doneRow = await db.prepare(`SELECT status FROM outbox`).first<{ status: string }>();
    expect(doneRow?.status).toBe("dispatched");
    const inbox = await db.prepare(`SELECT status FROM inbox_events`).first<{ status: string }>();
    expect(inbox?.status).toBe("queued");
  });
});

describe("routing", () => {
  it("maps each event type onto the workflow the contract asks for", () => {
    const r = (event: string) => routeEvent({ schema: "hkjc-push/1.0", event, meeting_date: "2026-10-07", venue: "HV", races: [] }, 45);
    expect(r("odds_update")).toMatchObject({ workflow: "odds_analysis", delaySeconds: 45, roleTags: ["odds", "quant", "strategy", "contrarian"] });
    expect(r("lock").workflow).toBe("lock_analysis");
    expect(r("lock").delaySeconds).toBe(0);
    expect(r("scratch").workflow).toBe("scratch_impact");
    expect(r("horse_update").roleTags[0]).toBe("nursing");
    expect(r("injury_update").workflow).toBe("horse_health");
    expect(r("result").workflow).toBe("post_race_review");
    expect(r("dividends").phase).toBe("post_race");
    for (const event of ["test", "schedule", "backfill_progress", "whitelist_alert"]) {
      expect(r(event).workflow).toBe("record_only");
    }
    expect(r("runs_update").workflow).toBe("record_only");
    expect(r("changes").workflow).toBe("record_only");
  });

  it("does not call the model for delivery-check events", async () => {
    const db = await freshDb();
    const queue = fakeQueue();
    const env = testEnv(db, queue);
    const body = envelope({ event: "whitelist_alert", meta: { message: "WHITELIST_ERROR" } });
    const { ctx, done } = ctxOf();
    await handleWebhook(new Request("https://x/webhook", { method: "POST", headers: await signed("test-secret", body), body }), env, ctx);
    await done();
    const id = queue.sent[0].body.inbox_id;
    const calls: string[] = [];
    await handleMessage(env, id, scripted(() => okOutput(), calls), () => undefined);
    expect(calls).toHaveLength(0);
    const row = await db.prepare(`SELECT status FROM inbox_events WHERE id = ?`).bind(id).first<{ status: string }>();
    expect(row?.status).toBe("skipped");
    const runs = await db.prepare(`SELECT COUNT(*) AS n FROM analysis_runs`).first<{ n: number }>();
    expect(runs?.n).toBe(0);
  });
});

describe("analysis", () => {
  it("coalesces a burst of odds updates and analyses only the latest snapshot", async () => {
    const db = await freshDb();
    const queue = fakeQueue();
    const env = testEnv(db, queue);
    const older = envelope({ event: "odds_update", races: [race(1, "2026-10-07T18:40:00+08:00")] });
    const newer = envelope({ event: "odds_update", races: [race(1, "2026-10-07T18:41:00+08:00")] });
    const { ctx, done } = ctxOf();
    await handleWebhook(new Request("https://x/webhook", { method: "POST", headers: await signed("test-secret", older), body: older }), env, ctx);
    await handleWebhook(new Request("https://x/webhook", { method: "POST", headers: await signed("test-secret", newer), body: newer }), env, ctx);
    await done();
    expect(queue.sent.every((s) => s.delay === 45)).toBe(true);
    const calls: string[] = [];
    const model = scripted((input, name) => (name === "moderator" ? { summary: "s", consensus: [], disagreements: [], invalid_outputs: [] } : okOutput()), calls);
    await handleMessage(env, queue.sent[0].body.inbox_id, model, () => undefined);
    expect(calls).toHaveLength(0);
    const oldRow = await db.prepare(`SELECT status FROM inbox_events WHERE id = ?`).bind(queue.sent[0].body.inbox_id).first<{ status: string }>();
    expect(oldRow?.status).toBe("superseded");
    await handleMessage(env, queue.sent[1].body.inbox_id, model, () => undefined);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0]).toContain("18:41:00");
    expect(calls[0]).not.toContain("18:40:00");
  });

  it("rejects P(Place) above 1, repairs once, and does not keep the invalid number", async () => {
    const db = await freshDb();
    const queue = fakeQueue();
    const env = testEnv(db, queue);
    const body = envelope({ event: "lock", races: [race(1, "2026-10-07T18:50:00+08:00", { final_position: 3 })] });
    const { ctx, done } = ctxOf();
    await handleWebhook(new Request("https://x/webhook", { method: "POST", headers: await signed("test-secret", body), body }), env, ctx);
    await done();
    let first = true;
    const calls: string[] = [];
    const model = scripted((input, name) => {
      if (name === "moderator") return { summary: "locked", consensus: [], disagreements: ["split"], invalid_outputs: [] };
      if (name.startsWith("role_odds") && first) {
        first = false;
        return okOutput({ picks: [{ horse_no: 1, p_win: 0.2, p_place: 1.4, note: "bad" }] });
      }
      return okOutput();
    }, calls);
    await handleMessage(env, queue.sent[0].body.inbox_id, model, () => undefined);
    const bad = calls.some((c) => c.includes("final_position\":3") || c.includes("\"final_position\":3"));
    expect(bad).toBe(false);
    const step = await db.prepare(`SELECT output_json FROM run_steps WHERE role_id = 'odds' AND round = 1`).first<{ output_json: string }>();
    expect(step?.output_json).not.toContain("1.4");
    expect(step?.output_json).toContain("0.45");
    const opinion = await db.prepare(`SELECT locked FROM race_opinions`).first<{ locked: number }>();
    expect(opinion?.locked).toBe(1);
  });

  it("marks the event for retry when the model call fails, and a later success does not start a second run", async () => {
    const db = await freshDb();
    const queue = fakeQueue();
    const env = testEnv(db, queue);
    const body = envelope({ event: "scratch", races: [race(3, "2026-10-07T18:20:00+08:00")] });
    const { ctx, done } = ctxOf();
    await handleWebhook(new Request("https://x/webhook", { method: "POST", headers: await signed("test-secret", body), body }), env, ctx);
    await done();
    const id = queue.sent[0].body.inbox_id;
    let retried = 0;
    const failing: ModelClient = { async complete() { throw new (await import("../src/openai")).ModelCallError("boom", 500); } };
    await handleMessage(env, id, failing, () => { retried++; });
    expect(retried).toBe(1);
    const mid = await db.prepare(`SELECT status, attempts, last_error FROM inbox_events WHERE id = ?`).bind(id).first<{ status: string; attempts: number; last_error: string }>();
    expect(mid).toMatchObject({ status: "retry", attempts: 1 });
    expect(mid?.last_error).toContain("boom");

    const model = scripted((_i, name) => (name === "moderator" ? { summary: "s", consensus: [], disagreements: [], invalid_outputs: [] } : okOutput()), []);
    await handleMessage(env, id, model, () => undefined);
    await handleMessage(env, id, model, () => undefined);
    const runs = await db.prepare(`SELECT COUNT(*) AS n FROM analysis_runs`).first<{ n: number }>();
    expect(runs?.n).toBe(1);
    const doneRow = await db.prepare(`SELECT status FROM inbox_events WHERE id = ?`).bind(id).first<{ status: string }>();
    expect(doneRow?.status).toBe("done");
  });

  it("keeps post-race review to locked opinions and labels undated injury notes unknown", async () => {
    const db = await freshDb();
    const queue = fakeQueue();
    const env = testEnv(db, queue);
    await db.prepare(
      `INSERT INTO race_opinions (meeting_date, venue, race_no, run_id, snapshot_time, locked, locked_at, opinion_json)
       VALUES ('2026-10-07','HV',1,'run-locked','2026-10-07T18:50:00+08:00',1,'2026-10-07T18:50:00Z','{"summary":"LOCKED OPINION"}'),
              ('2026-10-07','HV',2,'run-open','2026-10-07T18:40:00+08:00',0,NULL,'{"summary":"UNLOCKED OPINION"}')`,
    ).run();
    const body = envelope({
      event: "result",
      races: [race(1, "2026-10-07T18:55:00+08:00", { final_position: 1 })],
    });
    const { ctx, done } = ctxOf();
    await handleWebhook(new Request("https://x/webhook", { method: "POST", headers: await signed("test-secret", body), body }), env, ctx);
    await done();
    const calls: string[] = [];
    const model = scripted((_i, name) => {
      if (name === "moderator") return { summary: "reviewed", consensus: [], disagreements: [], invalid_outputs: [] };
      return okOutput({ record_labels: [{ item: "vet note", kind: "new_notice", basis: "guess" }] });
    }, calls);
    await handleMessage(env, queue.sent[0].body.inbox_id, model, () => undefined);
    expect(calls.some((c) => c.includes("LOCKED OPINION"))).toBe(true);
    expect(calls.some((c) => c.includes("UNLOCKED OPINION"))).toBe(false);

    const injury = envelope({ event: "injury_update", races: [], meta: { source: "https://example.test/vet" } });
    const ctx2 = ctxOf();
    await handleWebhook(new Request("https://x/webhook", { method: "POST", headers: await signed("test-secret", injury), body: injury }), env, ctx2.ctx);
    await ctx2.done();
    const calls2: string[] = [];
    await handleMessage(env, queue.sent[1].body.inbox_id, scripted((_i, name) => (name === "moderator" ? { summary: "h", consensus: [], disagreements: [], invalid_outputs: [] } : okOutput({ record_labels: [{ item: "vet note", kind: "new_notice", basis: "guess" }] })), calls2), () => undefined);
    const nursing = await db.prepare(
      `SELECT s.output_json FROM run_steps s JOIN analysis_runs r ON r.id = s.run_id
       WHERE s.role_id = 'nursing' AND s.round = 1 AND r.workflow = 'horse_health'`,
    ).first<{ output_json: string }>();
    expect(nursing?.output_json).toContain("unknown");
    expect(nursing?.output_json).not.toContain("new_notice");
  });
});

describe("reads", () => {
  it("reports health without a token and hides runs behind one", async () => {
    const db = await freshDb();
    const env = testEnv(db, fakeQueue());
    const health = await handleHealth(env);
    const body = await health.json() as { ok: boolean; signature: string; roles_loaded: number };
    expect(body.ok).toBe(true);
    expect(body.signature).toBe("required");
    expect(body.roles_loaded).toBe(8);
    const hidden = await handleGetRun(new Request("https://x/runs/nope"), env, "nope");
    expect(hidden.status).toBe(401);
    const missing = await handleGetRun(new Request("https://x/runs/nope", { headers: { Authorization: "Bearer runner-token" } }), env, "nope");
    expect(missing.status).toBe(404);
  });
});
