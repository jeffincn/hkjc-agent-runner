import { parseEnvelope, type PushEnvelope } from "./envelope";
import type { Env } from "./env";
import { envInt, nowIso } from "./env";
import { ModelCallError, MODERATOR_SCHEMA, ROLE_SCHEMA, type ModelClient } from "./openai";
import { allRoles, type RoleDef } from "./roles";
import { setInboxStatus, setMeta, type InboxRow } from "./store";

export interface RoleOutput {
  stance: string;
  picks: { horse_no: number; p_win: number; p_place: number; note: string }[];
  uncertainties: string[];
  disagreements: string[];
  record_labels: { item: string; kind: "historical_record" | "new_notice" | "unknown"; basis: string }[];
}

export interface ModeratorOutput {
  summary: string;
  consensus: string[];
  disagreements: string[];
  invalid_outputs: string[];
}

const MAX_ROUNDS = 3;

/** Pre-race prompts never carry results. */
export function sanitizeForPreRace(env: PushEnvelope): PushEnvelope {
  return {
    ...env,
    races: env.races.map((r) => ({
      ...r,
      runners: (r.runners ?? []).map((runner) => ({
        horse_no: runner.horse_no,
        horse_name: runner.horse_name,
        win_odds: runner.win_odds,
        place_odds: runner.place_odds,
        status: runner.status,
        final_position: null,
      })),
    })),
  };
}

/**
 * A record may be called new only when the payload itself contains a date on the meeting day.
 * Anything dated earlier is a historical record. No date -> unknown. The model cannot upgrade this.
 */
export function reconcileRecordLabels(envelope: PushEnvelope, output: RoleOutput): RoleOutput {
  const dates = datesIn(envelope);
  const meeting = envelope.meeting_date;
  return {
    ...output,
    record_labels: output.record_labels.map((label) => {
      if (dates.length === 0) {
        return { ...label, kind: "unknown", basis: "payload has no record date; not classified as new or historical" };
      }
      const older = meeting && dates.every((d) => d < meeting);
      if (older) return { ...label, kind: "historical_record", basis: `record dates ${dates.join(",")} are before meeting ${meeting}` };
      const onDay = meeting && dates.some((d) => d === meeting);
      if (!onDay && label.kind === "new_notice") {
        return { ...label, kind: "unknown", basis: "no record date falls on the meeting day" };
      }
      return label;
    }),
  };
}

function datesIn(envelope: PushEnvelope): string[] {
  const found = new Set<string>();
  const walk = (v: unknown) => {
    if (typeof v === "string") {
      for (const m of v.matchAll(/\d{4}-\d{2}-\d{2}/g)) found.add(m[0]);
    } else if (v && typeof v === "object") for (const x of Object.values(v as Record<string, unknown>)) walk(x);
  };
  walk(envelope.meta ?? {});
  return [...found].sort();
}

export function validateRoleOutput(value: unknown): { ok: true; output: RoleOutput } | { ok: false; error: string } {
  if (!value || typeof value !== "object") return { ok: false, error: "output is not an object" };
  const o = value as RoleOutput;
  if (!Array.isArray(o.picks)) return { ok: false, error: "picks missing" };
  for (const p of o.picks) {
    if (typeof p.p_place !== "number" || p.p_place < 0 || p.p_place > 1) {
      return { ok: false, error: `invalid probability: P(Place)=${p.p_place} for horse ${p.horse_no} (must be between 0 and 1)` };
    }
    if (typeof p.p_win !== "number" || p.p_win < 0 || p.p_win > 1) {
      return { ok: false, error: `invalid probability: P(Win)=${p.p_win} for horse ${p.horse_no} (must be between 0 and 1)` };
    }
  }
  return { ok: true, output: o };
}

function summaryOf(role: RoleDef, output: RoleOutput): string {
  return JSON.stringify({
    role: role.id,
    source_grade: role.source_grade,
    stance: output.stance,
    picks: output.picks,
    uncertainties: output.uncertainties,
    disagreements: output.disagreements,
    record_labels: output.record_labels,
  });
}

