import { readFileSync } from "node:fs";
import { Miniflare } from "miniflare";
import { hmacSha256Hex } from "../src/crypto";
import type { Env, QueueMessageBody } from "../src/env";
import { setRolesForTest, type RoleDef } from "../src/roles";

let mf: Miniflare | undefined;

async function freshDb(): Promise<D1Database> {
  mf ??= new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } }",
    d1Databases: ["DB"],
  });
  const db = await mf.getD1Database("DB");
  for (const table of ["run_steps", "analysis_runs", "race_opinions", "odds_latest", "outbox", "inbox_events", "webhook_rejections", "runner_meta"]) {
    await db.exec(`DROP TABLE IF EXISTS ${table}`);
  }
  const sql = readFileSync(new URL("../migrations/0001_init.sql", import.meta.url), "utf8").replace(/--[^\n]*/g, "");
  for (const stmt of sql.split(";")) {
    const q = stmt.trim();
    if (q) await db.prepare(q).run();
  }
  return db;
}

let chain: Promise<unknown> = Promise.resolve();
async function lockedFresh(): Promise<D1Database> {
  const prev = chain;
  let release: () => void = () => undefined;
  chain = new Promise((r) => { release = r; });
  await prev;
  try {
    return await freshDb();
  } finally {
    release();
  }
}

export interface FakeQueue {
  sent: { body: QueueMessageBody; delay?: number }[];
  fail: boolean;
  send(body: QueueMessageBody, opts?: { delaySeconds?: number }): Promise<void>;
}

export { lockedFresh as freshDb };

export function fakeQueue(): FakeQueue {
  const q: FakeQueue = {
    sent: [],
    fail: false,
    async send(body, opts) {
      if (q.fail) throw new Error("queue temporarily unavailable");
      q.sent.push({ body, delay: opts?.delaySeconds });
    },
  };
  return q;
}

export function testEnv(db: D1Database, queue: FakeQueue, extra: Partial<Env> = {}): Env {
  return {
    DB: db,
    EVENTS_QUEUE: queue as unknown as Env["EVENTS_QUEUE"],
    PUSH_SECRET: "test-secret",
    RUNNER_API_TOKEN: "runner-token",
    OPENAI_API_KEY: "sk-test",
    OPENAI_MODEL: "test-model",
    ODDS_COALESCE_SECONDS: "45",
    MAX_ROUNDS: "3",
    MAX_PROCESS_ATTEMPTS: "4",
    ...extra,
  };
}

export function fixtureRoles(): RoleDef[] {
  const tags = ["odds", "quant", "strategy", "contrarian", "nursing", "review", "form", "pace"];
  return tags.map((tag) => ({
    id: tag,
    name: `${tag} fixture`,
    tags: [tag],
    instructions: `Fixture role ${tag}. Use only the input.`,
    memory: "",
    source_grade: tag === "odds" ? "official" : "unverified",
    source_file: `fixture/${tag}.md`,
  }));
}

export function useFixtureRoles(): void {
  setRolesForTest(fixtureRoles());
}

export interface EnvelopeOpts {
  event?: string;
  meeting_date?: string | null;
  venue?: string | null;
  races?: unknown[];
  meta?: Record<string, unknown>;
  sent_at?: string;
}

export function envelope(opts: EnvelopeOpts = {}): string {
  return JSON.stringify({
    schema: "hkjc-push/1.0",
    event: opts.event ?? "test",
    sent_at: opts.sent_at ?? "2026-10-07T12:00:00+08:00",
    meeting_date: opts.meeting_date === undefined ? "2026-10-07" : opts.meeting_date,
    venue: opts.venue === undefined ? "HV" : opts.venue,
    races: opts.races ?? [],
    ...(opts.meta ? { meta: opts.meta } : {}),
  });
}

export function race(n: number, snapshot: string, extra: Record<string, unknown> = {}) {
  return {
    race_no: n,
    post_time: "2026-10-07T18:35:00+08:00",
    snapshot_time: snapshot,
    pool_status: "SELLING",
    runners: [
      { horse_no: 1, horse_name: "HORSE A", win_odds: 4, place_odds: 1.8, status: "Declared", final_position: null, ...extra },
    ],
  };
}

export async function signed(secret: string, body: string): Promise<Record<string, string>> {
  return { "Content-Type": "application/json", "X-Signature": await hmacSha256Hex(secret, new TextEncoder().encode(body)) };
}

export function ctxOf(): { ctx: ExecutionContext; done: () => Promise<void> } {
  const jobs: Promise<unknown>[] = [];
  return {
    ctx: { waitUntil: (p) => void jobs.push(p), passThroughOnException: () => undefined } as ExecutionContext,
    done: () => Promise.all(jobs).then(() => undefined),
  };
}
