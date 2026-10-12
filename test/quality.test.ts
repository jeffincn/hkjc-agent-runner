import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handleWebhook } from "../src/webhook";
import { handleMcp } from "../src/mcp";
import { handleMessage } from "../src/consumer";
import { setClockForTest, toHkt } from "../src/env";
import { extract11, mapChange } from "../src/push11";
import { inFastWindow, streamStatus } from "../src/quality";
import { placesPaid, validateProbabilities, type ProbInput, type RaceField } from "../src/validation";
import { setRolesForTest } from "../src/roles";
import type { ModelClient } from "../src/openai";
import { ctxOf, envelope, fakeQueue, freshDb, race, signed, testEnv, useFixtureRoles } from "./helpers";

// Desensitized fixtures only: fake UUIDs, placeholder names, example.invalid URLs.
const MD = "2026-10-07";
const T0 = Date.parse("2026-10-07T12:00:00+08:00");
let now = T0;

beforeEach(() => { now = T0; setClockForTest(() => now); useFixtureRoles(); });
afterEach(() => { setClockForTest(null); setRolesForTest(null); });

const eid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function v11(opts: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schema: "hkjc-push/1.1",
    event: "odds_delta",
    event_id: eid(1),
    seq: 1,
    meeting_date: MD,
    venue: "HV",
    captured_at: "2026-10-07T11:59:58+08:00",
    sent_at: "2026-10-07T11:59:59+08:00",
    source: { last_updated_at: "2026-10-07T11:59:50+08:00", url: "https://example.invalid/odds" },
    quality: { missing_source_time: false, post_start: false, late_ms: 0 },
    races: [],
    changes: [
      { race_no: 1, runner_no: 1, name_zh: "測試馬甲", name_en: "TEST HORSE A", bet_type: "WIN", prev_odds: 4.0, new_odds: 3.6, odds_basis: "total_return" },
      { race_no: 1, runner_no: 1, name_zh: "測試馬甲", name_en: "TEST HORSE A", bet_type: "PLA", prev_odds: 1.8, new_odds: 1.7, odds_basis: "total_return" },
    ],
    pools: null,
    ...opts,
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
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  }), env);
  return ((await res.json()) as any).result;
}

describe("hkjc-push/1.1 field mapping", () => {
  it("maps envelope and change fields, tolerating null source time and null pools", () => {
    const f = extract11(JSON.parse(v11({ source: { last_updated_at: null, url: "https://example.invalid/x" } })));
    expect(f.event_id).toBe(eid(1));
    expect(f.seq).toBe(1);
    expect(f.source_last_updated_at).toBeNull();
    expect(f.pools).toBeNull();
    expect(f.changes).toHaveLength(2);
    expect(f.changes[0]).toMatchObject({ race_no: 1, runner_no: 1, bet_type: "WIN", prev_odds: 4, new_odds: 3.6, odds_basis: "total_return", name_zh: "測試馬甲" });
    expect(mapChange({ race_no: 2, horse_no: 3, bet_type: "PLACE", new_odds: "2.5" })).toMatchObject({ runner_no: 3, bet_type: "PLA", new_odds: 2.5 });
    expect(mapChange({ race_no: 2, runner_no: 3, bet_type: "QIN" })).toBeNull();
  });
});

