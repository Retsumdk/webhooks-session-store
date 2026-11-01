/**
 * WebhookEngine: the orchestration layer tying the store, signer, backoff,
 * and dispatcher together. Clock and host are injectable, so the entire
 * engine is deterministic under test.
 */
import { DEFAULT_BASE_DELAY_MS, DEFAULT_MAX_DELAY_MS, nextDelayMs } from "./backoff.js";
import { attemptDelivery, classify, DeliveryHost } from "./dispatcher.js";
import { WebhookStore, SessionInput } from "./store.js";
import { Attempt, Delivery, Session, ValidationError } from "./types.js";

export interface EngineOptions {
  store: WebhookStore;
  clock?: () => number;
  host?: DeliveryHost;
  /** Retry attempts per delivery before it is marked exhausted. */
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

export interface ProcessResult {
  readonly deliveryId: string;
  readonly sessionId: string;
  readonly kind: "delivered" | "retry" | "permanent" | "exhausted";
  readonly attempts: number;
  readonly nextAttemptAt: number | null;
}

export interface EngineStats {
  sessions: number;
  activeSessions: number;
  deliveries: Record<string, number>;
  totalAttempts: number;
  maxAttempts: number;
}

export class WebhookEngine {
  readonly store: WebhookStore;
  private readonly clock: () => number;
  private readonly host: DeliveryHost;
  readonly maxAttempts: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;

  constructor(options: EngineOptions) {
    this.store = options.store;
    this.clock = options.clock ?? Date.now;
    this.host = options.host ?? (() => { throw new Error("no DeliveryHost configured"); });
    this.maxAttempts = options.maxAttempts ?? 8;
    this.baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
    this.maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
    if (this.maxAttempts < 1) throw new ValidationError("maxAttempts must be >= 1");
  }

  registerSession(input: SessionInput): Session {
    return this.store.addSession(input, this.clock());
  }

  getSession(id: string): Session {
    return this.store.getSession(id);
  }

  listSessions(): Session[] {
    return this.store.listSessions();
  }

  setSessionStatus(id: string, status: Session["status"]): Session {
    return this.store.setSessionStatus(id, status);
  }

  /** Queue a delivery. The session must exist, be active, and subscribe to `event`. */
  dispatch(sessionId: string, event: string, payload: unknown): Delivery {
    const session = this.store.getSession(sessionId);
    if (session.status !== "active") {
      throw new ValidationError(`session ${sessionId} is ${session.status}; deliveries are rejected`);
    }
    return this.store.createDelivery(session, event, payload, this.clock());
  }

  /**
   * Run every due pending delivery (oldest-first, capped at `limit`).
   * Suspended sessions are skipped and left pending, so deliveries resume
   * when the session is re-enabled.
   */
  async processDue(nowMs: number = this.clock(), limit: number = 10): Promise<ProcessResult[]> {
    if (!Number.isInteger(limit) || limit < 1) throw new ValidationError("limit must be a positive integer");
    const due = this.store.dueDeliveries(nowMs, limit);
    const results: ProcessResult[] = [];
    for (const pending of due) {
      const delivery = this.store.getDelivery(pending.id);
      const session = this.store.peekSession(delivery.sessionId);
      if (!session || session.status !== "active") continue; // skipped: stays pending
      const attemptN = delivery.attempts.length + 1;
      const raw = await attemptDelivery(session, delivery, this.host, nowMs);
      const attempt: Attempt = { ...raw, n: attemptN };
      const outcome = classify(attempt.statusCode, attempt.error);
      const attempts = [...delivery.attempts, attempt];

      let status: Delivery["status"];
      let nextAttemptAt: number | null = null;
      if (outcome.kind === "delivered") {
        status = "delivered";
      } else if (outcome.kind === "permanent") {
        status = "failed";
      } else if (attemptN >= this.maxAttempts) {
        status = "exhausted";
      } else {
        status = "pending";
        nextAttemptAt = nowMs + nextDelayMs(delivery.id, attemptN, this.baseDelayMs, this.maxDelayMs);
      }

      const updated: Delivery = {
        ...delivery,
        attempts,
        status,
        nextAttemptAt,
        deliveredAt: status === "delivered" ? attempt.at : delivery.deliveredAt,
        lastError: outcome.error,
      };
      this.store.updateDelivery(updated);

      if (status === "delivered") {
        if (session.failureCount !== 0) this.store.putSession({ ...session, failureCount: 0 });
      } else {
        this.store.putSession({ ...session, failureCount: session.failureCount + 1 });
      }

      results.push({
        deliveryId: updated.id,
        sessionId: updated.sessionId,
        kind: status === "pending" ? "retry" : status === "failed" ? "permanent" : status,
        attempts: attempts.length,
        nextAttemptAt,
      });
    }
    return results;
  }

  /** Re-queue a terminal delivery (delivered, failed, or exhausted) for another run. */
  replay(deliveryId: string): Delivery {
    const delivery = this.store.getDelivery(deliveryId);
    if (delivery.status === "pending") {
      throw new ValidationError(`delivery ${deliveryId} is already pending`);
    }
    const now = this.clock();
    const updated: Delivery = {
      ...delivery,
      status: "pending",
      nextAttemptAt: now,
      lastError: null,
    };
    this.store.updateDelivery(updated);
    return updated;
  }

  listDeliveries(filter?: { sessionId?: string; status?: Delivery["status"] }): Delivery[] {
    return this.store.listDeliveries(filter);
  }

  stats(): EngineStats {
    const s = this.store.stats();
    return { ...s, maxAttempts: this.maxAttempts };
  }
}
