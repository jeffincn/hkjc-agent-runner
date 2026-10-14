import type { Env } from "./env";
import { nowMs } from "./env";
import { hmacSha256Hex } from "./crypto";
import {
  listEnabledAgentSubscribers,
  subscriberWantsEvent,
  type AgentSubscriber,
} from "./agentSubscribers";
import {
  allowAgentDelivery,
  recordAgentDeliverySuccess,
  recordAgentDeliveryFailure,
} from "./agentCircuit";

export interface FanoutInput {
  eventType: string;
  /** Exact bytes received on /webhook — forwarded unmodified. */
  rawBody: string;
  qualityFlags: string[];
  meetingDate: string | null;
}

export interface FanoutSkip {
  id: number;
  reason: string;
}

export interface FanoutResult {
  attempted: number;
  delivered: number;
  failed: number;
  skipped: FanoutSkip[];
}

/** Per-attempt POST timeout. */
const FORWARD_TIMEOUT_MS = 10_000;

/** YYYY-MM-DD in Asia/Hong_Kong for an epoch-ms instant. */
export function hktDate(ms: number): string {
  const d = new Date(ms + 8 * 3600_000);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Minutes since midnight in Asia/Hong_Kong. */
function hktMinutes(ms: number): number {
  const d = new Date(ms + 8 * 3600_000);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

/** Quiet hours check. Both set → quiet in that span (overnight wrap ok). */
export function inQuietHours(ms: number, quietStart: string, quietEnd: string): boolean {
  const mins = hktMinutes(ms);
  const [sh, sm] = quietStart.split(":").map(Number);
  const [eh, em] = quietEnd.split(":").map(Number);
  const s = sh * 60 + sm;
  const e = eh * 60 + em;
  if (s <= e) return mins >= s && mins < e;
  return mins >= s || mins < e;
}

/**
 * v1 raceday semantics: the event belongs to today's (HKT) meeting.
 * "always" subscribers are never gated here.
 */
export function windowActive(
  sub: Pick<AgentSubscriber, "active_window">,
  meetingDate: string | null,
  ms: number,
): boolean {
  if (sub.active_window !== "raceday") return true;
  return meetingDate !== null && meetingDate === hktDate(ms);
}

async function forwardOnce(
  env: Env,
  sub: AgentSubscriber,
  input: FanoutInput,
): Promise<{ ok: boolean; httpStatus: number | null; error?: string }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": "hkjc-agent-runner fanout",
  };
  if (input.qualityFlags.length > 0) {
    headers["X-Quality-Flags"] = input.qualityFlags.join(",");
  }
  const bodyBytes = new TextEncoder().encode(input.rawBody);
  if (sub.secret) {
    headers["X-Signature"] = await hmacSha256Hex(sub.secret, bodyBytes);
  }
  try {
    const resp = await fetch(sub.url, {
      method: "POST",
      headers,
      body: input.rawBody,
      signal: AbortSignal.timeout(FORWARD_TIMEOUT_MS),
    });
    // Drain the body so the connection can be reused; content is never logged.
    await resp.arrayBuffer().catch(() => undefined);
    return { ok: resp.status >= 200 && resp.status < 300, httpStatus: resp.status };
  } catch (err) {
    return {
      ok: false,
      httpStatus: null,
      error: (err instanceof Error ? err.message : String(err)).slice(0, 200),
    };
  }
}

/**
 * Forward an accepted inbound event to every enabled downstream agent
 * subscriber whose event_filter matches. Best-effort: a failing subscriber
 * never affects other subscribers and never throws to the caller — the
 * inbox → queue path must stay intact.
 */
export async function fanoutToAgents(env: Env, input: FanoutInput): Promise<FanoutResult> {
  const result: FanoutResult = { attempted: 0, delivered: 0, failed: 0, skipped: [] };
  let subs: AgentSubscriber[];
  try {
    subs = await listEnabledAgentSubscribers(env);
  } catch {
    return result;
  }
  if (subs.length === 0) return result;

  const ms = nowMs();
  for (const sub of subs) {
    try {
      if (!subscriberWantsEvent(sub, input.eventType)) {
        result.skipped.push({ id: sub.id, reason: "event_filter" });
        continue;
      }
      if (!windowActive(sub, input.meetingDate, ms)) {
        result.skipped.push({ id: sub.id, reason: "active_window" });
        continue;
      }
      if (sub.quiet_start && sub.quiet_end && inQuietHours(ms, sub.quiet_start, sub.quiet_end)) {
        result.skipped.push({ id: sub.id, reason: "quiet_hours" });
        continue;
      }
      const gate = await allowAgentDelivery(env, sub.id);
      if (!gate.allowed) {
        result.skipped.push({ id: sub.id, reason: "circuit_open" });
        continue;
      }
      result.attempted += 1;
      const fwd = await forwardOnce(env, sub, input);
      if (fwd.ok) {
        result.delivered += 1;
        await recordAgentDeliverySuccess(env, sub.id, fwd.httpStatus);
      } else {
        result.failed += 1;
        await recordAgentDeliveryFailure(env, sub.id, {
          http_status: fwd.httpStatus,
          error_message: fwd.error,
        });
      }
    } catch {
      // One bad subscriber must never break the loop or the caller.
      result.failed += 1;
    }
  }
  return result;
}