describe("ingest: both formats, dedupe, timing", () => {
  it("accepts 1.1, dedupes retries on event_id, and records receive time and delays", async () => {
    const db = await freshDb();
    const queue = fakeQueue();
    const env = testEnv(db, queue);
    expect((await post(env, v11())).status).toBe(202);
    // Retry: same event_id, different sent_at -> duplicate.
    const retry = await post(env, v11({ sent_at: "2026-10-07T12:00:00+08:00" }));
    expect(retry.headers.get("X-Duplicate")).toBe("1");
    const rows = await db.prepare(`SELECT * FROM inbox_events`).all<any>();
    expect(rows.results).toHaveLength(1);
    const r = rows.results[0];
    expect(r.dedupe_source).toBe("event_id");
    expect(r.event_id).toBe(eid(1));
    expect(r.received_at_hkt).toBe("2026-10-07T12:00:00.000+08:00");
    expect(r.delay_received_sent_ms).toBe(1000);
    expect(r.delay_received_captured_ms).toBe(2000);
    expect(r.delay_captured_source_ms).toBe(8000);
    expect(r.duplicate_count).toBe(1);
    expect(JSON.parse(r.quality_flags)).toEqual(["duplicate"]);
    expect(r.workflow).toBe("record_only");
    expect(queue.sent).toHaveLength(1);
    const ledger = await db.prepare(`SELECT COUNT(*) AS n FROM odds_ledger`).first<{ n: number }>();
    expect(ledger?.n).toBe(2);
  });

  it("still accepts 1.0 envelopes, flags missing source time and records receive time", async () => {
    const db = await freshDb();
    const env = testEnv(db, fakeQueue());
    const body = envelope({ event: "odds_update", races: [race(1, "2026-10-07T11:59:30+08:00")] });
    expect((await post(env, body)).status).toBe(202);
    const r = await db.prepare(`SELECT * FROM inbox_events`).first<any>();
    expect(r.schema_version).toBe("hkjc-push/1.0");
    expect(r.received_at_hkt).toBe(toHkt(T0));
    expect(r.delay_received_captured_ms).toBe(30_000);
    expect(JSON.parse(r.quality_flags)).toContain("missing_source_time");
    expect(r.workflow).toBe("odds_analysis");
    const l = await db.prepare(`SELECT bet_type, new_odds, odds_basis FROM odds_ledger ORDER BY bet_type`).all<any>();
    expect(l.results.map((x: any) => [x.bet_type, x.new_odds])).toEqual([["PLA", 1.8], ["WIN", 4]]);
  });
});

