import { describe, expect, it } from "vitest";
import { handleMcp } from "../src/mcp";
import { fakeQueue, freshDb, testEnv } from "./helpers";

async function rpc(env: ReturnType<typeof testEnv>, body: unknown) {
  const res = await handleMcp(new Request("https://x/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify(body),
  }), env);
  return { status: res.status, body: res.status === 202 ? null : await res.json() as any };
}

describe("read-only MCP", () => {
  it("initializes, lists read-only tools, and answers tool calls without auth", async () => {
    const db = await freshDb();
    const env = testEnv(db, fakeQueue());
    const init = await rpc(env, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
    expect(init.body.result.protocolVersion).toBe("2025-06-18");
    expect(init.body.result.capabilities.tools).toBeTruthy();
    expect((await rpc(env, { jsonrpc: "2.0", method: "notifications/initialized" })).status).toBe(202);

    const list = await rpc(env, { jsonrpc: "2.0", id: 2, method: "tools/list" });
    const names = list.body.result.tools.map((t: any) => t.name);
    expect(names).toEqual(expect.arrayContaining(["get_status", "list_recent_events", "list_recent_runs", "get_run", "get_race_analysis", "search", "fetch"]));
    expect(list.body.result.tools.every((t: any) => t.annotations.readOnlyHint === true)).toBe(true);

    await db.prepare(`INSERT INTO inbox_events (id, dedupe_key, dedupe_source, event_type, meeting_date, venue, race_nos, raw_body, received_at, signature_status, status, updated_at)
      VALUES ('in1','k1','derived','lock','2026-10-08','ST','[3]','{"secret":"do-not-leak"}','2026-10-08T09:00:00Z','valid','done','2026-10-08T09:00:00Z')`).run();
    await db.prepare(`INSERT INTO analysis_runs (id, inbox_id, workflow, phase, meeting_date, venue, race_nos, status, rounds, conclusion_json, disagreements_json, started_at)
      VALUES ('run1','in1','lock_analysis','pre_race','2026-10-08','ST','[3]','done',3,'{"pick":5}','[]','2026-10-08T09:00:01Z')`).run();
    await db.prepare(`INSERT INTO race_opinions (meeting_date, venue, race_no, run_id, locked, opinion_json) VALUES ('2026-10-08','ST',3,'run1',1,'{"pick":5}')`).run();

    const events = await rpc(env, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_recent_events", arguments: {} } });
    expect(JSON.stringify(events.body)).not.toContain("do-not-leak");
    expect(events.body.result.structuredContent.events[0].event_type).toBe("lock");

    const race = await rpc(env, { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "get_race_analysis", arguments: { meeting_date: "2026-10-08", venue: "ST", race_no: 3 } } });
    expect(race.body.result.structuredContent.opinion.locked).toBe(true);
    expect(race.body.result.structuredContent.runs[0].id).toBe("run1");

    const found = await rpc(env, { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "search", arguments: { query: "2026-10-08" } } });
    expect(found.body.result.structuredContent.results[0].id).toBe("run1");
    const doc = await rpc(env, { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "fetch", arguments: { id: "run1" } } });
    expect(doc.body.result.structuredContent.text).toContain("lock_analysis");

    const bad = await rpc(env, { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "get_run", arguments: { run_id: "nope" } } });
    expect(bad.body.result.isError).toBe(true);
    const unknown = await rpc(env, { jsonrpc: "2.0", id: 8, method: "resources/subscribe" });
    expect(unknown.body.error.code).toBe(-32601);
  });
});
