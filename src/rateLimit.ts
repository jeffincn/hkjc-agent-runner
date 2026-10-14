import type { Env } from "./env";
import { envInt, nowMs } from "./env";
import { setMeta } from "./store";

export const DEFAULT_FORWARD_RATE_PER_SUB_PER_SEC = 2;

const WINDOW_PREFIX = "fwd_rate_window_";
const DELAY_COUNT_PREFIX = "fwd_rate_delay_count_";

export function forwardRatePerSubPerSec(env: Env): number {
  return Math.max(1, envInt(env.FORWARD_RATE_PER_SUB_PER_SEC, DEFAULT_FORWARD_RATE_PER_SUB_PER_SEC, 1, 100));
}

function windowMetaKey(subscriberId: number): string {
  return WINDOW_PREFIX + String(subscriberId);
}

function delayCountMetaKey(subscriberId: number): string {
  return DELAY_COUNT_PREFIX + String(subscriberId);
}

export interface DeliverySlotReservation {
  /** Seconds to delay before HTTP delivery (0 = send immediately). */
  delaySeconds: number;
  /** Absolute ms when this slot may fire. */
  slotAtMs: number;
}

function parseWindow(raw: string | null): number[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.map((n) => Number(n)).filter((n) => Number.isFinite(n));
  } catch {
    return [];
  }
}

async function getMetaValue(db: D1Database, key: string): Promise<string | null> {
  const row = await db.prepare(`SELECT value FROM runner_meta WHERE key = ?`).bind(key).first<{ value: string }>();
  return row?.value ?? null;
}

/**
 * Reserve the next delivery slot for a subscriber.
 * Excess is delayed (never dropped).
 */
export async function reserveDeliverySlot(
  env: Env,
  subscriberId: number,
  atMs: number = nowMs(),
): Promise<DeliverySlotReservation> {
  const rate = forwardRatePerSubPerSec(env);
  const intervalMs = Math.ceil(1000 / rate);
  const key = windowMetaKey(subscriberId);
  const stamps = parseWindow(await getMetaValue(env.DB, key));
  const active = stamps.filter((t) => t > atMs - 1000);

  const inWindow = active.filter((t) => t <= atMs && atMs - t < 1000);
  if (inWindow.length < rate) {
    const next = [...active.filter((t) => t > atMs - 1000), atMs];
    await setMeta(env.DB, key, JSON.stringify(next));
    return { delaySeconds: 0, slotAtMs: atMs };
  }

  const oldest = Math.min(...inWindow);
  const futures = active.filter((t) => t > atMs);
  const slotAtMs =
    futures.length > 0 ? Math.max(...futures) + intervalMs : oldest + 1000;
  const waitMs = Math.max(1, slotAtMs - atMs);
  const delaySeconds = Math.max(1, Math.ceil(waitMs / 1000));

  const next = [...active, slotAtMs].filter((t) => t > atMs - 1000 || t >= atMs);
  await setMeta(env.DB, key, JSON.stringify(next));
  await bumpRateLimitDelayCount(env, subscriberId);
  return { delaySeconds, slotAtMs };
}

export async function bumpRateLimitDelayCount(env: Env, subscriberId: number, delta = 1): Promise<void> {
  const key = delayCountMetaKey(subscriberId);
  const raw = await getMetaValue(env.DB, key);
  const cur = Math.max(0, Number(raw ?? 0) || 0);
  await setMeta(env.DB, key, String(cur + delta));
}

export async function getRateLimitDelayCount(env: Env, subscriberId: number): Promise<number> {
  const raw = await getMetaValue(env.DB, delayCountMetaKey(subscriberId));
  return Math.max(0, Number(raw ?? 0) || 0);
}