describe("quality flags", () => {
  it("flags gap, out_of_order, duplicate seq, future timestamp, late and missing source time", async () => {
    const db = await freshDb();
    const env = testEnv(db, fakeQueue());
    const flags = async () => (await db.prepare(`SELECT seq, quality_flags FROM inbox_events ORDER BY received_at, rowid`).all<any>())
      .results.map((r: any) => [r.seq, JSON.parse(r.quality_flags)]);
    await post(env, v11());
    now += 1000; await post(env, v11({ event_id: eid(4), seq: 4 }));                      // gap 2..3
    now += 1000; await post(env, v11({ event_id: eid(2), seq: 2 }));                      // out of order
    now += 1000; await post(env, v11({ event_id: eid(9), seq: 2 }));                      // same seq, new id
    now += 1000; await post(env, v11({ event_id: eid(5), seq: 5, captured_at: "2026-10-07T12:10:00+08:00" })); // future
    now += 1000; await post(env, v11({ event_id: eid(6), seq: 6, quality: { missing_source_time: true, post_start: false, late_ms: 4000 },
      source: { last_updated_at: null, url: "https://example.invalid/odds" } }));
    const f = await flags();
    expect(f[0]).toEqual([1, []]);
    expect(f[1]).toEqual([4, ["gap"]]);
    expect(f[2]).toEqual([2, ["out_of_order"]]);
    expect(f[3]).toEqual([2, ["duplicate"]]);
    expect(f[4][1]).toContain("future_timestamp");
    expect(f[5][1]).toEqual(expect.arrayContaining(["missing_source_time", "late"]));
    const gaps = await db.prepare(`SELECT from_seq, to_seq FROM seq_gaps`).all<any>();
    expect(gaps.results).toEqual([{ from_seq: 2, to_seq: 3 }]);
    const q = (await tool(env, "get_data_quality", { meeting_date: MD })).structuredContent;
    expect(q.last_seq).toBe(6);
    expect(q.open_gaps).toEqual([{ from_seq: 3, to_seq: 3 }]); // seq 2 arrived late; 3 still missing
    expect(q.flag_counts).toMatchObject({ gap: 1, out_of_order: 1, duplicate: 1, future_timestamp: 1, late: 1 });
    expect(q.data_quality_status).toBe("bad");
  });

  it("marks events after the race start as post-race and keeps them out of pre-race analysis", async () => {
    const db = await freshDb();
    const queue = fakeQueue();
    const env = testEnv(db, queue);
    await post(env, envelope({ event: "schedule", races: [race(1, "2026-10-07T11:00:00+08:00"), { ...race(2, "2026-10-07T11:00:00+08:00"), post_time: "2026-10-07T19:05:00+08:00" }] }));
    now = Date.parse("2026-10-07T18:40:00+08:00"); // race 1 off at 18:35, race 2 not yet
    const late = envelope({ event: "odds_update", races: [race(1, "2026-10-07T18:39:50+08:00")] });
    const res = await post(env, late);
    expect(res.headers.get("X-Quality-Flags")).toContain("post_start");
    const row = await db.prepare(`SELECT workflow, post_race FROM inbox_events WHERE event_type = 'odds_update'`).first<any>();
    expect(row).toEqual({ workflow: "record_only", post_race: 1 });
    expect(await db.prepare(`SELECT COUNT(*) AS n FROM odds_latest`).first<any>()).toEqual({ n: 0 });

    // 1.1 delta touching race 1 (started) and race 2 (open): event stays, race-1 ledger rows are post_race.
    await post(env, v11({ captured_at: "2026-10-07T18:39:59+08:00", sent_at: "2026-10-07T18:39:59+08:00",
      source: { last_updated_at: "2026-10-07T18:39:58+08:00", url: "https://example.invalid/odds" },
      changes: [
        { race_no: 1, runner_no: 1, name_zh: "測試馬甲", name_en: "TEST HORSE A", bet_type: "WIN", prev_odds: 4, new_odds: 3.9, odds_basis: "total_return" },
        { race_no: 2, runner_no: 5, name_zh: "測試馬乙", name_en: "TEST HORSE B", bet_type: "WIN", prev_odds: 8, new_odds: 7.5, odds_basis: "total_return" },
      ] }));
    const led = (await tool(env, "get_ledger", { meeting_date: MD, exclude_post_race: true })).structuredContent;
    expect(led.entries.map((e: any) => [e.race_no, e.post_race])).toEqual([[2, false]]);
    const all = (await tool(env, "get_ledger", { meeting_date: MD, race_no: 1 })).structuredContent;
    expect(all.entries.every((e: any) => e.race_no === 1)).toBe(true);
    expect(all.entries.filter((e: any) => e.post_race).length).toBeGreaterThan(0);
  });
});

describe("stream liveness", () => {
  const post1 = ["2026-10-07T18:35:00+08:00"];
  it("uses a 60s interval in the fast window and 5 min otherwise, stale beyond 2x", () => {
    const at = (s: string) => Date.parse(s);
    expect(inFastWindow(at("2026-10-07T18:10:00+08:00"), post1)).toBe(true);
    expect(inFastWindow(at("2026-10-07T17:59:00+08:00"), post1)).toBe(false);
    expect(streamStatus(at("2026-10-07T18:10:00+08:00"), "2026-10-07T18:08:30+08:00", post1).status).toBe("ok");      // 90s
    expect(streamStatus(at("2026-10-07T18:10:00+08:00"), "2026-10-07T18:07:59+08:00", post1).status).toBe("stale");   // 121s
    expect(streamStatus(at("2026-10-07T18:10:00+08:00"), "2026-10-07T18:04:00+08:00", post1).status).toBe("broken");  // 6 min
    expect(streamStatus(at("2026-10-07T14:00:00+08:00"), "2026-10-07T13:52:00+08:00", post1).status).toBe("ok");      // 8 min, slow
    expect(streamStatus(at("2026-10-07T14:00:00+08:00"), "2026-10-07T13:49:00+08:00", post1).status).toBe("stale");   // 11 min
    expect(streamStatus(at("2026-10-07T14:00:00+08:00"), null, post1).status).toBe("no_data");
  });

  it("no_update heartbeats keep the stream alive and record last_change_seq", async () => {
    const db = await freshDb();
    const env = testEnv(db, fakeQueue());
    await post(env, v11());
    now += 9 * 60_000;
    await post(env, v11({ event: "no_update", event_id: eid(2), seq: 2, changes: undefined, last_change_seq: 1 }));
    now += 60_000;
    let q = (await tool(env, "get_data_quality", { meeting_date: MD })).structuredContent;
    expect(q.stream_status).toBe("ok");
    expect(q.last_change_seq).toBe(1);
    expect(q.last_seq).toBe(2);
    expect(q.last_event_hkt).toBe(toHkt(T0 + 9 * 60_000));
    now += 15 * 60_000;
    q = (await tool(env, "get_data_quality", { meeting_date: MD })).structuredContent;
    expect(q.stream_status).toBe("stale");
    expect(q.data_quality_status).toBe("degraded");
    expect(JSON.stringify(q)).not.toContain("test-secret");
  });
});

