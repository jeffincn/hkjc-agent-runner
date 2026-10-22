import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setClockForTest } from "../src/env";
import {
  createAgentSubscriber,
  deleteAgentSubscriber,
  getAgentSubscriber,
  listAgentSubscribers,
  parseEventFilter,
  subscriberWantsEvent,
  toPublicAgentSubscriber,
  updateAgentSubscriber,
} from "../src/agentSubscribers";
import {
  allowAgentDelivery,
  recordAgentDeliveryFailure,
  recordAgentDeliverySuccess,
} from "../src/agentCircuit";
import {
  fanoutToAgents,
  flushPendingForwards,
  hktDate,
  inQuietHours,
  nextBackoffMinutes,
  stageFanoutPending,
  windowActive,
} from "../src/fanout";
import { nowIso } from "../src/env";
import {
  handleCreateAgentSubscriber,
  handleDeleteAgentSubscriber,
  handleGetAgentSubscriber,
  handleListAgentSubscribers,
  handleUpdateAgentSubscriber,
} from "../src/http";
import { freshDb, testEnv, fakeQueue } from "./helpers";

const T0 = Date.parse("2026-10-07T12:00:00+08:00"); // race day morning HKT

beforeEach(() => {
  setClockForTest(() => T0);
  vi.unstubAllGlobals();
});
afterEach(() => {
  setClockForTest(null);
  vi.unstubAllGlobals();
});