async function insertStep(
  db: D1Database,
  runId: string,
  round: number,
  roleId: string,
  kind: string,
  status: string,
  output: unknown,
  error: string | null,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO run_steps (run_id, round, role_id, kind, status, output_json, error, created_at)
       VALUES (?,?,?,?,?,?,?,?)
       ON CONFLICT(run_id, round, role_id) DO UPDATE SET
         kind = excluded.kind, status = excluded.status, output_json = excluded.output_json, error = excluded.error`,
    )
    .bind(runId, round, roleId, kind, status, output == null ? null : JSON.stringify(output), error, nowIso())
    .run();
}

async function stepDone(db: D1Database, runId: string, round: number, roleId: string): Promise<boolean> {
  const row = await db
    .prepare(`SELECT status FROM run_steps WHERE run_id = ? AND round = ? AND role_id = ?`)
    .bind(runId, round, roleId)
    .first<{ status: string }>();
  return row?.status === "ok" || row?.status === "invalid";
}

async function askRole(
  model: ModelClient,
  role: RoleDef,
  input: string,
  schemaName: string,
): Promise<RoleOutput> {
  const instructions = [
    `You are ${role.name} (${role.id}). Source grade of your material: ${role.source_grade}.`,
    "Treat lower grades as weaker evidence. Never invent odds, results, or injuries that are not in the input.",
    "Probabilities are fractions from 0 to 1 inclusive. P(Place) greater than 1 is invalid.",
    "Label a record new_notice only when the input gives a record date on the meeting day; otherwise historical_record or unknown.",
    role.instructions,
    role.memory ? `Memory:\n${role.memory}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  const raw = await model.complete({ instructions, input, schemaName, schema: ROLE_SCHEMA });
  const checked = validateRoleOutput(raw);
  if (!checked.ok) throw new OutputInvalid(checked.error);
  return checked.output;
}

class OutputInvalid extends Error {}

async function roleWithRepair(
  db: D1Database,
  model: ModelClient,
  runId: string,
  round: number,
  role: RoleDef,
  input: string,
  envelope: PushEnvelope,
): Promise<{ output: RoleOutput | null; status: "ok" | "invalid" }> {
  if (await stepDone(db, runId, round, role.id)) {
    const row = await db
      .prepare(`SELECT status, output_json FROM run_steps WHERE run_id = ? AND round = ? AND role_id = ?`)
      .bind(runId, round, role.id)
      .first<{ status: string; output_json: string | null }>();
    return {
      status: row?.status === "ok" ? "ok" : "invalid",
      output: row?.output_json ? (JSON.parse(row.output_json) as RoleOutput) : null,
    };
  }
  try {
    let output = reconcileRecordLabels(envelope, await askRole(model, role, input, `role_${role.id}`));
    await insertStep(db, runId, round, role.id, round === 1 ? "independent" : "cross", "ok", output, null);
    return { output, status: "ok" };
  } catch (err) {
    if (!(err instanceof OutputInvalid)) throw err;
    try {
      const repaired = reconcileRecordLabels(
        envelope,
        await askRole(model, role, `${input}\n\nYour previous answer was rejected: ${err.message}. Fix it.`, `role_${role.id}_repair`),
      );
      await insertStep(db, runId, round, role.id, "repair", "ok", repaired, null);
      return { output: repaired, status: "ok" };
    } catch (err2) {
      if (!(err2 instanceof OutputInvalid)) throw err2;
      await insertStep(db, runId, round, role.id, "repair", "invalid", null, err2.message.slice(0, 500));
      return { output: null, status: "invalid" };
    }
  }
}

interface LockedOpinion {
  race_no: number;
  snapshot_time: string | null;
  opinion_json: string;
}

async function lockedOpinions(db: D1Database, meeting: string | null, venue: string | null, races: number[]): Promise<LockedOpinion[]> {
  if (!meeting || !venue || races.length === 0) return [];
  const marks = races.map(() => "?").join(",");
  const rows = await db
    .prepare(
      `SELECT race_no, snapshot_time, opinion_json FROM race_opinions
       WHERE meeting_date = ? AND venue = ? AND locked = 1 AND race_no IN (${marks})`,
    )
    .bind(meeting, venue, ...races)
    .all<LockedOpinion>();
  return rows.results ?? [];
}