describe("probability and EV validation", () => {
  const field = (active: number[], starters = active.length): Map<number, RaceField> => new Map([[1, { active: new Set(active), starters }]]);
  const row = (o: Partial<ProbInput>): ProbInput => ({ role_id: "r", race_no: 1, runner_no: 1, bet_type: "WIN", p: 0.2, odds: 6, odds_basis: "total_return", ...o });

  it("quarantines P(place)=116.91% and never computes EV on it", () => {
    const [v] = validateProbabilities([row({ bet_type: "PLA", p: 1.1691, odds: 1.5 })], field([1, 2, 3, 4, 5, 6, 7]));
    expect(v.status).toBe("quarantined");
    expect(v.reason).toContain("116.91%");
    expect(v.ev).toBeNull();
    expect(v.fair_odds).toBeNull();
  });

  it("rejects scratched / unknown runners and non-numbers", () => {
    const out = validateProbabilities([row({ runner_no: 9 }), row({ race_no: 2 }), row({ p: "0.3" }), row({ race_no: null })], field([1, 2]));
    expect(out.map((v) => v.status)).toEqual(["quarantined", "quarantined", "quarantined", "quarantined"]);
    expect(out[0].reason).toContain("not an active");
  });

  it("computes Fair = 1/P and EV = P × total return − 1 on the given basis", () => {
    const [a, b] = validateProbabilities([row({ p: 0.25, odds: 5 }), row({ runner_no: 2, p: 0.25, odds: 4, odds_basis: "net" })], field([1, 2, 3, 4]));
    expect(a.fair_odds).toBe(4);
    expect(a.ev).toBeCloseTo(0.25);
    expect(b.ev).toBeCloseTo(0.25);
    const [c] = validateProbabilities([row({ odds_basis: "decimal?" })], field([1]));
    expect(c.status).toBe("quarantined");
    expect(c.ev).toBeNull();
  });

  it("checks per-race sums when the whole field is priced", () => {
    const win = (ps: number[]) => ps.map((p, i) => row({ runner_no: i + 1, p }));
    expect(validateProbabilities(win([0.5, 0.3, 0.2]), field([1, 2, 3])).every((v) => v.status === "accepted")).toBe(true);
    const bad = validateProbabilities(win([0.6, 0.5, 0.2]), field([1, 2, 3]));
    expect(bad.every((v) => v.status === "quarantined" && v.ev === null)).toBe(true);
    // partial pricing: no sum check
    expect(validateProbabilities(win([0.9]), field([1, 2, 3]))[0].status).toBe("accepted");
    const pla = (ps: number[]) => ps.map((p, i) => row({ runner_no: i + 1, p, bet_type: "PLA", odds: null }));
    expect(placesPaid(8)).toBe(3);
    expect(validateProbabilities(pla([0.6, 0.5, 0.4, 0.4, 0.3, 0.3, 0.3, 0.2]), field([1, 2, 3, 4, 5, 6, 7, 8])).every((v) => v.status === "accepted")).toBe(true);
    expect(validateProbabilities(pla([0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9]), field([1, 2, 3, 4, 5, 6, 7, 8])).every((v) => v.status === "quarantined")).toBe(true);
    expect(validateProbabilities(pla([0.5, 0.5, 0.5]), field([1, 2, 3]))[0].reason).toContain("fewer than 4");
  });

  it("is wired into the analysis run and visible through get_run", async () => {
    const db = await freshDb();
    const queue = fakeQueue();
    const env = testEnv(db, queue);
    const r = race(1, "2026-10-07T11:59:00+08:00");
    for (let n = 2; n <= 8; n++) r.runners.push({ horse_no: n, horse_name: `TEST HORSE ${n}`, win_odds: 10, place_odds: 2.5, status: "Declared", final_position: null } as any);
    r.runners.push({ horse_no: 9, horse_name: "TEST HORSE 9", win_odds: 3, place_odds: 1.4, status: "Scratched", final_position: null } as any);
    await post(env, envelope({ event: "lock", races: [r] }));
    const model: ModelClient = {
      async complete(req) {
        if (req.schemaName === "moderator") return { summary: "ok", consensus: [], disagreements: [], invalid_outputs: [] };
        return { stance: "x", picks: [{ horse_no: 1, p_win: 0.3, p_place: 0.6, note: "" }, { horse_no: 9, p_win: 0.1, p_place: 0.3, note: "" }],
          uncertainties: [], disagreements: [], record_labels: [] };
      },
    };
    await handleMessage(env, queue.sent[0].body.inbox_id, model, () => undefined);
    const rows = await db.prepare(`SELECT runner_no, bet_type, status, ev, reason FROM analysis_validation WHERE role_id = 'odds' ORDER BY runner_no, bet_type`).all<any>();
    expect(rows.results.map((x: any) => [x.runner_no, x.bet_type, x.status])).toEqual([
      [1, "PLA", "accepted"], [1, "WIN", "accepted"], [9, "PLA", "quarantined"], [9, "WIN", "quarantined"],
    ]);
    expect(rows.results[1].ev).toBeCloseTo(0.3 * 4 - 1);
    expect(rows.results[2].ev).toBeNull();
    const run = await db.prepare(`SELECT id FROM analysis_runs`).first<{ id: string }>();
    const got = (await tool(env, "get_run", { run_id: run!.id })).structuredContent;
    expect(got.validation.length).toBe(8 * 2 * 2); // 8 fixture roles × 2 picks × WIN/PLA
  });
});

