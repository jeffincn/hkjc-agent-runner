import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { handleMcp } from "../src/mcp";
import {
  BURST_CHANGES_PER_MINUTE, DROP_PCT, JUMP_PCT, PROB_SHIFT, changeFlags, computeOddsMovement, matchHorse, type LedgerRow,
} from "../src/oddsMovement";
import { fakeQueue, freshDb, testEnv } from "./helpers";

const fx = JSON.parse(readFileSync(new URL("./fixtures/odds_movement_ledger.json", import.meta.url), "utf8")) as { meeting_date: string; rows: LedgerRow[] };

async function tool(env: ReturnType<typeof testEnv>, name: string, args: Record<string, unknown>) {
  const res = await handleMcp(new Request("https://x/mcp", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  }), env);
  return ((await res.json()) as any).result;
}

describe("odds movement (pure)", () => {
  it("documents thresholds as constants", () => {
    expect([JUMP_PCT, DROP_PCT, PROB_SHIFT, BURST_CHANGES_PER_MINUTE]).toEqual([0.15, 0.15, 0.03, 4]);
    expect(changeFlags(4, 4.6)).toEqual(["sudden_jump", "prob_shift"]);
    expect(changeFlags(20, 23)).toEqual(["sudden_jump"]);
    expect(changeFlags(4, 3.4)).toEqual(["sudden_drop", "prob_shift"]);
    expect(changeFlags(10, 10.5)).toEqual([]);
  });

  it("computes per-change magnitude, implied probability, cumulative drift and minute density", () => {
    const series = computeOddsMovement(fx.rows, { excludePostRace: true });
    const a = series.find((s) => s.race_no === 3 && s.runner_no === 1 && s.bet_type === "WIN")!;
    expect(a.name_en).toBe("TEST HORSE A");
    expect(a.change_count).toBe(5); // unchanged 8.0 -> 8.0 is not a change; post-race row dropped
    expect(a.first_odds).toBe(8);
    expect(a.last_odds).toBe(4.8);
    expect(a.cum_odds_drift).toBeCloseTo(-3.2);
    expect(a.cum_pct_drift).toBeCloseTo(-0.4);
    expect(a.cum_implied_p_drift).toBeCloseTo(1 / 4.8 - 1 / 8, 4);
    const c = a.changes[1];
    expect([c.prev_odds, c.new_odds, c.abs_change]).toEqual([7.8, 6.5, -1.3]);
    expect(c.pct_change).toBeCloseTo(-0.1667, 4);
    expect(c.implied_p_change).toBeCloseTo(1 / 6.5 - 1 / 7.8, 4);
    expect(c.flags).toContain("sudden_drop");
    expect(c.minute_hkt).toBe("2026-10-11T12:01");
    expect(a.minutes.map((m) => [m.minute_hkt, m.changes])).toEqual([["2026-10-11T12:00", 1], ["2026-10-11T12:01", 4]]);
    expect(a.minutes[1].flags).toEqual(expect.arrayContaining(["sudden_drop", "burst"]));
    expect([a.drops, a.jumps, a.bursts, a.max_changes_per_minute, a.active_minutes]).toEqual([2, 0, 1, 4, 2]);

    const b = series.find((s) => s.runner_no === 2 && s.bet_type === "WIN")!;
    expect(b.jumps).toBe(1);
    expect(b.changes[0].flags).toContain("sudden_jump");
    const pla = series.find((s) => s.runner_no === 2 && s.bet_type === "PLA")!;
    expect(pla.change_count).toBe(1); // prev_odds carried by the push itself

    const withPost = computeOddsMovement(fx.rows).find((s) => s.race_no === 3 && s.runner_no === 1)!;
    expect(withPost.change_count).toBe(6);
    expect(withPost.changes[5].post_race).toBe(true);
  });

  it("matches horse by number or name", () => {
    const s = { runner_no: 7, name_zh: "測試馬甲", name_en: "TEST HORSE A" };
    expect(matchHorse(s, "7")).toBe(true);
    expect(matchHorse(s, "8")).toBe(false);
    expect(matchHorse(s, "horse a")).toBe(true);
    expect(matchHorse(s, "馬甲")).toBe(true);
    expect(matchHorse(s, "乙")).toBe(false);
  });
});

describe("get_odds_movement MCP tool", () => {
  it("reads odds_ledger read-only and filters by race and horse", async () => {
    const db = await freshDb();
    const env = testEnv(db, fakeQueue());
    await db.prepare(`INSERT INTO inbox_events (id, dedupe_key, dedupe_source, event_type, meeting_date, venue, race_nos, raw_body, received_at, signature_status, status, updated_at)
      VALUES ('in1','k1','derived','odds_delta',?,'ST','[3,4]','{}','2026-10-11T04:00:00Z','valid','done','2026-10-11T04:00:00Z')`).bind(fx.meeting_date).run();
    for (const r of fx.rows) {
      await db.prepare(`INSERT INTO odds_ledger (inbox_id, seq, meeting_date, venue, race_no, runner_no, name_zh, name_en, bet_type, prev_odds, new_odds, captured_at, received_at_hkt, post_race)
        VALUES ('in1',?,?,'ST',?,?,?,?,?,?,?,?,?,?)`).bind(r.seq, fx.meeting_date, r.race_no, r.runner_no, r.name_zh, r.name_en, r.bet_type, r.prev_odds, r.new_odds, r.captured_at, r.received_at_hkt, r.post_race).run();
    }
    const all = (await tool(env, "get_odds_movement", { race_date: fx.meeting_date })).structuredContent;
    expect(all.series_count).toBe(4);
    expect(all.thresholds.jump_pct).toBe(JUMP_PCT);
    const a = all.series.find((s: any) => s.race_no === 3 && s.runner_no === 1);
    expect(a.change_count).toBe(5); // post-race excluded by default

    const r3 = (await tool(env, "get_odds_movement", { race_date: fx.meeting_date, race_no: 3, horse: "TEST HORSE B" })).structuredContent;
    expect(r3.series.map((s: any) => [s.runner_no, s.bet_type])).toEqual([[2, "PLA"], [2, "WIN"]]);
    const compact = (await tool(env, "get_odds_movement", { race_date: fx.meeting_date, race_no: 4, horse: "1", include_changes: false, exclude_post_race: false })).structuredContent;
    expect(compact.series[0].changes).toEqual([]);
    expect(compact.series[0].minutes[0].changes).toBe(1);

    expect((await tool(env, "get_odds_movement", { race_date: "11/10/2026" })).isError).toBe(true);
    expect((await tool(env, "get_odds_movement", {})).isError).toBe(true);
    const n = await db.prepare(`SELECT COUNT(*) AS n FROM odds_ledger`).first<{ n: number }>();
    expect(n?.n).toBe(fx.rows.length);
  });
});
