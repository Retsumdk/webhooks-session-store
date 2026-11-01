import { describe, test, expect } from "bun:test";
import { signPayload, SIGNATURE_HEADER, TIMESTAMP_HEADER } from "../src/signer.js";
import { verifyWebhook, requireWebhook } from "../src/receiver.js";
import { ValidationError } from "../src/types.js";

const SECRET = "receiver-test-secret-0123";
const BODY = '{"id":"dl_1","event":"evt.a","created":1767225600,"data":{"x":1}}';
const T = 1_767_225_600;

function incoming(sig?: string, ts?: string) {
  const headers: Record<string, string> = {};
  if (sig !== undefined) headers[SIGNATURE_HEADER] = sig;
  if (ts !== undefined) headers[TIMESTAMP_HEADER] = ts;
  return { headers, rawBody: BODY };
}

describe("verifyWebhook", () => {
  test("accepts a valid delivery from the dispatcher's signing scheme", () => {
    const verdict = verifyWebhook(SECRET, incoming(signPayload(SECRET, BODY, T), String(T)), { nowSec: T });
    expect(verdict.valid).toBe(true);
    if (verdict.valid) expect(verdict.envelope.data).toEqual({ x: 1 });
  });

  test("case-insensitive headers", () => {
    const upper = {
      headers: { "WEBHOOK-SIGNATURE": signPayload(SECRET, BODY, T), "WEBHOOK-TIMESTAMP": String(T) },
      rawBody: BODY,
    };
    expect(verifyWebhook(SECRET, upper, { nowSec: T }).valid).toBe(true);
  });

  test("returns precise reasons instead of throwing", () => {
    const reasons = [
      verifyWebhook(SECRET, incoming(undefined, String(T)), { nowSec: T }),
      verifyWebhook(SECRET, incoming("v1=zz", String(T)), { nowSec: T }),
      verifyWebhook(SECRET, incoming(signPayload(SECRET, BODY, T), undefined), { nowSec: T }),
      verifyWebhook(SECRET, incoming(signPayload("wrong-secret-0123456789", BODY, T), String(T)), { nowSec: T }),
      verifyWebhook(SECRET, incoming(signPayload(SECRET, BODY, T), String(T)), { nowSec: T + 3600 }),
      verifyWebhook(SECRET, { headers: { [SIGNATURE_HEADER]: `t=${T},v1=x`, [TIMESTAMP_HEADER]: String(T) }, rawBody: "not json" }, { nowSec: T }),
      verifyWebhook(SECRET, { headers: { [SIGNATURE_HEADER]: `t=${T},v1=x`, [TIMESTAMP_HEADER]: String(T) }, rawBody: "[1,2]" }, { nowSec: T }),
    ].filter((r) => !r.valid);
    expect(reasons).toHaveLength(7);
    expect(reasons.every((r) => r.reason.length > 0)).toBe(true);
  });
});

describe("requireWebhook", () => {
  test("throws ValidationError on failure and parses on success", () => {
    expect(() => requireWebhook(SECRET, incoming("v1=bad", String(T)), { nowSec: T })).toThrow(ValidationError);
    const env = requireWebhook(SECRET, incoming(signPayload(SECRET, BODY, T), String(T)), { nowSec: T });
    expect(env.event).toBe("evt.a");
  });
});