describe("ledger", () => {
  it("is append-only and replays the trajectory with since_seq filtering", async () => {
    const db = await freshDb();
    const env = testEnv(db, fakeQueue());
    for (let s = 1; s <= 3; s++) {
      now += 60_000;
      await post(env, v11({ event_id: eid(s), seq: s, changes: [
        { race_no: 1, runner_no: 1, name_zh: "測試馬甲", name_en: "TEST HORSE A", bet_type: "WIN", prev_odds: null, new_odds: 5 - s * 0.5, odds_basis: "total_return" },
      ] }));
    }
    const led = (await tool(env, "get_ledger", { meeting_date: MD, runner_no: 1, bet_type: "WIN" })).structuredContent;
    expect(led.entries.map((e: any) => [e.seq, e.prev_odds, e.new_odds])).toEqual([[1, null, 4.5], [2, 4.5, 4], [3, 4, 3.5]]);
    const since = (await tool(env, "get_ledger", { meeting_date: MD, since_seq: 2, limit: 10 })).structuredContent;
    expect(since.entries.map((e: any) => [e.seq, e.prev_odds])).toEqual([[3, 4]]);
    await expect(db.prepare(`UPDATE odds_ledger SET new_odds = 99`).run()).rejects.toThrow(/append-only/);
    await expect(db.prepare(`DELETE FROM odds_ledger`).run()).rejects.toThrow(/append-only/);
    const bad = await tool(env, "get_ledger", { meeting_date: "07/10/2026" });
    expect(bad.isError).toBe(true);
  });
});
