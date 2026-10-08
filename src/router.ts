import type { PushEnvelope } from "./envelope";

export type Workflow =
  | "odds_analysis" // odds_update: independent -> cross-exam, coalesced per race
  | "lock_analysis" // lock: immediate pre-race lock
  | "scratch_impact" // scratch: immediate withdrawal impact
  | "horse_health" // horse_update / injury_update: adds nursing role
  | "post_race_review" // result / dividends: compare against locked pre-race opinions only
  | "record_only"; // test / schedule / backfill_progress / whitelist_alert / runs_update / changes

export type Phase = "pre_race" | "post_race" | "none";

export interface Route {
  workflow: Workflow;
  phase: Phase;
  /** Queue delay. odds_update waits so bursts collapse to the latest snapshot. */
  delaySeconds: number;
  /** Role tags (from the role bundle manifest) that take part. */
  roleTags: string[];
  note?: string;
}

export const PRE_RACE_TAGS = ["odds", "quant", "strategy", "contrarian"];

export function routeEvent(env: PushEnvelope, oddsCoalesceSeconds: number): Route {
  switch (env.event) {
    case "odds_update":
      return { workflow: "odds_analysis", phase: "pre_race", delaySeconds: oddsCoalesceSeconds, roleTags: PRE_RACE_TAGS };
    case "lock":
      return { workflow: "lock_analysis", phase: "pre_race", delaySeconds: 0, roleTags: PRE_RACE_TAGS };
    case "scratch":
      return { workflow: "scratch_impact", phase: "pre_race", delaySeconds: 0, roleTags: PRE_RACE_TAGS };
    case "horse_update":
    case "injury_update":
      return {
        workflow: "horse_health",
        phase: "pre_race",
        delaySeconds: 0,
        roleTags: ["nursing", ...PRE_RACE_TAGS],
      };
    case "result":
    case "dividends":
      return { workflow: "post_race_review", phase: "post_race", delaySeconds: 0, roleTags: ["review", ...PRE_RACE_TAGS] };
    case "test":
    case "schedule":
    case "backfill_progress":
    case "whitelist_alert":
      return { workflow: "record_only", phase: "none", delaySeconds: 0, roleTags: [] };
    case "runs_update":
    case "changes":
      return {
        workflow: "record_only",
        phase: "none",
        delaySeconds: 0,
        roleTags: [],
        note: "not in the analysis routing table; recorded only",
      };
    default:
      return { workflow: "record_only", phase: "none", delaySeconds: 0, roleTags: [], note: `unknown event "${env.event}"` };
  }
}
