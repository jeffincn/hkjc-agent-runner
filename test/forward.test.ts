/**
 * Follow-up coverage after PR #7: migration 0001–0005 sequence, nullable
 * event_filter, and backward-compatible /v1/admin/subscribers alias.
 * Stale PR #6 forward/pending-queue tests were removed with src/forward.ts.
 */
import { readdirSync, readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Miniflare } from "miniflare";
import { setClockForTest } from "../src/env";
import { createAgentSubscriber } from "../src/agentSubscribers";
import { handleListAgentSubscribers } from "../src/http";
import worker from "../src/index";
import { fakeQueue, testEnv } from "./helpers";

const T0 = Date.parse("2026-10-07T12:00:00+08:00");

beforeEach(() => {
  setClockForTest(() => T0);
});
afterEach(() => {
  setClockForTest(null);
});

/** Split on ";" but keep CREATE TRIGGER ... BEGIN ... END; blocks whole. */
function splitSql(sql: string): string[] {
  const out: string[] = [];
  let buf = "";
  for (const part of sql.split(";")) {
    buf += part;
    const open = /\bBEGIN\b/i.test(buf) && !/\bEND\s*$/i.test(buf.trim());
    if (open) {
      buf += ";";
      continue;
    }
    if (buf.trim()) out.push(buf.trim());
    buf = "";
  }
  return out;
}

async function applyMigrationsInOrder(db: D1Database): Promise<void> {
  const dir = new URL("../migrations/", import.meta.url);
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  expect(files).toEqual([
    "0001_init.sql",
    "0002_push11_quality.sql",
    "0003_runner_id.sql",
    "0004_agent_subscribers.sql",
    "0005_agent_subscribers_rebuild.sql",
    "0006_fanout_reliable_delivery.sql",
  ]);
  for (const file of files) {
    const sql = readFileSync(new URL(file, dir), "utf8").replace(/--[^\n]*/g, "");
    for (const q of splitSql(sql)) await db.prepare(q).run();
  }
}

describe("migrations 0001–0006 sequence", () => {
  it("applies in order, restores pending forwards, and allows NULL event_filter", async () => {
    const mf = new Miniflare({
      modules: true,
      script: "export default { fetch() { return new Response('ok'); } }",
      d1Databases: ["DB"],
    });
    const db = await mf.getD1Database("DB");
    await applyMigrationsInOrder(db);

    const pending = await db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'agent_pending_forwards'`,
      )
      .first<{ name: string }>();
    expect(pending?.name).toBe("agent_pending_forwards");

    const attempts = await db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'agent_delivery_attempts'`,
      )
      .first<{ name: string }>();
    expect(attempts?.name).toBe("agent_delivery_attempts");

    const cols = await db.prepare(`PRAGMA table_info(agent_subscribers)`).all<{
      name: string;
      notnull: number;
      dflt_value: string | null;
    }>();
    const eventFilter = (cols.results ?? []).find((c) => c.name === "event_filter");
    expect(eventFilter).toBeDefined();
    expect(eventFilter!.notnull).toBe(0);

    const env = testEnv(db, fakeQueue());
    const row = await createAgentSubscriber(env, {
      url: "https://downstream.example/null-filter",
      // omit event_filter → stored as NULL (all events)
    });
    expect(row.event_filter).toBeNull();

    const stored = await db
      .prepare(`SELECT event_filter FROM agent_subscribers WHERE id = ?`)
      .bind(row.id)
      .first<{ event_filter: string | null }>();
    expect(stored?.event_filter).toBeNull();

    await mf.dispose();
  });
});

describe("admin path alias", () => {
  it("GET /v1/admin/subscribers and /v1/admin/agent-subscribers both return 200", async () => {
    const mf = new Miniflare({
      modules: true,
      script: "export default { fetch() { return new Response('ok'); } }",
      d1Databases: ["DB"],
    });
    const db = await mf.getD1Database("DB");
    await applyMigrationsInOrder(db);
    const env = testEnv(db, fakeQueue());
    await createAgentSubscriber(env, { url: "https://alias.example/hook" });

    const auth = { Authorization: "Bearer runner-token" };

    const viaNew = await handleListAgentSubscribers(
      new Request("https://x/v1/admin/agent-subscribers", { headers: auth }),
      env,
    );
    expect(viaNew.status).toBe(200);

    const viaAlias = await handleListAgentSubscribers(
      new Request("https://x/v1/admin/subscribers", { headers: auth }),
      env,
    );
    expect(viaAlias.status).toBe(200);

    // Route through the worker fetch entry so both pathnames are wired.
    const fetchNew = await worker.fetch(
      new Request("https://x/v1/admin/agent-subscribers", { headers: auth }),
      env,
      { waitUntil() {}, passThroughOnException() {} } as ExecutionContext,
    );
    expect(fetchNew.status).toBe(200);

    const fetchAlias = await worker.fetch(
      new Request("https://x/v1/admin/subscribers", { headers: auth }),
      env,
      { waitUntil() {}, passThroughOnException() {} } as ExecutionContext,
    );
    expect(fetchAlias.status).toBe(200);

    const bodyNew = (await fetchNew.json()) as { subscribers: unknown[] };
    const bodyAlias = (await fetchAlias.json()) as { subscribers: unknown[] };
    expect(bodyNew.subscribers).toHaveLength(1);
    expect(bodyAlias.subscribers).toHaveLength(1);

    await mf.dispose();
  });
});
