import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { WebhookStore } from "../src/store.js";
import { NotFoundError, StoreCorruptError, ValidationError } from "../src/types.js";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const EPOCH = 1_767_225_600_000;
const INPUT = { url: "https://store.example/hooks", secret: "store-test-secret-16", events: ["evt.a"] };

let dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "whs-store-"));
  dirs.push(d);
  return d;
}
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

describe("in-memory store", () => {
  let store: WebhookStore;
  beforeEach(() => { store = new WebhookStore(); });

  test("registerSession validates url, secret length, events, duplicates", () => {
    expect(() => store.addSession({ ...INPUT, url: "ftp://nope" }, EPOCH)).toThrow(ValidationError);
    expect(() => store.addSession({ ...INPUT, url: "notaurl" }, EPOCH)).toThrow(ValidationError);
    expect(() => store.addSession({ ...INPUT, secret: "short" }, EPOCH)).toThrow(ValidationError);
    expect(() => store.addSession({ ...INPUT, events: [] }, EPOCH)).toThrow(ValidationError);
    expect(() => store.addSession({ ...INPUT, events: ["a", "a"] }, EPOCH)).toThrow(ValidationError);
    const s = store.addSession(INPUT, EPOCH);
    expect(s.id).toMatch(/^wh_[0-9a-f]{16}$/);
    expect(() => store.addSession(INPUT, EPOCH)).toThrow(/already exists/);
    expect(store.getSession(s.id).createdAt).toBe("2026-01-01T00:00:00.000Z");
  });

  test("session status transitions and not-found errors", () => {
    const s = store.addSession(INPUT, EPOCH);
    expect(store.setSessionStatus(s.id, "suspended").status).toBe("suspended");
    expect(store.setSessionStatus(s.id, "active").status).toBe("active");
    expect(() => store.setSessionStatus(s.id, "paused" as never)).toThrow(ValidationError);
    expect(() => store.getSession("wh_0000000000000000")).toThrow(NotFoundError);
    expect(store.peekSession("wh_0000000000000000")).toBeUndefined();
  });

  test("deliveries: event subscription is enforced, ids are unique", () => {
    const s = store.addSession(INPUT, EPOCH);
    const d1 = store.createDelivery(s, "evt.a", { x: 1 }, EPOCH + 5);
    expect(d1.id).toMatch(/^dl_[0-9a-f]{16}$/);
    expect(d1.status).toBe("pending");
    expect(d1.nextAttemptAt).toBe(EPOCH + 5);
    expect(() => store.createDelivery(s, "evt.other", null, EPOCH)).toThrow(/not subscribed/);
    const d2 = store.createDelivery(store.addSession({ ...INPUT, url: "https://other.example/h", events: ["evt.a"] }, EPOCH + 1), "evt.a", null, EPOCH);
    expect(d2.id).not.toBe(d1.id);
  });

  test("dueDeliveries: only due pending, oldest-next first, capped", () => {
    const s = store.addSession(INPUT, EPOCH);
    for (let i = 0; i < 3; i++) store.createDelivery(s, "evt.a", i, EPOCH + (3 - i) * 100);
    const late = store.createDelivery(s, "evt.a", 9, EPOCH);
    store.updateDelivery({ ...late, nextAttemptAt: EPOCH + 10_000 });
    const due = store.dueDeliveries(EPOCH + 1000, 2);
    expect(due.map((d) => d.payload)).toEqual([2, 1]); // nextAttemptAt EPOCH+300, +200
    expect(store.dueDeliveries(EPOCH + 1000, 10)).toHaveLength(3);
    expect(store.dueDeliveries(EPOCH, 10)).toHaveLength(0);
  });

  test("listDeliveries filters and sorts by createdAt then id", () => {
    const s = store.addSession(INPUT, EPOCH);
    const d1 = store.createDelivery(s, "evt.a", 1, EPOCH);
    const d2 = store.createDelivery(s, "evt.a", 2, EPOCH + 1);
    store.updateDelivery({ ...d2, status: "delivered", deliveredAt: EPOCH + 2 });
    expect(store.listDeliveries({ status: "delivered" }).map((d) => d.id)).toEqual([d2.id]);
    expect(store.listDeliveries().map((d) => d.id)).toEqual([d1.id, d2.id]);
  });

  test("stats counts all states and attempts", () => {
    const s = store.addSession(INPUT, EPOCH);
    const d = store.createDelivery(s, "evt.a", null, EPOCH);
    store.updateDelivery({ ...d, status: "exhausted", attempts: [{ n: 1, at: EPOCH, ok: false, statusCode: 500, error: "x", durationMs: 1 }] });
    const stats = store.stats();
    expect(stats.deliveries.exhausted).toBe(1);
    expect(stats.totalAttempts).toBe(1);
    expect(stats.activeSessions).toBe(1);
  });
});

describe("persisted store", () => {
  test("rehydrates sessions and deliveries across instances", () => {
    const dir = tempDir();
    const a = new WebhookStore(dir);
    const s = a.addSession(INPUT, EPOCH);
    const d = a.createDelivery(s, "evt.a", { k: 1 }, EPOCH);
    a.updateDelivery({ ...d, status: "failed", lastError: "HTTP 404" });

    const b = new WebhookStore(dir);
    expect(b.getSession(s.id).secret).toBe(INPUT.secret);
    const rd = b.getDelivery(d.id);
    expect(rd.status).toBe("failed");
    expect(rd.lastError).toBe("HTTP 404");
    b.setSessionStatus(s.id, "suspended"); // continues the same files
    const c = new WebhookStore(dir);
    expect(c.getSession(s.id).status).toBe("suspended");
  });

  test("corrupt JSON fails loudly with a file:line reference", () => {
    const dir = tempDir();
    writeFileSync(
      join(dir, "sessions.jsonl"),
      '{"id":"wh_ok0000000000000","url":"https://a.example/h","secret":"0123456789abcdef","events":["e"],"status":"active","createdAt":"2026-01-01T00:00:00.000Z","failureCount":0}\n{not json}\n',
    );
    expect(() => new WebhookStore(dir)).toThrow(StoreCorruptError);
    try {
      new WebhookStore(dir);
    } catch (err) {
      expect((err as Error).message).toContain("sessions.jsonl:2");
    }
  });

  test("wrong-shaped records fail loudly", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "sessions.jsonl"), JSON.stringify({ id: "wh_x", url: 5 }) + "\n");
    expect(() => new WebhookStore(dir)).toThrow(/session.url must be a string/);
  });

  test("malformed attempt entries fail loudly", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "deliveries.jsonl"), JSON.stringify({ id: "dl_x", sessionId: "s", event: "e", status: "pending", attempts: [{ n: "one" }], createdAt: 1 }) + "\n");
    expect(() => new WebhookStore(dir)).toThrow(/attempts entry is malformed/);
  });

  test("an empty directory starts clean", () => {
    const dir = tempDir();
    const s = new WebhookStore(dir);
    expect(s.stats().sessions).toBe(0);
  });
});
