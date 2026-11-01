/**
 * The HTTP side of delivery: builds the signed request, executes it through
 * an injectable host (for tests/demos), and classifies the outcome.
 *
 * Retry semantics:
 *   2xx                      -> delivered (terminal)
 *   408 / 429 / 5xx / network -> retry (transient)
 *   other 4xx                -> permanent failure (endpoint rejects this event)
 */
import { signPayload, ID_HEADER, SIGNATURE_HEADER, TIMESTAMP_HEADER } from "./signer.js";
import { Attempt, AttemptOutcome, Session } from "./types.js";

export interface HostResponse {
  status: number;
}

/** Transport SPI so tests and demos never touch the network. */
export interface DeliveryHost {
  (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }): Promise<HostResponse>;
}

export function defaultHost(timeoutMs: number = 10_000): DeliveryHost {
  return async (url, init) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    return fetch(url, {
      method: init.method,
      headers: init.headers,
      body: init.body,
      signal: controller.signal,
    })
      .then((res) => ({ status: res.status }))
      .finally(() => clearTimeout(timer));
  };
}

/** The JSON envelope receivers see. */
export interface WebhookEnvelope {
  id: string;
  event: string;
  created: number;
  data: unknown;
}

export function buildEnvelope(deliveryId: string, event: string, createdAt: number, payload: unknown): WebhookEnvelope {
  return { id: deliveryId, event, created: Math.floor(createdAt / 1000), data: payload };
}

export function classify(statusCode: number | null, error: string | null): AttemptOutcome {
  if (statusCode === null) return { kind: "retry", statusCode: null, error: error ?? "network error" };
  if (statusCode >= 200 && statusCode < 300) return { kind: "delivered", statusCode, error: null };
  if (statusCode === 408 || statusCode === 429 || statusCode >= 500) {
    return { kind: "retry", statusCode, error: error ?? `HTTP ${statusCode}` };
  }
  return { kind: "permanent", statusCode, error: error ?? `HTTP ${statusCode}` };
}

/** Execute one signed delivery attempt and produce its Attempt record. */
export async function attemptDelivery(
  session: Session,
  delivery: { id: string; event: string; createdAt: number; payload: unknown },
  host: DeliveryHost,
  nowMs: number = Date.now(),
): Promise<Attempt> {
  const envelope = buildEnvelope(delivery.id, delivery.event, delivery.createdAt, delivery.payload);
  const body = JSON.stringify(envelope);
  const timestampSec = Math.floor(nowMs / 1000);
  const signature = signPayload(session.secret, body, timestampSec);

  const startedAt = nowMs;
  let statusCode: number | null = null;
  let error: string | null = null;
  try {
    const res = await host(session.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [ID_HEADER]: delivery.id,
        [TIMESTAMP_HEADER]: String(timestampSec),
        [SIGNATURE_HEADER]: signature,
      },
      body,
      signal: new AbortController().signal,
    });
    statusCode = res.status;
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  const durationMs = Date.now() - startedAt;
  const outcome = classify(statusCode, error);

  return {
    n: 0, // caller assigns the real attempt number
    at: startedAt,
    ok: outcome.kind === "delivered",
    statusCode: outcome.statusCode,
    error: outcome.error,
    durationMs,
  };
}
