/**
 * Core data model and coded errors for webhooks-session-store.
 */

export type SessionStatus = "active" | "suspended";
export type DeliveryStatus = "pending" | "delivered" | "failed" | "exhausted";

/** An outbound webhook subscription: where to POST, with what secret, for which events. */
export interface Session {
  readonly id: string;
  readonly url: string;
  readonly secret: string;
  readonly events: readonly string[];
  status: SessionStatus;
  readonly createdAt: string;
  /** Consecutive failed attempts, reset to 0 on any success. */
  failureCount: number;
}

/** A single delivery of one event to one session. */
export interface Delivery {
  readonly id: string;
  readonly sessionId: string;
  readonly event: string;
  readonly payload: unknown;
  status: DeliveryStatus;
  readonly attempts: readonly Attempt[];
  /** Epoch ms of the next scheduled attempt; null once terminal. */
  nextAttemptAt: number | null;
  readonly createdAt: number;
  deliveredAt: number | null;
  lastError: string | null;
}

/** The record of one HTTP attempt against a session's endpoint. */
export interface Attempt {
  readonly n: number;
  readonly at: number;
  readonly ok: boolean;
  readonly statusCode: number | null;
  readonly error: string | null;
  readonly durationMs: number;
}

export type AttemptKind = "delivered" | "retry" | "permanent";

/** Classification of one attempt outcome, driving retry semantics. */
export interface AttemptOutcome {
  readonly kind: AttemptKind;
  readonly statusCode: number | null;
  readonly error: string | null;
}

/** Coded error hierarchy; `code` maps onto HTTP-ish categories, `exitCode` onto CLI exits. */
export class WhsError extends Error {
  readonly code: string;
  readonly exitCode: number;

  constructor(code: string, exitCode: number, message: string) {
    super(message);
    this.name = "WhsError";
    this.code = code;
    this.exitCode = exitCode;
  }
}

/** Bad input: invalid URL, empty secret, unknown event, malformed JSON. Exits 2. */
export class ValidationError extends WhsError {
  constructor(message: string) {
    super("VALIDATION", 2, message);
    this.name = "ValidationError";
  }
}

/** Unknown session or delivery id. Exits 4. */
export class NotFoundError extends WhsError {
  constructor(message: string) {
    super("NOT_FOUND", 4, message);
    this.name = "NotFoundError";
  }
}

/** On-disk JSONL failed to parse or has wrong-shaped records. Exits 3. */
export class StoreCorruptError extends WhsError {
  constructor(message: string) {
    super("STORE_CORRUPT", 3, message);
    this.name = "StoreCorruptError";
  }
}

/** Signature verification failed (bad or expired signature). Exits 5. */
export class SignatureError extends WhsError {
  constructor(message: string) {
    super("SIGNATURE", 5, message);
    this.name = "SignatureError";
  }
}