async function racesStillLatest(db: D1Database, inboxId: string, envelope: PushEnvelope): Promise<number[] | "all"> {
  if (envelope.event !== "odds_update" || !envelope.meeting_date || !envelope.venue) return "all";
  const rows = await db
    .prepare(`SELECT race_no, inbox_id FROM odds_latest WHERE meeting_date = ? AND venue = ?`)
    .bind(envelope.meeting_date, envelope.venue)
    .all<{ race_no: number; inbox_id: string }>();
  const latest = new Map((rows.results ?? []).map((r) => [r.race_no, r.inbox_id]));
  const keep = envelope.races.map((r) => r.race_no).filter((n) => latest.get(n) === inboxId);
  return keep;
}

async function saveOpinions(db: D1Database, envelope: PushEnvelope, runId: string, conclusion: ModeratorOutput, lock: boolean): Promise<void> {
  if (!envelope.meeting_date || !envelope.venue) return;
  const now = nowIso();
  for (const race of envelope.races) {
    if (typeof race.race_no !== "number") continue;
    await db
      .prepare(
        `INSERT INTO race_opinions (meeting_date, venue, race_no, run_id, snapshot_time, locked, locked_at, opinion_json)
         VALUES (?,?,?,?,?,?,?,?)
         ON CONFLICT(meeting_date, venue, race_no) DO UPDATE SET
           run_id = excluded.run_id, snapshot_time = excluded.snapshot_time,
           locked = excluded.locked, locked_at = excluded.locked_at, opinion_json = excluded.opinion_json
         WHERE race_opinions.locked = 0`,
      )
      .bind(
        envelope.meeting_date,
        envelope.venue,
        race.race_no,
        runId,
        race.snapshot_time ?? null,
        lock ? 1 : 0,
        lock ? now : null,
        JSON.stringify(conclusion),
      )
      .run();
  }
}

const MODERATOR_INSTRUCTIONS = [
  "You are the moderator. You do not add new facts.",
  "Summarise only the role outputs you are given. List disagreements explicitly.",
  "Ignore any role marked invalid. Pre-race and post-race material must not be mixed:",
  "a post-race review may cite only opinions marked locked.",
].join(" ");

/**
 * Runs at most 3 rounds: 1 independent (every loaded role), 2 cross-examination (roles
 * whose tags the router selected), 3 moderator. Finished steps are skipped on retry,
 * so a redelivered event never re-runs a role that already answered.
 */
