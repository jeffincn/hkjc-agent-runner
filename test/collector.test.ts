import { describe, expect, it, vi } from "vitest";
import { collectWorker, safeRedirectLocation } from "../src/collector";
import worker from "../src/index";
import type { Env } from "../src/env";
import { fakeQueue, freshDb, testEnv } from "./helpers";

const API_BASE = "https://hkjc.cf-connect.top";
const TOKEN = "collector-test-token-do-not-leak";

function hktToday(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Hong_Kong",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function envFor(db: D1Database, options: Record<string, string | undefined> = {}): Env {
  // Keep these collector-only settings usable while the main agent extends Env.
  return Object.assign(testEnv(db, fakeQueue()), {
    HKJC_COLLECT_ENABLED: "true",
    HKJC_API_BASE: API_BASE,
    HKJC_API_TOKEN: TOKEN,
    ...options,
  }) as Env;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function event(date: string, venue: "ST" | "HV", seq: number, eventId = `event-${seq}`) {
  return {
    schema: "hkjc-push/1.1",
    event: "odds_delta",
    event_id: eventId,
    seq,
    meeting_date: date,
    venue,
    races: [],
  };
}

function meetings(rows: { date: string; venue: "ST" | "HV" }[]): Response {
  return json({ meetings: rows.map(({ date, venue }) => ({ meeting_date: date, venue })) });
}

async function eventRows(db: D1Database): Promise<Record<string, unknown>[]> {
  const result = await db.prepare(
    "SELECT event_id, meeting_date, venue, seq, raw_body FROM collection_events ORDER BY meeting_date, venue, seq",
  ).all<Record<string, unknown>>();
  return result.results;
}

async function cursorRows(db: D1Database): Promise<Record<string, unknown>[]> {
  const result = await db.prepare(
    "SELECT meeting_date, venue, last_seq FROM collection_cursors ORDER BY meeting_date, venue",
  ).all<Record<string, unknown>>();
  return result.results;
}

function routeFetch(handler: (url: URL, init?: RequestInit) => Response | Promise<Response>) {
  const requests: { url: URL; init?: RequestInit }[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    requests.push({ url, init });
    return handler(url, init);
  }) as unknown as typeof fetch;
  return { fetchImpl, requests };
}

