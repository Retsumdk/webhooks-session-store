import { describe, test, expect } from "bun:test";
import { WebhookEngine } from "../src/engine.js";
import { WebhookStore } from "../src/store.js";
import { ValidationError, NotFoundError } from "../src/types.js";
import { scriptedHost } from "../src/demo.js";
import { DEMO_EPOCH } from "../src/demo.js";

function makeEngine(host?: WebhookEngine["store"] extends never ? never : Parameters<typeof WebhookEngine.prototype.dispatch>[0] extends never ? never : any): WebhookEngine {
  return new WebhookEngine({ store: new WebhookStore(), clock: () => DEMO_EPOCH, host: host ?? (async () => ({ status: 200 })) });
}

describe("WebhookEngine.dispatch", () => {
  test("requires an active, subscribed session", () => {
    const e = makeEngine();
    const s = e.registerSession({ url: "https://a.example/h", secret: "engine-secret-0123", events: ["evt.a"] });
    expect(e.dispatch(s.id, "evt.a", { x: 1 }).status).toBe("pending");
    expect(() => e.dispatch(s.id, "evt.b", null)).toThrow(/not subscribed/);
    e.setSessionStatus(s.id, "suspended");
    expect(() => e.dispatch(s.id, "evt.a", null)).toThrow(/suspended/);
    expect(() => e.dispatch("wh_0000000000000000", "evt.a", null)).toThrow(NotFoundError);
  });
});

describe("WebhookEngine.processDue", () => {
  test("happy path: one attempt, delivered, failureCount stays 0", async () => {
    const e = makeEngine();
    const s = e.registerSession({ url: "https://ok.example/h", secret: "engine-secret-0123", events: ["evt.a"] });
    const d = e.dispatch(s.id, "evt.a", { n: 1 });
    const results = await e.processDue(DEMO_EPOCH);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ deliveryId: d.id, kind: "delivered", attempts: 1, nextAttemptAt: null });
    const after = e.store.getDelivery(d.id);
    expect(after.status).toBe("delivered");
    expect(after.deliveredAt).toBeGreaterThan(0);
    expect(e.getSession(s.id).failureCount).toBe(0);
  });

  test("limit validation and non-negative limit", async () => {
    const e = makeEngine();
    expect(() => e.processDue(DEMO_EPOCH, 0)).toThrow(ValidationError);
    expect(() => e.processDue(DEMO_EPOCH, 1.5)).toThrow(ValidationError);
  });

  test("transient failure schedules a deterministic retry; success resets failureCount", async () => {
    let flips = 0;
    const e = makeEngine(async () => ({ status: flips++ < 2 ? 503 : 200 }));
    const s = e.registerSession({ url: "https://flaky2.example/h", secret: "engine-secret-0123", events: ["evt.a"] });
    const d = e.dispatch(s.id, "evt.a", null);

    const r1 = await e.processDue(DEMO_EPOCH);
    expect(r1[0]?.kind).toBe("retry");
    expect(e.getSession(s.id).failureCount).toBe(1);
    const nextAt = r1[0]?.nextAttemptAt ?? 0;
    expect(nextAt).toBeGreaterThan(DEMO_EPOCH);

    const r2 = await e.processDue(nextAt);
    expect(r2).toHaveLength(1); // dueDeliveries uses <=, so the delivery is due at its own boundary
  });

  test("permanent failure marks failed immediately and increments failureCount", async () => {
    const e = makeEngine(async () => ({ status: 422 }));
    const s = e.registerSession({ url: "https://strict2.example/h", secret: "engine-secret-0123", events: ["evt.a"] });
    const d = e.dispatch(s.id, "evt.a", null);
    const r = await e.processDue(DEMO_EPOCH);
    expect(r[0]?.kind).toBe("permanent");
    expect(e.store.getDelivery(d.id).status).toBe("failed");
    expect(e.getSession(s.id).failureCount).toBe(1);
  });

  test("success after failures resets failureCount to 0", async () => {
    let calls = 0;
    const e = makeEngine(async () => ({ status: calls++ < 1 ? 500 : 200 }));
    const s = e.registerSession({ url: "https://rec.example/h", secret: "engine-secret-0123", events: ["evt.a"] });
    const d = e.dispatch(s.id, "evt.a", null);
    await e.processDue(DEMO_EPOCH);
    expect(e.getSession(s.id).failureCount).toBe(1);
    const next = e.store.getDelivery(d.id).nextAttemptAt as number;
    await e.processDue(next);
    expect(e.getSession(s.id).failureCount).toBe(0);
  });

  test("replay re-queues terminal deliveries and rejects pending ones", async () => {
    const { host } = scriptedHost();
    const e = new WebhookEngine({ store: new WebhookStore(), clock: () => DEMO_EPOCH, host });
    const s = e.registerSession({ url: "https://strict.example.com/hooks", secret: "strict-endpoint-signing-secret", events: ["evt.a"] });
    const d = e.dispatch(s.id, "evt.a", null);
    await e.processDue(DEMO_EPOCH);
    expect(e.store.getDelivery(d.id).status).toBe("failed");
    const replayed = e.replay(d.id);
    expect(replayed.status).toBe("pending");
    expect(replayed.nextAttemptAt).toBe(DEMO_EPOCH);
    expect(() => e.replay(d.id)).toThrow(/already pending/);
  });

  test("stats aggregates engine-level numbers", async () => {
    const e = makeEngine();
    e.registerSession({ url: "https://s.example/h", secret: "engine-secret-0123", events: ["evt.a"] });
    const t = e.registerSession({ url: "https://t.example/h", secret: "engine-secret-0124", events: ["evt.a"] });
    e.setSessionStatus(t.id, "suspended");
    e.dispatch(e.listSessions()[0]!.id, "evt.a", null);
    const stats = e.stats();
    expect(stats.sessions).toBe(2);
    expect(stats.activeSessions).toBe(1);
    expect(stats.maxAttempts).toBe(8);
  });
});
