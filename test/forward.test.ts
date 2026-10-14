import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { allowDeliveryAttempt, getCircuitSnapshot } from "../src/circuit";
import { setClockForTest } from "../src/env";
import { fanOutAccepted, flushPendingForwards, setForwardFetchForTest } from "../src/forward";
import { handleAdminSubscribers } from "../src/http";
import { setRolesForTest } from "../src/roles";
import { createSubscriber, getSubscriber, listSubscribers } from "../src/subscribers";
import { handleWebhook } from "../src/webhook";
import { ctxOf, envelope, fakeQueue, freshDb, race, signed, testEnv, useFixtureRoles } from "./helpers";

beforeEach(() => {
  useFixtureRoles();
  setClockForTest(() => Date.parse("2026-10-07T12:00:05+08:00"));
});
afterEach(() => {
  setRolesForTest(null);
  setClockForTest(null);
  setForwardFetchForTest(null);
});

type Captured = { url: string; body: string; headers: Headers; atMs: number };

function capturingFetch(statusFor: (url: string) => number = () => 202): {
  fetchImpl: typeof fetch;
  hits: Captured[];
} {
  const hits: Captured[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const body = typeof init?.body === "string" ? init.body : "";
    const headers = new Headers(init?.headers);
    hits.push({ url, body, headers, atMs: Date.now() });
    const status = statusFor(url);
    return new Response(status >= 200 && status < 300 ? '{"ok":true}' : "err", { status });
  }) as typeof fetch;
  return { fetchImpl, hits };
}

describe("admin subscribers CRUD", () => {
  it("lists, creates, patches, deletes with RUNNER_API_TOKEN (never exposes secret)", async () => {
    const db = await freshDb();
    const env = testEnv(db, fakeQueue());
    const auth = { Authorization: "Bearer runner-token", "Content-Type": "application/json" };

    const denied = await handleAdminSubscribers(
      new Request("https://x/v1/admin/subscribers", { method: "GET" }),
      env,
    );
    expect(denied.status).toBe(401);

    const created = await handleAdminSubscribers(
      new Request("https://x/v1/admin/subscribers", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({
          url: "https://downstream.example/a",
          secret: "sub-secret",
          event_filter: [],
        }),
      }),
      env,
    );
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as {
      subscriber: { id: number; has_secret: boolean; secret?: string; event_filter: string[] };
    };
    expect(createdBody.subscriber.has_secret).toBe(true);
    expect(createdBody.subscriber.secret).toBeUndefined();
    expect(createdBody.subscriber.event_filter).toEqual([]);

    const listed = await handleAdminSubscribers(
      new Request("https://x/v1/admin/subscribers", { method: "GET", headers: auth }),
      env,
    );
    expect(listed.status).toBe(200);
    const listBody = (await listed.json()) as { subscribers: unknown[] };
    expect(listBody.subscribers).toHaveLength(1);

    const id = createdBody.subscriber.id;
    const patched = await handleAdminSubscribers(
      new Request(`https://x/v1/admin/subscribers/${id}`, {
        method: "PATCH",
        headers: auth,
        body: JSON.stringify({ enabled: false, event_filter: ["result"] }),
      }),
      env,
      String(id),
    );
    expect(patched.status).toBe(200);
    const patchBody = (await patched.json()) as {
      subscriber: { enabled: boolean; event_filter: string[] };
    };
    expect(patchBody.subscriber.enabled).toBe(false);
    expect(patchBody.subscriber.event_filter).toEqual(["result"]);

    const deleted = await handleAdminSubscribers(
      new Request(`https://x/v1/admin/subscribers/${id}`, { method: "DELETE", headers: auth }),
      env,
      String(id),
    );
    expect(deleted.status).toBe(200);
    expect(await listSubscribers(env)).toHaveLength(0);
  });
});

describe("A1 fan-out event_filter", () => {
  it("A=all receives odds_delta+result; B=result only receives result; forwards within 60s with 2xx", async () => {
    const db = await freshDb();
    const env = testEnv(db, fakeQueue());
    const a = await createSubscriber(env, {
      url: "https://downstream.example/a",
      event_filter: [],
    });
    const b = await createSubscriber(env, {
      url: "https://downstream.example/b",
      event_filter: ["result"],
    });

    const acceptMs = Date.now();
    const { fetchImpl, hits } = capturingFetch();
    setForwardFetchForTest(fetchImpl);

    const post = async (body: string) => {
      const { ctx, done } = ctxOf();
      const res = await handleWebhook(
        new Request("https://x/webhook", {
          method: "POST",
          headers: await signed("test-secret", body),
          body,
        }),
        env,
        ctx,
      );
      expect(res.status).toBe(202);
      await done();
      return res;
    };

    await post(
      envelope({
        event: "odds_delta",
        races: [],
        meta: { content_hash: "odds-delta-1" },
      }),
    );
    await post(
      envelope({
        event: "result",
        races: [race(1, "2026-10-07T19:00:00+08:00")],
        meta: { content_hash: "result-1" },
      }),
    );

    const aHits = hits.filter((h) => h.url === a.url);
    const bHits = hits.filter((h) => h.url === b.url);
    expect(aHits).toHaveLength(2);
    expect(bHits).toHaveLength(1);
    expect(JSON.parse(bHits[0]!.body).event).toBe("result");
    expect(JSON.parse(aHits[0]!.body).event).toBe("odds_delta");
    expect(JSON.parse(aHits[1]!.body).event).toBe("result");
    // Raw envelope forwarded unchanged
    expect(JSON.parse(aHits[0]!.body).schema).toBe("hkjc-push/1.0");
    expect(hits.every((h) => h.atMs - acceptMs < 60_000)).toBe(true);
  });
});

