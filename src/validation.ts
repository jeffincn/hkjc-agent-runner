/**
 * Probability / EV validation for analysis output. Pure functions plus one D1 writer.
 * A field that fails is quarantined with a reason and gets no Fair / EV.
 */

import { isTotalReturnBasis, ODDS_BASIS_HKJC } from "./push11";

export type BetType = "WIN" | "PLA";

export interface ProbInput {
  role_id: string;
  race_no: number | null;
  runner_no: number;
  bet_type: BetType;
  p: unknown;
  odds: number | null;
  /**
   * Odds basis: `"total_return"`, the hkjc-push/1.1 const
   * (`HKD total return per $1 unit incl. stake`), or `"net"` (profit per unit staked).
   */
  odds_basis: string | null;
}

export interface RaceField {
  /** Runner numbers that are declared and not scratched. */
  active: Set<number>;
  /** Number of starters, used to derive the number of places paid. Defaults to active.size. */
  starters?: number;
}

export interface Validated {
  role_id: string;
  race_no: number | null;
  runner_no: number;
  bet_type: BetType;
  p: number | null;
  odds: number | null;
  odds_basis: string | null;
  fair_odds: number | null;
  ev: number | null;
  status: "accepted" | "quarantined";
  reason: string | null;
}

export const WIN_SUM_TOLERANCE = 0.05;
export const PLA_SUM_TOLERANCE = 0.15;
export const ODDS_BASES = ["total_return", ODDS_BASIS_HKJC, "net"] as const;

/** HKJC place terms: 3 places with 7+ starters, 2 with 4–6, no place pool below 4. */
export function placesPaid(starters: number): number {
  if (starters >= 7) return 3;
  if (starters >= 4) return 2;
  return 0;
}

/** Converts quoted odds to total return per 1 unit staked. null when the basis is unknown. */
export function totalReturn(odds: number, basis: string | null): number | null {
  if (isTotalReturnBasis(basis)) return odds;
  if (basis === "net") return odds + 1;
  return null;
}

export function validateProbabilities(rows: ProbInput[], races: Map<number, RaceField>): Validated[] {
  const out: Validated[] = rows.map((r) => {
    const base: Validated = {
      role_id: r.role_id, race_no: r.race_no, runner_no: r.runner_no, bet_type: r.bet_type,
      p: typeof r.p === "number" && Number.isFinite(r.p) ? r.p : null,
      odds: r.odds, odds_basis: r.odds_basis, fair_odds: null, ev: null, status: "accepted", reason: null,
    };
    const q = (reason: string): Validated => ({ ...base, status: "quarantined", reason });
    if (base.p === null) return q("probability is not a finite number");
    if (base.p < 0 || base.p > 1) return q(`P(${r.bet_type})=${(base.p * 100).toFixed(2)}% outside [0,1]`);
    if (r.race_no === null) return q("cannot map runner to a race");
    const field = races.get(r.race_no);
    if (!field) return q(`race ${r.race_no} not in the event`);
    if (!field.active.has(r.runner_no)) return q(`runner ${r.runner_no} is not an active (non-scratched) runner in race ${r.race_no}`);
    if (r.bet_type === "PLA" && placesPaid(field.starters ?? field.active.size) === 0) return q("no place pool with fewer than 4 starters");
    return base;
  });

  // Per (role, race, bet type) sum checks, only when the role priced the whole active field.
  const groups = new Map<string, Validated[]>();
  for (const v of out) {
    if (v.status !== "accepted" || v.race_no === null) continue;
    const k = `${v.role_id}|${v.race_no}|${v.bet_type}`;
    groups.set(k, [...(groups.get(k) ?? []), v]);
  }
  for (const list of groups.values()) {
    const field = races.get(list[0].race_no as number)!;
    const covered = new Set(list.map((v) => v.runner_no));
    if (covered.size < field.active.size) continue; // partial pricing: no sum check possible
    const sum = list.reduce((s, v) => s + (v.p as number), 0);
    const target = list[0].bet_type === "WIN" ? 1 : placesPaid(field.starters ?? field.active.size);
    const tol = list[0].bet_type === "WIN" ? WIN_SUM_TOLERANCE : PLA_SUM_TOLERANCE * target;
    if (Math.abs(sum - target) > tol) {
      for (const v of list) {
        v.status = "quarantined";
        v.reason = `race ${v.race_no} ${v.bet_type} probabilities sum to ${sum.toFixed(3)}, expected ${target} ± ${tol.toFixed(2)}`;
      }
    }
  }

  for (const v of out) {
    if (v.status !== "accepted" || v.p === null) continue;
    v.fair_odds = v.p > 0 ? 1 / v.p : null;
    if (v.odds === null) continue;
    const tr = totalReturn(v.odds, v.odds_basis);
    if (tr === null) {
      v.status = "quarantined";
      v.reason = `unknown odds_basis "${v.odds_basis ?? ""}"; EV not computed`;
      v.fair_odds = null;
      continue;
    }
    if (!(tr >= 1)) {
      v.status = "quarantined";
      v.reason = `odds ${v.odds} (${v.odds_basis}) give a total return below 1`;
      v.fair_odds = null;
      continue;
    }
    v.ev = v.p * tr - 1;
  }
  return out;
}

export async function storeValidation(db: D1Database, runId: string, rows: Validated[], nowIso: string): Promise<void> {
  if (rows.length === 0) return;
  await db.batch([
    db.prepare(`DELETE FROM analysis_validation WHERE run_id = ?`).bind(runId),
    ...rows.map((v) =>
      db.prepare(
        `INSERT INTO analysis_validation (run_id, role_id, race_no, runner_no, bet_type, p, odds, odds_basis, fair_odds, ev, status, reason, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).bind(runId, v.role_id, v.race_no, v.runner_no, v.bet_type, v.p, v.odds, v.odds_basis, v.fair_odds, v.ev, v.status, v.reason, nowIso),
    ),
  ]);
}