describe("collectWorker", () => {
  it("is disabled by default and returns without making a request", async () => {
    const db = await freshDb();
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const result = await collectWorker(testEnv(db, fakeQueue()), fetchImpl);

    expect(result.skipped).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await eventRows(db)).toEqual([]);
  });

  it.each([
    ["untrusted host", "https://hkjc.cf-connect.top.attacker.invalid"],
    ["different origin", "https://example.invalid"],
    ["HTTP", "http://hkjc.cf-connect.top"],
    ["credentials in URL", "https://user@hkjc.cf-connect.top"],
  ])("rejects an unsafe API base (%s) without fetching", async (_label, base) => {
    const db = await freshDb();
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    await expect(collectWorker(envFor(db, { HKJC_API_BASE: base }), fetchImpl)).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("requires a non-empty token and accepts the pinned origin with a trailing slash", async () => {
    const db = await freshDb();
    const missingTokenFetch = vi.fn() as unknown as typeof fetch;
    await expect(collectWorker(envFor(db, { HKJC_API_TOKEN: "  " }), missingTokenFetch)).rejects.toThrow();
    expect(missingTokenFetch).not.toHaveBeenCalled();

    const { fetchImpl, requests } = routeFetch((url) => {
      if (url.pathname === "/v1/meetings") return meetings([]);
      return json({ events: [] });
    });
    const result = await collectWorker(
      envFor(db, { HKJC_API_BASE: `${API_BASE}/`, HKJC_COLLECT_MAX_REQUESTS: "1" }),
      fetchImpl,
    );
    expect(result.skipped).toBe(false);
    expect(requests).toHaveLength(1);
    expect(requests[0].url.origin).toBe(API_BASE);
    expect(requests[0].url.pathname).toBe("/v1/meetings");
    const headers = new Headers(requests[0].init?.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(headers.get("user-agent")).toBeTruthy();
  });

  it("paginates with limit=20, a monotonic cursor, and persists each validated page", async () => {
    const db = await freshDb();
    const date = hktToday();
    const firstPage = Array.from({ length: 20 }, (_, i) => event(date, "HV", i + 1));
    const { fetchImpl, requests } = routeFetch((url) => {
      if (url.pathname === "/v1/meetings") return meetings([{ date, venue: "HV" }]);
      if (url.pathname === "/v1/events") {
        const cursor = Number(url.searchParams.get("since_seq"));
        expect(url.searchParams.get("meeting_date")).toBe(date);
        expect(url.searchParams.get("venue")).toBe("HV");
        expect(url.searchParams.get("limit")).toBe("20");
        return json({ events: cursor === 0 ? firstPage : [event(date, "HV", 21)] });
      }
      throw new Error(`unexpected route ${url.pathname}`);
    });

    const result = await collectWorker(
      envFor(db, { HKJC_COLLECT_MAX_REQUESTS: "3" }),
      fetchImpl,
    );

    expect(result.skipped).toBe(false);
    expect(result.requests).toBe(3);
    expect(requests.map((r) => r.url.pathname)).toEqual([
      "/v1/meetings",
      "/v1/events",
      "/v1/events",
    ]);
    expect(requests[1].url.searchParams.get("since_seq")).toBe("0");
    expect(requests[2].url.searchParams.get("since_seq")).toBe("20");
    expect(await db.prepare("SELECT COUNT(*) AS n FROM collection_events").first("n")).toBe(21);
    expect(await cursorRows(db)).toEqual([{ meeting_date: date, venue: "HV", last_seq: 21 }]);
  });

  it("stops on a short page when next_since_seq is absent (legacy worker)", async () => {
    const db = await freshDb();
    const date = hktToday();
    const legacy = (await import("./fixtures/events_page_legacy.json")).default;
    const pageEvents = (legacy.response.events as ReturnType<typeof event>[]).map((row, i) =>
      event(date, "HV", i + 1, row.event_id),
    );
    const { fetchImpl, requests } = routeFetch((url) => {
      if (url.pathname === "/v1/meetings") return meetings([{ date, venue: "HV" }]);
      if (url.pathname === "/v1/events") {
        expect(url.searchParams.get("limit")).toBe("20");
        expect(url.searchParams.has("next_since_seq")).toBe(false);
        return json({ events: pageEvents });
      }
      if (url.pathname === "/v1/races") return json({ races: [] });
      if (url.pathname === "/v1/results") return json({ results: [] });
      throw new Error(`unexpected route ${url.pathname}`);
    });

    const result = await collectWorker(envFor(db, { HKJC_COLLECT_MAX_REQUESTS: "4" }), fetchImpl);

    expect(requests.filter((r) => r.url.pathname === "/v1/events")).toHaveLength(1);
    expect(result.events).toBe(2);
    expect(await cursorRows(db)).toEqual([{ meeting_date: date, venue: "HV", last_seq: 2 }]);
  });

  it("continues with next_since_seq when truncated_by_bytes is set", async () => {
    const db = await freshDb();
    const date = hktToday();
    const truncated = (await import("./fixtures/events_page_truncated.json")).default;
    const firstEvents = (truncated.response.events as { event_id: string; seq: number }[]).map((row) =>
      event(date, "ST", row.seq, row.event_id),
    );
    const seenSince: string[] = [];
    const { fetchImpl, requests } = routeFetch((url) => {
      if (url.pathname === "/v1/meetings") return meetings([{ date, venue: "ST" }]);
      if (url.pathname === "/v1/events") {
        expect(url.searchParams.get("limit")).toBe("20");
        const since = url.searchParams.get("since_seq")!;
        seenSince.push(since);
        if (since === "0") {
          return json({
            events: firstEvents,
            truncated_by_bytes: true,
            next_since_seq: truncated.response.next_since_seq,
          });
        }
        if (since === String(truncated.response.next_since_seq)) {
          return json({ events: [event(date, "ST", 14, "00000000-0000-4000-8000-000000000204")] });
        }
        throw new Error(`unexpected since_seq ${since}`);
      }
      if (url.pathname === "/v1/races") return json({ races: [] });
      if (url.pathname === "/v1/results") return json({ results: [] });
      throw new Error(`unexpected route ${url.pathname}`);
    });

    const result = await collectWorker(envFor(db, { HKJC_COLLECT_MAX_REQUESTS: "4" }), fetchImpl);

    expect(seenSince).toEqual(["0", "13"]);
    expect(requests.filter((r) => r.url.pathname === "/v1/events")).toHaveLength(2);
    expect(result.events).toBe(4);
    expect(await cursorRows(db)).toEqual([{ meeting_date: date, venue: "ST", last_seq: 14 }]);
  });

  it("resumes from the persisted cursor on the next cron run", async () => {
    const db = await freshDb();
    const date = hktToday();
    let round = 0;
    const { fetchImpl, requests } = routeFetch((url) => {
      if (url.pathname === "/v1/meetings") return meetings([{ date, venue: "ST" }]);
      if (url.pathname === "/v1/events") {
        const since = Number(url.searchParams.get("since_seq"));
        expect(url.searchParams.get("limit")).toBe("20");
        if (round === 0) {
          return json({
            events: Array.from({ length: 20 }, (_, i) => event(date, "ST", since + i + 1)),
          });
        }
        return json({ events: [event(date, "ST", since + 1)] });
      }
      if (url.pathname === "/v1/races") return json({ races: [] });
      if (url.pathname === "/v1/results") return json({ results: [] });
      throw new Error(`unexpected route ${url.pathname}`);
    });
    const env = envFor(db, { HKJC_COLLECT_MAX_REQUESTS: "2" });

    const first = await collectWorker(env, fetchImpl);
    expect(first.events).toBe(20);
    expect(await cursorRows(db)).toEqual([{ meeting_date: date, venue: "ST", last_seq: 20 }]);

    round = 1;
    const second = await collectWorker(env, fetchImpl);
    expect(second.events).toBe(1);
    const eventCalls = requests.filter((r) => r.url.pathname === "/v1/events");
    expect(eventCalls[0].url.searchParams.get("since_seq")).toBe("0");
    expect(eventCalls[1].url.searchParams.get("since_seq")).toBe("20");
    expect(await cursorRows(db)).toEqual([{ meeting_date: date, venue: "ST", last_seq: 21 }]);
  });

  it("treats a replayed event_id idempotently while validating and advancing its cursor", async () => {
    const db = await freshDb();
    const date = hktToday();
    const { fetchImpl } = routeFetch((url) => {
      if (url.pathname === "/v1/meetings") return meetings([{ date, venue: "ST" }]);
      if (url.pathname === "/v1/events") {
        return json({ events: [event(date, "ST", 1, "stable-event-id")] });
      }
      // The collector may archive documents when the request budget permits.
      if (url.pathname === "/v1/races" || url.pathname === "/v1/results") return json({ races: [], results: [] });
      throw new Error(`unexpected route ${url.pathname}`);
    });
    const env = envFor(db, { HKJC_COLLECT_MAX_REQUESTS: "2" });

    await collectWorker(env, fetchImpl);
    await db.prepare("DELETE FROM collection_cursors WHERE meeting_date = ? AND venue = 'ST'").bind(date).run();
    await collectWorker(env, fetchImpl);

    expect(await eventRows(db)).toHaveLength(1);
    expect(await eventRows(db)).toMatchObject([
      { event_id: "stable-event-id", meeting_date: date, venue: "ST", seq: 1 },
    ]);
    expect(await cursorRows(db)).toEqual([{ meeting_date: date, venue: "ST", last_seq: 1 }]);
  });

  it("does not persist any part of a malformed page or advance its cursor", async () => {
    const db = await freshDb();
    const date = hktToday();
    const { fetchImpl } = routeFetch((url) => {
      if (url.pathname === "/v1/meetings") return meetings([{ date, venue: "HV" }]);
      if (url.pathname === "/v1/events") {
        return json({ events: [event(date, "HV", 1), event(date, "ST", 2)] });
      }
      throw new Error(`unexpected route ${url.pathname}`);
    });

    await expect(collectWorker(envFor(db, { HKJC_COLLECT_MAX_REQUESTS: "2" }), fetchImpl)).rejects.toThrow();
    expect(await eventRows(db)).toEqual([]);
    expect(await cursorRows(db)).toEqual([]);
  });

  it.each(["declared content length", "streamed body length"])("rejects oversized event responses by %s without advancing state", async (sizeCase) => {
    const db = await freshDb();
    const date = hktToday();
    const { fetchImpl } = routeFetch((url) => {
      if (url.pathname === "/v1/meetings") return meetings([{ date, venue: "HV" }]);
      if (url.pathname === "/v1/events") {
        const body = sizeCase === "declared content length" ? "{}" : "x".repeat(1_500_001);
        return new Response(body, {
          status: 200,
          headers: sizeCase === "declared content length" ? { "Content-Length": "1500001" } : {},
        });
      }
      throw new Error(`unexpected route ${url.pathname}`);
    });

    await expect(collectWorker(envFor(db, { HKJC_COLLECT_MAX_REQUESTS: "2" }), fetchImpl)).rejects.toThrow();
    expect(await eventRows(db)).toEqual([]);
    expect(await cursorRows(db)).toEqual([]);
  });

  it("surfaces safe HTTP errors without storing the response body or disclosing the token", async () => {
    const db = await freshDb();
    const date = hktToday();
    const secretResponse = `upstream-private-body-${TOKEN}`;
    const { fetchImpl } = routeFetch((url) => {
      if (url.pathname === "/v1/meetings") return meetings([{ date, venue: "HV" }]);
      return new Response(secretResponse, { status: 403 });
    });

    let message = "";
    try {
      await collectWorker(envFor(db, { HKJC_COLLECT_MAX_REQUESTS: "2" }), fetchImpl);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toBe("collector: source request failed (403)");
    expect(message).not.toContain(TOKEN);
    expect(message).not.toContain(secretResponse);
    expect(await eventRows(db)).toEqual([]);
    const storedDocuments = await db.prepare("SELECT raw_body FROM collection_documents").all<{ raw_body: string }>();
    expect(JSON.stringify(storedDocuments.results)).not.toContain(secretResponse);
    expect(JSON.stringify(storedDocuments.results)).not.toContain(TOKEN);
    const meta = await db.prepare(
      `SELECT value FROM runner_meta WHERE key = 'last_collection_error'`,
    ).first<{ value: string }>();
    expect(meta).toBeTruthy();
    const recorded = JSON.parse(meta!.value) as { reason: string; at: string; path: string };
    expect(recorded.reason).toBe("403");
    expect(recorded.path).toBe("fallback");
    expect(recorded.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(JSON.stringify(recorded)).not.toContain(TOKEN);
    expect(JSON.stringify(recorded)).not.toContain(secretResponse);
  });

  it("uses HKJC_WORKER service binding when present and skips global fetch", async () => {
    const db = await freshDb();
    const date = hktToday();
    const bindingFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if (url.pathname === "/v1/meetings") return meetings([]);
      throw new Error(`unexpected ${url.pathname}`);
    });
    const globalFetch = vi.fn(async () => {
      throw new Error("global fetch must not be used when binding exists");
    }) as unknown as typeof fetch;
    const env = envFor(db, { HKJC_COLLECT_MAX_REQUESTS: "1" });
    env.HKJC_WORKER = { fetch: bindingFetch } as Fetcher;

    const result = await collectWorker(env, globalFetch);

    expect(result.skipped).toBe(false);
    expect(result.requests).toBe(1);
    expect(bindingFetch).toHaveBeenCalledTimes(1);
    expect(globalFetch).not.toHaveBeenCalled();
    const call = bindingFetch.mock.calls[0];
    const calledUrl = new URL(String(call[0]));
    expect(calledUrl.origin).toBe(API_BASE);
    expect(calledUrl.pathname).toBe("/v1/meetings");
    const headers = new Headers(call[1]?.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(call[1]?.redirect).toBe("manual");
  });

  it("falls back to global fetch when HKJC_WORKER binding is absent", async () => {
    const db = await freshDb();
    const { fetchImpl, requests } = routeFetch((url) => {
      if (url.pathname === "/v1/meetings") return meetings([]);
      throw new Error(`unexpected ${url.pathname}`);
    });
    const env = envFor(db, { HKJC_COLLECT_MAX_REQUESTS: "1" });
    expect(env.HKJC_WORKER).toBeUndefined();

    const result = await collectWorker(env, fetchImpl);

    expect(result.skipped).toBe(false);
    expect(result.requests).toBe(1);
    expect(requests).toHaveLength(1);
    expect(requests[0].url.pathname).toBe("/v1/meetings");
    expect(requests[0].init?.redirect).toBe("manual");
  });

  it.each([
    ["size", () => new Response("{}", { status: 200, headers: { "Content-Length": "1500001" } }), "size"],
    ["timeout", () => {
      const err = new Error("The operation was aborted due to timeout");
      err.name = "TimeoutError";
      throw err;
    }, "timeout"],
    ["network", () => {
      throw new TypeError("fetch failed");
    }, "network"],
    ["json", () => new Response("not-json{", { status: 200, headers: { "Content-Type": "application/json" } }), "json"],
  ] as const)("records last_collection_error reason %s without leaking secrets", async (_label, respond, reason) => {
    const db = await freshDb();
    const { fetchImpl } = routeFetch((url) => {
      if (url.pathname === "/v1/meetings") {
        const out = respond();
        return out;
      }
      throw new Error(`unexpected ${url.pathname}`);
    });

    await expect(collectWorker(envFor(db, { HKJC_COLLECT_MAX_REQUESTS: "1" }), fetchImpl))
      .rejects.toThrow(`collector: source request failed (${reason})`);

    const meta = await db.prepare(
      `SELECT value FROM runner_meta WHERE key = 'last_collection_error'`,
    ).first<{ value: string }>();
    expect(JSON.parse(meta!.value)).toMatchObject({ reason, path: "fallback" });
    expect(meta!.value).not.toContain(TOKEN);
  });

  it("records redirect status, sanitized location, and fetch path without following", async () => {
    const db = await freshDb();
    const secretQuery = `token=${TOKEN}&next=/admin`;
    let followed = false;
    const { fetchImpl, requests } = routeFetch((url) => {
      if (url.pathname === "/v1/meetings") {
        return new Response(null, {
          status: 302,
          headers: {
            Location: `https://login.example.invalid/callback?${secretQuery}#frag`,
            "Set-Cookie": `session=${TOKEN}`,
          },
        });
      }
      followed = true;
      throw new Error(`must not follow redirect to ${url.href}`);
    });

    await expect(collectWorker(envFor(db, { HKJC_COLLECT_MAX_REQUESTS: "1" }), fetchImpl))
      .rejects.toThrow("collector: source request failed (redirect)");

    expect(followed).toBe(false);
    expect(requests).toHaveLength(1);
    expect(requests[0].init?.redirect).toBe("manual");

    const meta = await db.prepare(
      `SELECT value FROM runner_meta WHERE key = 'last_collection_error'`,
    ).first<{ value: string }>();
    const recorded = JSON.parse(meta!.value) as {
      reason: string; path: string; status: number; location: string | null; at: string;
    };
    expect(recorded).toMatchObject({
      reason: "redirect",
      path: "fallback",
      status: 302,
      location: "https://login.example.invalid/callback",
    });
    expect(recorded.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(meta!.value).not.toContain(TOKEN);
    expect(meta!.value).not.toContain(secretQuery);
    expect(meta!.value).not.toContain("Set-Cookie");
    expect(meta!.value).not.toContain("#frag");
  });

  it("records path=binding when a service-bound fetch returns 3xx", async () => {
    const db = await freshDb();
    const bindingFetch = vi.fn(async () => new Response(null, {
      status: 307,
      headers: { Location: "https://hkjc.cf-connect.top/v1/meetings/" },
    }));
    const env = envFor(db, { HKJC_COLLECT_MAX_REQUESTS: "1" });
    env.HKJC_WORKER = { fetch: bindingFetch } as Fetcher;

    await expect(collectWorker(env, vi.fn() as unknown as typeof fetch))
      .rejects.toThrow("collector: source request failed (redirect)");

    const meta = await db.prepare(
      `SELECT value FROM runner_meta WHERE key = 'last_collection_error'`,
    ).first<{ value: string }>();
    expect(JSON.parse(meta!.value)).toMatchObject({
      reason: "redirect",
      path: "binding",
      status: 307,
      location: "https://hkjc.cf-connect.top/v1/meetings/",
    });
    expect(bindingFetch).toHaveBeenCalledTimes(1);
    expect(bindingFetch.mock.calls[0][1]?.redirect).toBe("manual");
  });

  it("exposes last_collection_error and collector_binding_present on /health", async () => {
    const db = await freshDb();
    const { fetchImpl } = routeFetch(() => new Response("nope", { status: 502 }));
    await expect(collectWorker(envFor(db, { HKJC_COLLECT_MAX_REQUESTS: "1" }), fetchImpl))
      .rejects.toThrow("collector: source request failed (502)");

    const withoutBinding = envFor(db);
    const health = await (await import("../src/http")).handleHealth(withoutBinding);
    const body = await health.json() as {
      last_collection_error: string | null;
      last_collection_ok: string | null;
      collector_binding_present: boolean;
    };
    expect(body.last_collection_ok).toBeNull();
    expect(JSON.parse(body.last_collection_error!)).toMatchObject({ reason: "502", path: "fallback" });
    expect(body.collector_binding_present).toBe(false);

    withoutBinding.HKJC_WORKER = { fetch: vi.fn() } as Fetcher;
    const withBinding = await (await import("../src/http")).handleHealth(withoutBinding);
    expect((await withBinding.json() as { collector_binding_present: boolean }).collector_binding_present).toBe(true);
  });

  describe("safeRedirectLocation", () => {
    it("keeps scheme+host+pathname and strips query, fragment, and userinfo", () => {
      expect(safeRedirectLocation("https://user:pass@ex.ample:8443/a/b?x=1#y"))
        .toBe("https://ex.ample:8443/a/b");
      expect(safeRedirectLocation("/rel?tok=secret", "https://hkjc.cf-connect.top"))
        .toBe("https://hkjc.cf-connect.top/rel");
    });

    it("returns null for missing, non-http, or unparsable values", () => {
      expect(safeRedirectLocation(null)).toBeNull();
      expect(safeRedirectLocation("")).toBeNull();
      expect(safeRedirectLocation("javascript:alert(1)")).toBeNull();
      expect(safeRedirectLocation("http://[bad")).toBeNull();
    });
  });

  it("keeps date/venue cursors isolated", async () => {
    const db = await freshDb();
    const date = hktToday();
    const nextDate = new Date(`${date}T12:00:00+08:00`);
    nextDate.setDate(nextDate.getDate() + 1);
    const nextDateString = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Hong_Kong", year: "numeric", month: "2-digit", day: "2-digit",
    }).format(nextDate);
    const rows = [{ date, venue: "ST" as const }, { date: nextDateString, venue: "HV" as const }];
    const { fetchImpl, requests } = routeFetch((url) => {
      if (url.pathname === "/v1/meetings") return meetings(rows);
      if (url.pathname === "/v1/events") {
        const meetingDate = url.searchParams.get("meeting_date")!;
        const venue = url.searchParams.get("venue") as "ST" | "HV";
        return json({ events: [event(meetingDate, venue, 1, `identity-${meetingDate}-${venue}`)] });
      }
      if (url.pathname === "/v1/races") return json({ races: [] });
      if (url.pathname === "/v1/results") return json({ results: [] });
      throw new Error(`unexpected route ${url.pathname}`);
    });

    await collectWorker(envFor(db, { HKJC_COLLECT_MAX_REQUESTS: "7" }), fetchImpl);

    expect(requests.filter((r) => r.url.pathname === "/v1/events")).toHaveLength(2);
    expect(requests.filter((r) => r.url.pathname === "/v1/races" || r.url.pathname === "/v1/results")).toHaveLength(4);
    expect(await cursorRows(db)).toEqual([
      { meeting_date: date, venue: "ST", last_seq: 1 },
      { meeting_date: nextDateString, venue: "HV", last_seq: 1 },
    ]);
    expect(await eventRows(db)).toHaveLength(2);
  });

  it("prevents overlapping collectors with the database lock and releases it afterward", async () => {
    const db = await freshDb();
    const date = hktToday();
    let enteredEvents!: () => void;
    let releaseEvents!: () => void;
    const eventRequestStarted = new Promise<void>((resolve) => { enteredEvents = resolve; });
    const waitForRelease = new Promise<void>((resolve) => { releaseEvents = resolve; });
    let blockedOnce = false;
    const { fetchImpl } = routeFetch(async (url) => {
      if (url.pathname === "/v1/meetings") return meetings([{ date, venue: "HV" }]);
      if (url.pathname === "/v1/events") {
        if (!blockedOnce) {
          blockedOnce = true;
          enteredEvents();
          await waitForRelease;
        }
        return json({ events: [] });
      }
      throw new Error(`unexpected route ${url.pathname}`);
    });
    const env = envFor(db, { HKJC_COLLECT_MAX_REQUESTS: "2" });
    const first = collectWorker(env, fetchImpl);
    await eventRequestStarted;
    const second = await collectWorker(env, fetchImpl);
    expect(second.skipped).toBe(true);
    releaseEvents();
    expect((await first).skipped).toBe(false);
    const lock = await db.prepare("SELECT owner, lease_until FROM collection_lock WHERE id = 1").first<{ owner: string | null; lease_until: number | null }>();
    expect(!lock || lock.owner === null || lock.owner === "").toBe(true);
  });

  it("rolls back a conflicting event identity and cursor update atomically", async () => {
    const db = await freshDb();
    const date = hktToday();
    let changedIdentity = false;
    const { fetchImpl } = routeFetch((url) => {
      if (url.pathname === "/v1/meetings") return meetings([{ date, venue: "HV" }]);
      if (url.pathname === "/v1/events") {
        return json({ events: [event(date, "HV", changedIdentity ? 2 : 1, "immutable-event-id")] });
      }
      throw new Error(`unexpected route ${url.pathname}`);
    });
    const env = envFor(db, { HKJC_COLLECT_MAX_REQUESTS: "2" });

    await collectWorker(env, fetchImpl);
    changedIdentity = true;
    await expect(collectWorker(env, fetchImpl)).rejects.toThrow();

    expect(await eventRows(db)).toMatchObject([
      { event_id: "immutable-event-id", meeting_date: date, venue: "HV", seq: 1 },
    ]);
    expect(await cursorRows(db)).toEqual([{ meeting_date: date, venue: "HV", last_seq: 1 }]);
  });

  it("archives upstream documents without queuing work or writing to the outbox", async () => {
    const db = await freshDb();
    const queue = fakeQueue();
    const env = Object.assign(testEnv(db, queue), {
      HKJC_COLLECT_ENABLED: "true",
      HKJC_API_BASE: API_BASE,
      HKJC_API_TOKEN: TOKEN,
      HKJC_COLLECT_MAX_REQUESTS: "4",
    }) as Env;
    const { fetchImpl } = routeFetch((url) => {
      if (url.pathname === "/v1/meetings") return meetings([{ date: hktToday(), venue: "ST" }]);
      if (url.pathname === "/v1/events") return json({ events: [] });
      if (url.pathname === "/v1/races") return json({ races: [] });
      if (url.pathname === "/v1/results") return json({ results: [] });
      throw new Error(`unexpected route ${url.pathname}`);
    });

    const result = await collectWorker(env, fetchImpl);

    expect(result.requests).toBe(4);
    const docs = await db.prepare("SELECT kind FROM collection_documents ORDER BY kind").all<{ kind: string }>();
    expect(docs.results.map((row) => row.kind)).toEqual(["meetings", "races", "results"]);
    expect(queue.sent).toEqual([]);
    expect(await db.prepare("SELECT COUNT(*) AS n FROM outbox").first("n")).toBe(0);
  });

  it("continues scheduled outbox dispatch even if the collection source rejects", async () => {
    const db = await freshDb();
    const queue = fakeQueue();
    const env = Object.assign(testEnv(db, queue), {
      HKJC_COLLECT_ENABLED: "true",
      HKJC_API_BASE: API_BASE,
      HKJC_API_TOKEN: TOKEN,
      HKJC_COLLECT_MAX_REQUESTS: "1",
    }) as Env;
    await db.prepare(`INSERT INTO inbox_events
      (id,dedupe_key,dedupe_source,event_type,raw_body,received_at,signature_status,status,updated_at)
      VALUES ('scheduled-inbox','scheduled-key','derived','test','{}',datetime('now'),'not_configured','queued',datetime('now'))`).run();
    await db.prepare(`INSERT INTO outbox (id,inbox_id,status,next_attempt_at,created_at)
      VALUES ('scheduled-outbox','scheduled-inbox','pending',datetime('now'),datetime('now'))`).run();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("private source error", { status: 403 })));
    const jobs: Promise<unknown>[] = [];
    const ctx = {
      waitUntil: (promise: Promise<unknown>) => { jobs.push(promise); },
      passThroughOnException: () => undefined,
    } as ExecutionContext;

    try {
      await worker.scheduled({} as ScheduledEvent, env, ctx);
      // Three independent cron jobs: outbox dispatcher, fanout pending flush (PR #11),
      // and pull-only collection. A collection failure must not block the others.
      const results = await Promise.allSettled(jobs);
      expect(results).toHaveLength(3);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(2);
      expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
      expect(results.find((result) => result.status === "rejected")).toMatchObject({
        reason: expect.objectContaining({
          message: expect.stringMatching(/^collector: source request failed \(\d{3}\)$/),
        }),
      });
      expect(queue.sent).toEqual([{ body: { inbox_id: "scheduled-inbox" }, delay: undefined }]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("caps the request budget and exits without making archival requests after exhaustion", async () => {
    const db = await freshDb();
    const date = hktToday();
    const { fetchImpl, requests } = routeFetch((url) => {
      if (url.pathname === "/v1/meetings") return meetings([{ date, venue: "ST" }]);
      if (url.pathname === "/v1/events") {
        const cursor = Number(url.searchParams.get("since_seq"));
        expect(url.searchParams.get("limit")).toBe("20");
        return json({ events: Array.from({ length: 20 }, (_, i) => event(date, "ST", cursor + i + 1)) });
      }
      throw new Error(`budget should have stopped before ${url.pathname}`);
    });

    const result = await collectWorker(
      envFor(db, { HKJC_COLLECT_MAX_REQUESTS: "999" }),
      fetchImpl,
    );

    expect(result.requests).toBeLessThanOrEqual(40);
    expect(requests).toHaveLength(result.requests);
    expect(result.requests).toBe(40);
    expect(requests.every((request) => request.url.pathname === "/v1/events" || request.url.pathname === "/v1/meetings")).toBe(true);
    expect(await db.prepare("SELECT last_seq FROM collection_cursors WHERE meeting_date = ? AND venue = 'ST'").bind(date).first("last_seq")).toBe(39 * 20);
  });

  it("defaults to at most 20 source requests per cron run", async () => {
    const db = await freshDb();
    const date = hktToday();
    const { fetchImpl, requests } = routeFetch((url) => {
      if (url.pathname === "/v1/meetings") return meetings([{ date, venue: "ST" }]);
      if (url.pathname === "/v1/events") {
        const cursor = Number(url.searchParams.get("since_seq"));
        return json({ events: Array.from({ length: 20 }, (_, i) => event(date, "ST", cursor + i + 1)) });
      }
      throw new Error(`budget should have stopped before ${url.pathname}`);
    });

    const result = await collectWorker(envFor(db), fetchImpl);

    expect(result.requests).toBe(20);
    expect(requests).toHaveLength(20);
    expect(await cursorRows(db)).toEqual([{ meeting_date: date, venue: "ST", last_seq: 19 * 20 }]);
  });
});