function authed(body?: unknown, method = "POST"): Request {
  return new Request("https://x/v1/admin/agent-subscribers", {
    method,
    headers: { Authorization: "Bearer runner-token", "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("event_filter parsing and matching", () => {
  it("null/empty filter matches every event", () => {
    expect(parseEventFilter(null)).toBeNull();
    expect(parseEventFilter([])).toBeNull();
    expect(subscriberWantsEvent({ event_filter: null }, "odds_delta")).toBe(true);
    expect(subscriberWantsEvent({ event_filter: [] }, "result")).toBe(true);
  });

  it("matches only listed event types", () => {
    const f = parseEventFilter(["result", "odds_delta"]);
    expect(f).toEqual(["result", "odds_delta"]);
    expect(subscriberWantsEvent({ event_filter: f }, "result")).toBe(true);
    expect(subscriberWantsEvent({ event_filter: f }, "odds_delta")).toBe(true);
    expect(subscriberWantsEvent({ event_filter: f }, "no_update")).toBe(false);
  });

  it("rejects unknown event names", () => {
    expect(() => parseEventFilter(["bogus_event"])).toThrow(/unknown event/);
    expect(() => parseEventFilter("result")).toThrow();
  });
});

describe("window and quiet hours", () => {
  it("hktDate renders the Hong Kong calendar date", () => {
    expect(hktDate(T0)).toBe("2026-10-07");
    // 23:30 UTC = 07:30 HKT next day
    expect(hktDate(Date.parse("2026-10-06T23:30:00Z"))).toBe("2026-10-07");
  });

  it("always window is never gated; raceday needs today's meeting", () => {
    expect(windowActive({ active_window: "always" }, null, T0)).toBe(true);
    expect(windowActive({ active_window: "raceday" }, "2026-10-07", T0)).toBe(true);
    expect(windowActive({ active_window: "raceday" }, "2026-10-06", T0)).toBe(false);
    expect(windowActive({ active_window: "raceday" }, null, T0)).toBe(false);
  });

  it("quiet hours respect overnight wrap", () => {
    const night = Date.parse("2026-10-07T02:00:00+08:00");
    const day = Date.parse("2026-10-07T12:00:00+08:00");
    expect(inQuietHours(night, "00:00", "08:00")).toBe(true);
    expect(inQuietHours(day, "00:00", "08:00")).toBe(false);
    // overnight wrap 22:00 -> 06:00
    expect(inQuietHours(night, "22:00", "06:00")).toBe(true);
    expect(inQuietHours(day, "22:00", "06:00")).toBe(false);
    expect(inQuietHours(Date.parse("2026-10-07T23:00:00+08:00"), "22:00", "06:00")).toBe(true);
  });
});

describe("agent_subscribers CRUD", () => {
  it("creates, reads, updates and deletes; public shape hides the secret", async () => {
    const db = await freshDb();
    const env = testEnv(db, fakeQueue());
    const created = await createAgentSubscriber(env, {
      url: "https://agent-a.example/hook",
      secret: "s3cr3t",
      event_filter: ["result"],
      active_window: "raceday",
    });
    expect(created.id).toBeGreaterThan(0);
    expect(created.enabled).toBe(true);
    expect(created.event_filter).toEqual(["result"]);

    const pub = toPublicAgentSubscriber(created);
    expect(pub.has_secret).toBe(true);
    expect("secret" in pub).toBe(false);

    const got = await getAgentSubscriber(env, created.id);
    expect(got?.url).toBe("https://agent-a.example/hook");
    expect(got?.secret).toBe("s3cr3t");

    const updated = await updateAgentSubscriber(env, created.id, {
      enabled: false,
      event_filter: ["odds_delta", "result"],
    });
    expect(updated?.enabled).toBe(false);
    expect(updated?.event_filter).toEqual(["odds_delta", "result"]);

    const listed = await listAgentSubscribers(env);
    expect(listed).toHaveLength(1);

    expect(await deleteAgentSubscriber(env, created.id)).toBe(true);
    expect(await getAgentSubscriber(env, created.id)).toBeNull();
    expect(await deleteAgentSubscriber(env, created.id)).toBe(false);
  });

  it("validates url, event filter, window and quiet hours", async () => {
    const db = await freshDb();
    const env = testEnv(db, fakeQueue());
    await expect(createAgentSubscriber(env, { url: "not-a-url" })).rejects.toThrow(/valid absolute URL/);
    await expect(createAgentSubscriber(env, { url: "" })).rejects.toThrow(/url is required/);
    await expect(
      createAgentSubscriber(env, { url: "https://x.example/", event_filter: ["nope"] as never }),
    ).rejects.toThrow(/unknown event/);
    await expect(
      createAgentSubscriber(env, { url: "https://x.example/", active_window: "sometimes" as never }),
    ).rejects.toThrow(/active_window/);
    await expect(
      createAgentSubscriber(env, { url: "https://x.example/", quiet_start: "25:00" }),
    ).rejects.toThrow(/HH:MM/);
  });

  it("rejects duplicate urls", async () => {
    const db = await freshDb();
    const env = testEnv(db, fakeQueue());
    await createAgentSubscriber(env, { url: "https://dup.example/hook" });
    await expect(createAgentSubscriber(env, { url: "https://dup.example/hook" })).rejects.toThrow();
  });

  it("update returns null for unknown id", async () => {
    const db = await freshDb();
    const env = testEnv(db, fakeQueue());
    expect(await updateAgentSubscriber(env, 4242, { enabled: false })).toBeNull();
  });
});

describe("per-subscriber circuit breaker", () => {
  it("opens after the failure threshold and recovers on success", async () => {
    const db = await freshDb();
    const env = testEnv(db, fakeQueue(), { CIRCUIT_BREAKER_THRESHOLD: "3" });
    const sub = await createAgentSubscriber(env, { url: "https://flaky.example/hook" });

    expect((await allowAgentDelivery(env, sub.id)).allowed).toBe(true);
    await recordAgentDeliveryFailure(env, sub.id, { http_status: 500 });
    await recordAgentDeliveryFailure(env, sub.id, { http_status: 500 });
    expect((await allowAgentDelivery(env, sub.id)).allowed).toBe(true);
    await recordAgentDeliveryFailure(env, sub.id, { http_status: 500 });
    const blocked = await allowAgentDelivery(env, sub.id);
    expect(blocked.allowed).toBe(false);
    expect(blocked.state).toBe("open");

    await recordAgentDeliverySuccess(env, sub.id, 200);
    const again = await allowAgentDelivery(env, sub.id);
    expect(again.allowed).toBe(true);
    expect(again.state).toBe("closed");
  });

  it("opens on consecutive 429s faster than on 500s", async () => {
    const db = await freshDb();
    const env = testEnv(db, fakeQueue(), {
      CIRCUIT_BREAKER_THRESHOLD: "100",
      CIRCUIT_BREAKER_429_THRESHOLD: "3",
    });
    const sub = await createAgentSubscriber(env, { url: "https://limited.example/hook" });
    await recordAgentDeliveryFailure(env, sub.id, { http_status: 429 });
    await recordAgentDeliveryFailure(env, sub.id, { http_status: 429 });
    expect((await allowAgentDelivery(env, sub.id)).allowed).toBe(true);
    await recordAgentDeliveryFailure(env, sub.id, { http_status: 429 });
    expect((await allowAgentDelivery(env, sub.id)).allowed).toBe(false);
  });

  it("half-open probe is allowed after the window elapses", async () => {
    const db = await freshDb();
    const env = testEnv(db, fakeQueue(), {
      CIRCUIT_BREAKER_THRESHOLD: "1",
      CIRCUIT_HALF_OPEN_MS: "60000",
    });
    const sub = await createAgentSubscriber(env, { url: "https://probe.example/hook" });
    await recordAgentDeliveryFailure(env, sub.id, { http_status: 500 });
    expect((await allowAgentDelivery(env, sub.id)).allowed).toBe(false);
    // jump past the half-open window
    setClockForTest(() => T0 + 61_000);
    const probe = await allowAgentDelivery(env, sub.id);
    expect(probe.allowed).toBe(true);
    expect(probe.state).toBe("half_open");
    // a failed probe re-opens immediately
    await recordAgentDeliveryFailure(env, sub.id, { http_status: 500 });
    expect((await allowAgentDelivery(env, sub.id)).allowed).toBe(false);
  });

  it("circuits are isolated per subscriber", async () => {
    const db = await freshDb();
    const env = testEnv(db, fakeQueue(), { CIRCUIT_BREAKER_THRESHOLD: "1" });
    const a = await createAgentSubscriber(env, { url: "https://a.example/hook" });
    const b = await createAgentSubscriber(env, { url: "https://b.example/hook" });
    await recordAgentDeliveryFailure(env, a.id, { http_status: 500 });
    expect((await allowAgentDelivery(env, a.id)).allowed).toBe(false);
    expect((await allowAgentDelivery(env, b.id)).allowed).toBe(true);
  });
});

describe("fanoutToAgents", () => {
  function stubFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal(
      "fetch",
      async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return handler(url, init);
      },
    );
    return calls;
  }

  const okResp = () => new Response("{}", { status: 200 });

  async function seedInbox(
    db: D1Database,
    opts: { id: string; rawBody: string; eventType?: string; meetingDate?: string; seq?: number | null },
  ): Promise<void> {
    const ts = nowIso();
    await db
      .prepare(
        `INSERT INTO inbox_events
          (id, dedupe_key, dedupe_source, event_type, schema_version, meeting_date, venue,
           race_nos, snapshot_time, sent_at, raw_body, received_at, signature_status, status, workflow, updated_at, seq)
         VALUES (?, ?, 'test', ?, 'hkjc-push/1.1', ?, 'HV', '[]', NULL, NULL, ?, ?, 'valid', 'received', 'record_only', ?, ?)`,
      )
      .bind(
        opts.id,
        `dk-${opts.id}`,
        opts.eventType ?? "result",
        opts.meetingDate ?? "2026-10-07",
        opts.rawBody,
        ts,
        ts,
        opts.seq ?? null,
      )
      .run();
  }

  async function runFanout(
    env: ReturnType<typeof testEnv>,
    input: {
      eventType: string;
      rawBody: string;
      qualityFlags: string[];
      meetingDate: string | null;
      inboxId: string;
      seq: number | null;
    },
  ) {
    await stageFanoutPending(env, input);
    return fanoutToAgents(env, input);
  }

  it("forwards to matching subscribers only, with quality flags header", async () => {
    const db = await freshDb();
    const env = testEnv(db, fakeQueue());
    await createAgentSubscriber(env, { url: "https://all.example/hook" });
    await createAgentSubscriber(env, { url: "https://results.example/hook", event_filter: ["result"] });
    const calls = stubFetch(() => okResp());

    await seedInbox(db, { id: "inbox-odds", rawBody: '{"event":"odds_delta"}', eventType: "odds_delta", seq: 10 });
    const r1 = await runFanout(env, {
      eventType: "odds_delta",
      rawBody: '{"event":"odds_delta"}',
      qualityFlags: ["late"],
      meetingDate: "2026-10-07",
      inboxId: "inbox-odds",
      seq: 10,
    });
    expect(r1.attempted).toBe(1);
    expect(r1.delivered).toBe(1);
    expect(r1.skipped.map((s) => s.reason)).toEqual(["event_filter"]);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://all.example/hook");
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers["X-Quality-Flags"]).toBe("late");

    await seedInbox(db, { id: "inbox-result", rawBody: '{"event":"result"}', eventType: "result", seq: 11 });
    const r2 = await runFanout(env, {
      eventType: "result",
      rawBody: '{"event":"result"}',
      qualityFlags: [],
      meetingDate: "2026-10-07",
      inboxId: "inbox-result",
      seq: 11,
    });
    expect(r2.delivered).toBe(2);
  });

  it("signs the body when the subscriber has a secret", async () => {
    const db = await freshDb();
    const env = testEnv(db, fakeQueue());
    await createAgentSubscriber(env, { url: "https://signed.example/hook", secret: "shh" });
    const calls = stubFetch(() => okResp());
    await seedInbox(db, { id: "inbox-signed", rawBody: '{"event":"result"}' });
    await runFanout(env, {
      eventType: "result",
      rawBody: '{"event":"result"}',
      qualityFlags: [],
      meetingDate: "2026-10-07",
      inboxId: "inbox-signed",
      seq: null,
    });
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers["X-Signature"]).toMatch(/^[0-9a-f]{64}$/);
  });

  it("skips quiet hours and inactive raceday windows", async () => {
    const db = await freshDb();
    const env = testEnv(db, fakeQueue());
    await createAgentSubscriber(env, {
      url: "https://quiet.example/hook",
      quiet_start: "00:00",
      quiet_end: "08:00",
    });
    await createAgentSubscriber(env, {
      url: "https://race.example/hook",
      active_window: "raceday",
    });
    stubFetch(() => okResp());
    await seedInbox(db, { id: "inbox-day", rawBody: "{}" });
    // T0 = 12:00 HKT: not quiet, meeting is today → both deliver
    const r1 = await runFanout(env, {
      eventType: "result",
      rawBody: "{}",
      qualityFlags: [],
      meetingDate: "2026-10-07",
      inboxId: "inbox-day",
      seq: null,
    });
    expect(r1.delivered).toBe(2);
    // 02:00 HKT: quiet for the first; meeting date is yesterday for raceday check
    setClockForTest(() => Date.parse("2026-10-07T02:00:00+08:00"));
    await seedInbox(db, { id: "inbox-night", rawBody: "{}", meetingDate: "2026-10-06" });
    const r2 = await runFanout(env, {
      eventType: "result",
      rawBody: "{}",
      qualityFlags: [],
      meetingDate: "2026-10-06",
      inboxId: "inbox-night",
      seq: null,
    });
    expect(r2.delivered).toBe(0);
    expect(r2.skipped.map((s) => s.reason).sort()).toEqual(["active_window", "quiet_hours"]);
  });

  it("a failing subscriber never breaks the others or the caller", async () => {
    const db = await freshDb();
    const env = testEnv(db, fakeQueue(), { CIRCUIT_BREAKER_THRESHOLD: "100" });
    await createAgentSubscriber(env, { url: "https://bad.example/hook" });
    await createAgentSubscriber(env, { url: "https://good.example/hook" });
    const calls = stubFetch((url) => {
      if (url.includes("bad.example")) throw new Error("connection reset");
      return okResp();
    });
    await seedInbox(db, { id: "inbox-iso", rawBody: "{}" });
    const r = await runFanout(env, {
      eventType: "result",
      rawBody: "{}",
      qualityFlags: [],
      meetingDate: "2026-10-07",
      inboxId: "inbox-iso",
      seq: null,
    });
    expect(r.attempted).toBe(2);
    expect(r.delivered).toBe(1);
    expect(r.failed).toBe(1);
    expect(calls.map((c) => c.url).sort()).toEqual([
      "https://bad.example/hook",
      "https://good.example/hook",
    ]);
    const bad = await getAgentSubscriber(env, 1);
    expect(bad?.consecutive_failures).toBe(1);
  });

  it("does nothing when no subscribers exist", async () => {
    const db = await freshDb();
    const env = testEnv(db, fakeQueue());
    const r = await runFanout(env, {
      eventType: "result",
      rawBody: "{}",
      qualityFlags: [],
      meetingDate: "2026-10-07",
      inboxId: "inbox-none",
      seq: null,
    });
    expect(r).toEqual({ attempted: 0, delivered: 0, failed: 0, deferred: 0, skipped: [] });
  });

  it("stages pending synchronously and retries failed delivery with backoff", async () => {
    const db = await freshDb();
    const env = testEnv(db, fakeQueue(), { CIRCUIT_BREAKER_THRESHOLD: "100" });
    await createAgentSubscriber(env, { url: "https://flaky.example/hook" });
    let hits = 0;
    stubFetch(() => {
      hits += 1;
      if (hits === 1) return new Response("nope", { status: 500 });
      return okResp();
    });
    await seedInbox(db, { id: "inbox-retry", rawBody: '{"event":"odds_delta"}', eventType: "odds_delta", seq: 42 });

    const input = {
      eventType: "odds_delta",
      rawBody: '{"event":"odds_delta"}',
      qualityFlags: ["gap"],
      meetingDate: "2026-10-07",
      inboxId: "inbox-retry",
      seq: 42,
    };
    const staged = await stageFanoutPending(env, input);
    expect(staged).toBe(1);
    const pendingBefore = await db
      .prepare(`SELECT retry_count, next_attempt_at, last_error FROM agent_pending_forwards WHERE inbox_id = ?`)
      .bind("inbox-retry")
      .first<{ retry_count: number; next_attempt_at: string | null; last_error: string | null }>();
    expect(pendingBefore).toBeTruthy();

    const first = await fanoutToAgents(env, input);
    expect(first.failed).toBe(1);
    expect(first.delivered).toBe(0);

    const pendingAfter = await db
      .prepare(`SELECT retry_count, next_attempt_at, last_error FROM agent_pending_forwards WHERE inbox_id = ?`)
      .bind("inbox-retry")
      .first<{ retry_count: number; next_attempt_at: string | null; last_error: string | null }>();
    expect(pendingAfter?.retry_count).toBe(1);
    expect(pendingAfter?.next_attempt_at).toBeTruthy();
    expect(nextBackoffMinutes(1)).toBe(5);

    const attempts = await db
      .prepare(`SELECT outcome, attempt, http_status, latency_ms, seq FROM agent_delivery_attempts WHERE inbox_id = ? ORDER BY id`)
      .bind("inbox-retry")
      .all<{ outcome: string; attempt: number; http_status: number | null; latency_ms: number | null; seq: number | null }>();
    expect(attempts.results).toHaveLength(1);
    expect(attempts.results![0]).toMatchObject({
      outcome: "http_error",
      attempt: 1,
      http_status: 500,
      seq: 42,
    });
    expect(typeof attempts.results![0].latency_ms).toBe("number");

    // Advance past backoff and flush via cron path.
    setClockForTest(() => T0 + 6 * 60_000);
    const flush = await flushPendingForwards(env);
    expect(flush.delivered).toBe(1);
    expect(hits).toBe(2);
    const leftover = await db
      .prepare(`SELECT COUNT(*) AS n FROM agent_pending_forwards WHERE inbox_id = ?`)
      .bind("inbox-retry")
      .first<{ n: number }>();
    expect(leftover?.n).toBe(0);
    const successLog = await db
      .prepare(`SELECT outcome FROM agent_delivery_attempts WHERE inbox_id = ? AND outcome = 'success'`)
      .bind("inbox-retry")
      .first<{ outcome: string }>();
    expect(successLog?.outcome).toBe("success");
  });

  it("flushes pending ordered by seq ascending", async () => {
    const db = await freshDb();
    const env = testEnv(db, fakeQueue());
    await createAgentSubscriber(env, { url: "https://ordered.example/hook" });
    const seen: number[] = [];
    stubFetch((_url, init) => {
      const body = String(init.body);
      const m = /"seq":(\d+)/.exec(body);
      if (m) seen.push(Number(m[1]));
      return okResp();
    });

    for (const seq of [30, 10, 20]) {
      const id = `inbox-seq-${seq}`;
      const raw = JSON.stringify({ event: "odds_delta", seq });
      await seedInbox(db, { id, rawBody: raw, eventType: "odds_delta", seq });
      await stageFanoutPending(env, {
        eventType: "odds_delta",
        rawBody: raw,
        qualityFlags: [],
        meetingDate: "2026-10-07",
        inboxId: id,
        seq,
      });
    }

    // Do not call per-inbox fanout — flush globally so ordering is exercised.
    const flush = await flushPendingForwards(env, { limit: 10 });
    expect(flush.delivered).toBe(3);
    expect(seen).toEqual([10, 20, 30]);
  });
});

