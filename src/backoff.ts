/**
 * Deterministic exponential backoff with seeded jitter.
 *
 * Jitter is derived from the delivery id and attempt number via SHA-256,
 * so schedules are reproducible (tests, demos, replays) without a global RNG.
 */
import { createHash } from "node:crypto";

export const DEFAULT_BASE_DELAY_MS = 1_000;
export const DEFAULT_MAX_DELAY_MS = 600_000;
/** Jitter spreads the delay by up to +20% so retries never synchronize. */
export const JITTER_FACTOR = 0.2;

/** Pure exponential component: base * 2^(attempt-1), capped at maxMs. */
export function baseDelayMs(attempt: number, baseMs: number, maxMs: number): number {
  if (attempt < 1) throw new RangeError("attempt must be >= 1");
  const exp = Math.min(attempt - 1, 62);
  const raw = baseMs * 2 ** exp;
  return Math.min(raw, maxMs);
}

/** Deterministic jitter in [0, 1) for a delivery id + attempt. */
export function jitterFor(deliveryId: string, attempt: number): number {
  const digest = createHash("sha256").update(`${deliveryId}:${attempt}`).digest();
  const sample = digest.readUInt32BE(0);
  return sample / 0x1_0000_0000;
}

/** Final delay for attempt N of a given delivery: base * (1 + JITTER_FACTOR * jitter). */
export function nextDelayMs(
  deliveryId: string,
  attempt: number,
  baseMs: number = DEFAULT_BASE_DELAY_MS,
  maxMs: number = DEFAULT_MAX_DELAY_MS,
): number {
  const base = baseDelayMs(attempt, baseMs, maxMs);
  // Jitter spreads upward only, then the result is capped at maxMs so the
  // schedule can never exceed the configured ceiling.
  return Math.min(Math.round(base * (1 + JITTER_FACTOR * jitterFor(deliveryId, attempt))), maxMs);
}
