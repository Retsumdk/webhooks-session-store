/**
 * HMAC-SHA256 webhook signing, in the `t=<unix>,v1=<hex>` header scheme
 * (compatible with the Stripe-style convention receivers already know).
 *
 * Signed string is `${timestamp}.${payload}`, so signatures are replay-safe
 * within a configurable tolerance window.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { SignatureError } from "./types.js";

export const SIGNATURE_HEADER = "webhook-signature";
export const TIMESTAMP_HEADER = "webhook-timestamp";
export const ID_HEADER = "webhook-id";

/** Default replay window: signatures older than 5 minutes are rejected. */
export const DEFAULT_TOLERANCE_SEC = 300;

function hmacHex(secret: string, signed: string): string {
  return createHmac("sha256", secret).update(signed, "utf8").digest("hex");
}

/** Produce the full `webhook-signature` header value for a payload. */
export function signPayload(secret: string, payload: string, timestampSec: number): string {
  return `t=${timestampSec},v1=${hmacHex(secret, `${timestampSec}.${payload}`)}`;
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) {
    // Compare against a self-comparison to keep timing uniform on length mismatch.
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

/**
 * Verify a `webhook-signature` header against a raw payload.
 * Accepts multiple space-separated v1 values (key-rotation window).
 * Throws SignatureError with a precise reason on failure.
 */
export function verifySignature(
  secret: string,
  payload: string,
  header: string,
  timestampSec: number,
  toleranceSec: number = DEFAULT_TOLERANCE_SEC,
  nowSec: number = Math.floor(Date.now() / 1000),
): void {
  if (typeof timestampSec !== "number" || !Number.isInteger(timestampSec)) {
    throw new SignatureError("timestamp must be an integer unix second");
  }
  const age = Math.abs(nowSec - timestampSec);
  if (age > toleranceSec) {
    throw new SignatureError(
      `timestamp outside tolerance window (${age}s > ${toleranceSec}s)`,
    );
  }

  const parts = header.split(",").map((p) => p.trim());
  const tPart = parts.find((p) => p.startsWith("t="));
  if (!tPart) throw new SignatureError("missing t= component");
  const headerTs = Number(tPart.slice(2));
  if (headerTs !== timestampSec) {
    throw new SignatureError("header timestamp does not match webhook-timestamp");
  }

  const candidates = parts
    .filter((p) => p.startsWith("v1="))
    .map((p) => p.slice(3))
    .filter((v) => v.length > 0);
  if (candidates.length === 0) throw new SignatureError("missing v1= signature");

  const expected = hmacHex(secret, `${timestampSec}.${payload}`);
  for (const candidate of candidates) {
    if (safeEqual(candidate, expected)) return;
  }
  throw new SignatureError("signature mismatch");
}
