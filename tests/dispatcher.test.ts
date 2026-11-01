import { describe, test, expect } from "bun:test";
import { attemptDelivery, classify, buildEnvelope } from "../src/dispatcher.js";
import { verifyWebhook } from "../src/receiver.js";
import { Session } from "../src/types.js";

const SESSION: Session = {
  id: "wh_test0000000001",
  url: "https://target.example.com/hooks",
  secret: "dispatcher-test-secret-16",
  events: ["evt.a"],
  status: "active",
  createdAt: "2026-01-01T00:00:00.000Z",
  failureCount: 0,
};

describe("classify", () => {
  test("2xx delivered; 408/429/5xx/network retry; other 4xx permanent", () => {
    expect(classify(200, null).kind).toBe("delivered");
    expect(classify(204, null).kind).toBe("delivered");
    expect(classify(299, null).kind).toBe("delivered");
    for (const code of [null, 408, 429, 500, 502, 503]) expect(classify(code, "boom").kind).toBe("retry");
    for (const code of [400, 401, 403, 404, 410, 422]) expect(classify(code, "no").kind).toBe("permanent");
  });
});

describe("attemptDelivery", () => {
  test("sends a signed envelope the receiver verifies; reports the status", async () => {
    let captured: { url: string; headers: Record<string, string>; body: string } | null = null;
    const host = async (url: string, init: { headers: Record<string, string>; body: string }) => {
      captured = { url, headers: init.headers, body: init.body };
      return { status: 200 };
    };
    const attempt = await attemptDelivery(SESSION, { id: "dl_x", event: "evt.a", createdAt: 1000, payload: { n: 1 } }, host);
    expect(attempt.ok).toBe(true);
    expect(attempt.statusCode).toBe(200);
    expect(attempt.error).toBeNull();
    expect(attempt.n).toBe(0); // the engine assigns real attempt numbers

    expect(captured!.url).toBe(SESSION.url);
    expect(captured!.headers["webhook-id"]).toBe("dl_x");
    const verdict = verifyWebhook(SESSION.secret, { headers: captured!.headers, rawBody: captured!.body }, { nowSec: Number(captured!.headers["webhook-timestamp"]) });
    expect(verdict.valid).toBe(true);
    if (verdict.valid) expect(verdict.envelope.data).toEqual({ n: 1 });
  });

  test("network errors become retry attempts with a null status", async () => {
    const host = async () => { throw new Error("ECONNREFUSED"); };
    const attempt = await attemptDelivery(SESSION, { id: "dl_y", event: "evt.a", createdAt: 1000, payload: null }, host);
    expect(attempt.ok).toBe(false);
    expect(attempt.statusCode).toBeNull();
    expect(attempt.error).toBe("ECONNREFUSED");
    expect(classify(attempt.statusCode, attempt.error).kind).toBe("retry");
  });
});

describe("buildEnvelope", () => {
  test("carries id/event/created/data with second-resolution created", () => {
    expect(buildEnvelope("dl_1", "evt.a", 1500, { a: 1 })).toEqual({ id: "dl_1", event: "evt.a", created: 1, data: { a: 1 } });
  });
});