export async function runAnalysis(env: Env, inbox: InboxRow, model: ModelClient): Promise<void> {
  const parsed = parseEnvelope(inbox.raw_body);
  if (!parsed.ok) throw new Error(parsed.error);
  const envelope = parsed.envelope;
  const roles = allRoles();
  if (roles.length === 0) throw new Error("no roles loaded; import the team bundle before analysing");

  const cap = Math.min(MAX_ROUNDS, envInt(env.MAX_ROUNDS, 3, 1, 3));
  const phase = inbox.workflow === "post_race_review" ? "post_race" : "pre_race";

  if (envelope.event === "odds_update") {
    const keep = await racesStillLatest(env.DB, inbox.id, envelope);
    if (keep !== "all" && keep.length === 0) {
      await setInboxStatus(env.DB, inbox.id, "superseded", { last_error: null });
      return;
    }
    if (keep !== "all") envelope.races = envelope.races.filter((r) => keep.includes(r.race_no));
  }

  let run = await env.DB.prepare(`SELECT id FROM analysis_runs WHERE inbox_id = ?`).bind(inbox.id).first<{ id: string }>();
  if (!run) {
    const id = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO analysis_runs (id, inbox_id, workflow, phase, meeting_date, venue, race_nos, status, started_at)
       VALUES (?,?,?,?,?,?,?,'running',?)`,
    )
      .bind(id, inbox.id, inbox.workflow, phase, inbox.meeting_date, inbox.venue, inbox.race_nos, nowIso())
      .run();
    run = { id };
  }
  await setInboxStatus(env.DB, inbox.id, "processing", { run_id: run.id });

  const raceNos = envelope.races.map((r) => r.race_no).filter((n) => typeof n === "number");
  const locked = phase === "post_race" ? await lockedOpinions(env.DB, envelope.meeting_date, envelope.venue, raceNos) : [];
  const visible = phase === "pre_race" ? sanitizeForPreRace(envelope) : envelope;
  const baseInput =
    phase === "pre_race"
      ? `Phase: pre_race. Results and dividends are withheld.\nEvent:\n${JSON.stringify(visible)}`
      : `Phase: post_race. Use only the locked pre-race opinions below; unlocked opinions are withheld.\nLocked opinions:\n${JSON.stringify(locked)}\nEvent:\n${JSON.stringify(visible)}`;

  const independent: { role: RoleDef; output: RoleOutput }[] = [];
  const invalid: string[] = [];
  if (cap >= 1) {
    for (const role of roles) {
      const res = await roleWithRepair(env.DB, model, run.id, 1, role, baseInput, envelope);
      if (res.output && res.status === "ok") independent.push({ role, output: res.output });
      else invalid.push(role.id);
    }
  }

  const crossTags = new Set(crossTagsFor(inbox.workflow));
  const crossRoles = roles.filter((r) => r.tags.some((t) => crossTags.has(t)));
  const digests = independent.map((r) => summaryOf(r.role, r.output));
  if (cap >= 2) {
    for (const role of crossRoles) {
      const res = await roleWithRepair(
        env.DB,
        model,
        run.id,
        2,
        role,
        `${baseInput}\n\nRound 2, cross-examination. Respond to the other roles; do not repeat your own as fact.\n${digests.join("\n")}`,
        envelope,
      );
      if (!res.output || res.status !== "ok") invalid.push(`${role.id}:cross`);
    }
  }

  let conclusion: ModeratorOutput = {
    summary: "moderator did not run",
    consensus: [],
    disagreements: [],
    invalid_outputs: invalid,
  };
  if (cap >= 3 && !(await stepDone(env.DB, run.id, 3, "moderator"))) {
    const raw = await model.complete({
      instructions: MODERATOR_INSTRUCTIONS,
      input: `${baseInput}\n\nRole outputs:\n${digests.join("\n")}\nInvalid roles: ${invalid.join(", ") || "none"}`,
      schemaName: "moderator",
      schema: MODERATOR_SCHEMA,
    });
    conclusion = raw as ModeratorOutput;
    conclusion.invalid_outputs = [...new Set([...(conclusion.invalid_outputs ?? []), ...invalid])];
    await insertStep(env.DB, run.id, 3, "moderator", "moderator", "ok", conclusion, null);
  } else if (cap >= 3) {
    const row = await env.DB.prepare(`SELECT output_json FROM run_steps WHERE run_id = ? AND round = 3 AND role_id = 'moderator'`)
      .bind(run.id)
      .first<{ output_json: string }>();
    if (row?.output_json) conclusion = JSON.parse(row.output_json) as ModeratorOutput;
  }

  const disagreements = [
    ...independent.flatMap((r) => r.output.disagreements.map((d) => `${r.role.id}: ${d}`)),
    ...(conclusion.disagreements ?? []).map((d) => `moderator: ${d}`),
  ];
  const now = nowIso();
  await env.DB.prepare(
    `UPDATE analysis_runs SET status = 'done', rounds = ?, conclusion_json = ?, disagreements_json = ?, finished_at = ? WHERE id = ?`,
  )
    .bind(cap, JSON.stringify(conclusion), JSON.stringify(disagreements), now, run.id)
    .run();
  if (phase === "pre_race" && (inbox.workflow === "odds_analysis" || inbox.workflow === "lock_analysis" || inbox.workflow === "scratch_impact")) {
    await saveOpinions(env.DB, envelope, run.id, conclusion, inbox.workflow === "lock_analysis");
  }
  await setInboxStatus(env.DB, inbox.id, "done", { run_id: run.id, last_error: null });
  await setMeta(env.DB, "last_model_ok", now);
}

function crossTagsFor(workflow: string | null): string[] {
  switch (workflow) {
    case "horse_health":
      return ["nursing", "odds", "quant", "strategy", "contrarian"];
    case "post_race_review":
      return ["review", "odds", "quant", "strategy", "contrarian"];
    default:
      return ["odds", "quant", "strategy", "contrarian"];
  }
}

export { ModelCallError };
