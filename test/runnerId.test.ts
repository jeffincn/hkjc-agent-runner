import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { handleWebhook } from "../src/webhook";
import { handleMcp } from "../src/mcp";
import { setClockForTest } from "../src/env";
import { mapChange } from "../src/push11";
import { computeOddsMovement, matchHorse, runnerKey, type LedgerRow } from "../src/oddsMovement";
import { ctxOf, fakeQueue, freshDb, signed, testEnv, useFixtureRoles } from "./helpers";
import { setRolesForTest } from "../src/roles";

const fx = JSON.parse(readFileSync(new URL("./fixtures/runner_id_delta.json", import.meta.url), "utf8"));
const MD: string = fx.meeting_date;

beforeEach(() => { setClockForTest(() => Date.parse("2026-10-14T19:00:05+08:00")); useFixtureRoles(); });
afterEach(() => { setClockForTest(null); setRolesForTest(null); });

function delta(d: any): string {
  return JSON.stringify({
    schema: "hkjc-push/1.1", event: "odds_delta", event_id: d.event_id, seq: d.seq, meeting_date: MD, venue: "ST",
    captured_at: d.captured_at, sent_at: d.captured_at,
    source: { name: "HKJC GraphQL", url: "https://example.invalid/odds", last_updated_at: d.captured_at },
    quality: { missing_source_time: false, post_start: false, late_ms: 0 },
    races: [], changes: d.changes,
  });
}
async function post(env: ReturnType<typeof testEnv>, body: string) {
  const { ctx, done } = ctxOf();
  const res = await handleWebhook(new Request("https://x/webhook", { method: "POST", headers: await signed("test-secret", body), body }), env, ctx);
  await done();
  return res;
}
async function tool(env: ReturnType<typeof testEnv>, name: string, args: Record<string, unknown>) {
  const res = await handleMcp(new Request("https://x/mcp", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  }), env);
  return ((await res.json()) as any).result;
}

describe("runner_id / status / pool mapping", () => {
  it("maps new 740b52d3 fields and still maps legacy rows", () => {
    const c = mapChange(fx.deltas[0].changes[1])!;
    expect(c).toMatchObject({ runner_id: "X_T099", runner_no: 5, race_no: 2, bet_type: "WIN", pool: "WIN", status: "Standby", horse_name: "TEST STANDBY FIVE", name_en: "TEST STANDBY FIVE" });
    const legacy = mapChange({ race_no: 1, runner_no: 3, bet_type: "PLA", new_odds: 2 })!;
    expect(legacy).toMatchObject({ runner_id: null, status: null, pool: null, runner_no: 3, bet_type: "PLA" });
    expect(runnerKey(legacy)).toBe("no:3");
    expect(runnerKey(c)).toBe("id:X_T099");
  });
});

describe("declared and standby runners with the same number", () => {
  it("stores both, never overwrites the declared runner, and excludes standby from movement", async () => {
    const db = await freshDb();
    const env = testEnv(db, fakeQueue());
    for (const d of fx.deltas) expect((await post(env, delta(d))).status).toBe(202);

    const rows = (await db.prepare(`SELECT runner_id, runner_no, status, pool, horse_name, bet_type, new_odds FROM odds_ledger ORDER BY id`).all<any>()).results;
    expect(rows).toHaveLength(5);
    expect(rows.filter((r: any) => r.status === "Standby").map((r: any) => r.runner_id)).toEqual(["X_T099", "X_T099"]);
    expect(rows[0]).toMatchObject({ runner_id: "X_T001", runner_no: 5, status: "Declared", pool: "WIN", horse_name: "TEST DECLARED FIVE" });

    const mv = (await tool(env, "get_odds_movement", { race_date: MD, race_no: 2 })).structuredContent;
    expect(mv.series.map((s: any) => [s.runner_id, s.bet_type])).toEqual([["X_T001", "PLA"], ["X_T001", "WIN"]]);
    const win = mv.series.find((s: any) => s.bet_type === "WIN");
    // Declared #5 trajectory 6.0 -> 5.0 -> 4.0; standby's 50/60 never leak in.
    expect(win.changes.map((c: any) => [c.prev_odds, c.new_odds])).toEqual([[6, 5], [5, 4]]);
    expect(win.first_odds).toBe(6);
    expect(win.last_odds).toBe(4);
    expect((await tool(env, "get_odds_movement", { race_date: MD, horse: "x_t001" })).structuredContent.series_count).toBe(2);
    expect((await tool(env, "get_odds_movement", { race_date: MD, horse: "X_T099" })).structuredContent.series_count).toBe(0);

    // Ledger replay derives prev_odds per runner_id, not per horse_no.
    const led = (await tool(env, "get_ledger", { meeting_date: MD, bet_type: "WIN" })).structuredContent;
    const byId = (id: string) => led.entries.filter((e: any) => e.runner_id === id).map((e: any) => [e.prev_odds, e.new_odds]);
    expect(byId("X_T001")).toEqual([[6, 5], [5, 4]]);
    expect(byId("X_T099")).toEqual([[99, 50], [50, 60]]);
  });

  it("legacy rows without runner_id are still keyed by runner number", () => {
    const base = { name_zh: null, name_en: null, bet_type: "WIN", captured_at: null, received_at_hkt: "2026-10-14T19:00:00.000+08:00", post_race: 0 };
    const rows: LedgerRow[] = [
      { ...base, id: 1, seq: 1, race_no: 1, runner_no: 5, prev_odds: 6, new_odds: 5 },
      { ...base, id: 2, seq: 2, race_no: 1, runner_no: 5, prev_odds: null, new_odds: 4 },
      { ...base, id: 3, seq: 3, race_no: 1, runner_no: 5, runner_id: "X_T001", status: "Declared", prev_odds: null, new_odds: 3.5 },
    ];
    const s = computeOddsMovement(rows);
    expect(s.map((x) => [x.runner_id, x.change_count])).toEqual([[null, 2], ["X_T001", 0]]);
    expect(matchHorse({ runner_id: null, runner_no: 5, name_zh: null, name_en: null }, "5")).toBe(true);
  });
});
