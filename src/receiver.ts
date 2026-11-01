/**
 * Receiver-side helpers: verify an incoming webhook against the same
 * signing scheme the dispatcher uses, then parse its envelope.
 */
import { DEFAULT_TOLERANCE_SEC, ID_HEADER, SIGNATURE_HEADER, TIMESTAMP_HEADER, verifySignature } from "./signer.js";
import { SignatureError, ValidationError } from "./types.js";
import type { WebhookEnvelope } from "./dispatcher.js";

export interface IncomingWebhook {
  headers: Record<string, string>;
  rawBody: string;
}

export interface VerifyOptions {
  toleranceSec?: number;
  nowSec?: number;
}

export type VerifyResult =
  | { readonly valid: true; readonly envelope: WebhookEnvelope }
  | { readonly valid: false; readonly reason: string };

/** Verify headers + raw body against `secret`. Never throws for bad input; returns a reason. */
export function verifyWebhook(secret: string, incoming: IncomingWebhook, options: VerifyOptions = {}): VerifyResult {
  const { headers, rawBody } = incoming;
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;

  const sig = lower[SIGNATURE_HEADER];
  const ts = lower[TIMESTAMP_HEADER];
  if (!sig) return { valid: false, reason: `missing ${SIGNATURE_HEADER} header` };
  if (!ts) return { valid: false, reason: `missing ${TIMESTAMP_HEADER} header` };

  const tsNum = Number(ts);
  try {
    verifySignature(
      secret,
      rawBody,
      sig,
      tsNum,
      options.toleranceSec ?? DEFAULT_TOLERANCE_SEC,
      options.nowSec ?? Math.floor(Date.now() / 1000),
    );
  } catch (err) {
    if (err instanceof SignatureError) return { valid: false, reason: err.message };
    return { valid: false, reason: "verification failed" };
  }

  let envelope: WebhookEnvelope;
  try {
    envelope = JSON.parse(rawBody) as WebhookEnvelope;
  } catch {
    return { valid: false, reason: "body is not valid JSON" };
  }
  if (typeof envelope?.id !== "string" || typeof envelope?.event !== "string" || typeof envelope?.created !== "number") {
    return { valid: false, reason: "body is not a webhook envelope (id/event/created/data)" };
  }
  return { valid: true, envelope };
}

/** Convenience: verify + JSON.parse, throwing ValidationError on any failure. */
export function requireWebhook<T = WebhookEnvelope>(secret: string, incoming: IncomingWebhook, options: VerifyOptions = {}): T {
  const result = verifyWebhook(secret, incoming, options);
  if (!result.valid) throw new ValidationError(result.reason);
  return result.envelope as T;
}
