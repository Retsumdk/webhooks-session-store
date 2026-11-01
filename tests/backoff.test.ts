import { describe, test, expect } from "bun:test";
import { baseDelayMs, jitterFor, nextDelayMs, DEFAULT_BASE_DELAY_MS, DEFAULT_MAX_DELAY_MS, JITTER_FACTOR } from "../src/backoff.js";

describe("baseDelayMs", () => {
  test("doubles exponentially and caps at maxMs", () => {
    expect(baseDelayMs(1, 1000, 600_000)).toBe(1000);
    expect(baseDelayMs(2, 1000, 600_000)).toBe(2000);
    expect(baseDelayMs(5, 1000, 600_000)).toBe(16_000);
    expect(baseDelayMs(30, 1000, 600_000)).toBe(600_000);
    expect(baseDelayMs(99, 1000, 600_000)).toBe(600_000);
  });

  test("rejects attempts below 1", () => {
    expect(() => baseDelayMs(0, 1000, 600_000)).toThrow(RangeError);
  });
});

describe("jitterFor", () => {
  test("is deterministic per (id, attempt) and lands in [0,1)", () => {
    expect(jitterFor("dl_a", 1)).toBe(jitterFor("dl_a", 1));
    expect(jitterFor("dl_a", 1)).not.toBe(jitterFor("dl_a", 2));
    expect(jitterFor("dl_a", 1)).not.toBe(jitterFor("dl_b", 1));
    for (let i = 1; i <= 50; i++) {
      const j = jitterFor("dl_spread", i);
      expect(j).toBeGreaterThanOrEqual(0);
      expect(j).toBeLessThan(1);
    }
  });
});

describe("nextDelayMs", () => {
  test("is base * (1 + 0.2 * jitter), rounded, and respects max", () => {
    const d = nextDelayMs("dl_x", 1);
    const base = baseDelayMs(1, DEFAULT_BASE_DELAY_MS, DEFAULT_MAX_DELAY_MS);
    expect(d).toBeGreaterThanOrEqual(base);
    expect(d).toBeLessThanOrEqual(Math.round(base * (1 + JITTER_FACTOR * 0.999)));
    expect(nextDelayMs("dl_x", 1)).toBe(d); // deterministic
    expect(nextDelayMs("dl_y", 1)).not.toBe(d); // id-dependent
    expect(nextDelayMs("dl_cap", 30)).toBeLessThanOrEqual(DEFAULT_MAX_DELAY_MS);
  });
});