describe("A2 circuit isolation + backoff", () => {
  it("B returning 500 opens only B's circuit; A keeps receiving; B retries with backoff", async () => {
    const db = await freshDb();
    const env = testEnv(db, fakeQueue(), {
      CIRCUIT_BREAKER_THRESHOLD: "3",
      CIRCUIT_BREAKER_429_THRESHOLD: "3",
      CIRCUIT_HALF_OPEN_MS: "60000",
      // Avoid rate-limit deferral masking consecutive HTTP failures in this test.
      FORWARD_RATE_PER_SUB_PER_SEC: "100",
    });
    const a = await createSubscriber(env, { url: "https://downstream.example/a", event_filter: [] });
    const b = await createSubscriber(env, { url: "https://downstream.example/b", event_filter: [] });

    const { fetchImpl, hits } = capturingFetch((url) => (url.includes("/b") ? 500 : 202));
    setForwardFetchForTest(fetchImpl);

    for (let i = 0; i < 3; i++) {
      const body = envelope({
        event: "test",
        meta: { content_hash: `iso-${i}` },
      });
      const { ctx, done } = ctxOf();
      const res = await handleWebhook(
        new Request("https://x/webhook", {
          method: "POST",
          headers: await signed("test-secret", body),
          body,
        }),
        env,
        ctx,
      );
      expect(res.status).toBe(202);
      await done();
    }

    const snapA = await getCircuitSnapshot(env, a.id);
    const snapB = await getCircuitSnapshot(env, b.id);
    expect(snapA.circuit_state).toBe("closed");
    expect(snapB.circuit_state).toBe("open");
    expect(snapA.consecutive_failures).toBe(0);
    expect(snapB.consecutive_failures).toBeGreaterThanOrEqual(3);

    expect(hits.filter((h) => h.url === a.url).length).toBe(3);
    expect(hits.filter((h) => h.url === b.url).length).toBe(3);

    const pending = await db
      .prepare(`SELECT subscriber_id, next_attempt_at FROM agent_pending_forwards`)
      .all<{ subscriber_id: number; next_attempt_at: string | null }>();
    expect((pending.results ?? []).every((r) => r.subscriber_id === b.id)).toBe(true);
    expect((pending.results ?? []).length).toBeGreaterThan(0);
    expect((pending.results ?? []).every((r) => r.next_attempt_at != null)).toBe(true);

    hits.length = 0;
    const body4 = envelope({ event: "test", meta: { content_hash: "iso-4" } });
    const { ctx, done } = ctxOf();
    const res4 = await handleWebhook(
      new Request("https://x/webhook", {
        method: "POST",
        headers: await signed("test-secret", body4),
        body: body4,
      }),
      env,
      ctx,
    );
    expect(res4.status).toBe(202);
    await done();
    expect(hits.filter((h) => h.url === a.url)).toHaveLength(1);
    expect(hits.filter((h) => h.url === b.url)).toHaveLength(0);
    const gate = await allowDeliveryAttempt(env, b.id);
    expect(gate.allowed).toBe(false);

    await db
      .prepare(
        `UPDATE agent_subscribers SET circuit_opened_at = '2000-01-01T00:00:00.000Z' WHERE id = ?`,
      )
      .bind(b.id)
      .run();
    await db
      .prepare(`UPDATE agent_pending_forwards SET next_attempt_at = '2000-01-01T00:00:00.000Z'`)
      .run();

    const flush = await flushPendingForwards(env, { fetchImpl });
    expect(flush.attempted).toBeGreaterThan(0);
    const bAfter = await getSubscriber(env, b.id);
    expect(bAfter?.circuit_state).toBe("open");
  });
});

describe("A3 existing webhook path unchanged", () => {
  it("still 202s; fan-out failure does not break accept or inbox persistence", async () => {
    const db = await freshDb();
    const env = testEnv(db, fakeQueue());
    await createSubscriber(env, { url: "https://downstream.example/boom", event_filter: [] });
    setForwardFetchForTest((async () => {
      throw new Error("downstream down");
    }) as typeof fetch);

    const body = envelope({ event: "schedule", meeting_date: null, venue: null });
    const { ctx, done } = ctxOf();
    const res = await handleWebhook(
      new Request("https://x/webhook", {
        method: "POST",
        headers: await signed("test-secret", body),
        body,
      }),
      env,
      ctx,
    );
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ received: true });
    expect(res.headers.get("X-Inbox-Id")).toBeTruthy();
    await done();

    const pending = await db.prepare(`SELECT COUNT(*) AS n FROM agent_pending_forwards`).first<{ n: number }>();
    expect(pending?.n).toBe(1);
    const inbox = await db.prepare(`SELECT COUNT(*) AS n FROM inbox_events`).first<{ n: number }>();
    expect(inbox?.n).toBe(1);
  });
});

describe("X-Quality-Flags on forward", () => {
  it("attaches the same quality flags header used on the webhook response", async () => {
    const db = await freshDb();
    const env = testEnv(db, fakeQueue());
    await createSubscriber(env, { url: "https://downstream.example/qf", event_filter: [] });
    const { fetchImpl, hits } = capturingFetch();

    await fanOutAccepted(env, {
      inbox_id: "unused-on-happy-path",
      raw_body: envelope({ event: "test", meta: { content_hash: "qf-1" } }),
      event_type: "test",
      meeting_date: "2026-10-07",
      quality_flags: ["late", "gap"],
      fetchImpl,
    });

    expect(hits).toHaveLength(1);
    expect(hits[0]!.headers.get("X-Quality-Flags")).toBe("late,gap");
  });
});