describe("admin HTTP handlers", () => {
  it("requires the Bearer token", async () => {
    const db = await freshDb();
    const env = testEnv(db, fakeQueue());
    const noAuth = await handleListAgentSubscribers(
      new Request("https://x/v1/admin/agent-subscribers"),
      env,
    );
    expect(noAuth.status).toBe(401);

    const envNoToken = testEnv(db, fakeQueue(), { RUNNER_API_TOKEN: undefined });
    const unconfigured = await handleListAgentSubscribers(authed(undefined, "GET"), envNoToken);
    expect(unconfigured.status).toBe(500);
  });

  it("round-trips CRUD over HTTP and maps errors to status codes", async () => {
    const db = await freshDb();
    const env = testEnv(db, fakeQueue());

    const bad = await handleCreateAgentSubscriber(authed({ url: "nope" }), env);
    expect(bad.status).toBe(400);

    const created = await handleCreateAgentSubscriber(
      authed({ url: "https://http.example/hook", event_filter: ["result"] }),
      env,
    );
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as { subscriber: { id: number; has_secret: boolean } };
    expect(createdBody.subscriber.has_secret).toBe(false);
    const id = createdBody.subscriber.id;

    const dup = await handleCreateAgentSubscriber(authed({ url: "https://http.example/hook" }), env);
    expect(dup.status).toBe(409);

    const listed = await handleListAgentSubscribers(authed(undefined, "GET"), env);
    expect(listed.status).toBe(200);
    expect(((await listed.json()) as { subscribers: unknown[] }).subscribers).toHaveLength(1);

    const one = await handleGetAgentSubscriber(authed(undefined, "GET"), env, id);
    expect(one.status).toBe(200);
    const missing = await handleGetAgentSubscriber(authed(undefined, "GET"), env, 9999);
    expect(missing.status).toBe(404);

    const patched = await handleUpdateAgentSubscriber(authed({ enabled: false }), env, id);
    expect(patched.status).toBe(200);
    expect(((await patched.json()) as { subscriber: { enabled: boolean } }).subscriber.enabled).toBe(false);

    const badPatch = await handleUpdateAgentSubscriber(authed({ url: "bad" }), env, id);
    expect(badPatch.status).toBe(400);

    const deleted = await handleDeleteAgentSubscriber(authed(undefined, "DELETE"), env, id);
    expect(deleted.status).toBe(200);
    const gone = await handleGetAgentSubscriber(authed(undefined, "GET"), env, id);
    expect(gone.status).toBe(404);
  });
});
