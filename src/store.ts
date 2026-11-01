/**
 * Append-only JSONL persistence for sessions and deliveries, with an
 * in-memory mode (no `dir`) used by tests, demos, and ephemeral servers.
 *
 * Every rehydrated record is shape-guarded; corrupt lines fail loudly with
 * StoreCorruptError rather than being skipped.
 */
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  Delivery,
  DeliveryStatus,
  Session,
  SessionStatus,
  NotFoundError,
  StoreCorruptError,
  ValidationError,
} from "./types.js";

const SESSIONS_FILE = "sessions.jsonl";
const DELIVERIES_FILE = "deliveries.jsonl";

const URL_RE = /^https?:\/\/[^\s]+$/i;
const MIN_SECRET_LENGTH = 16;

function shortId(seed: string): string {
  return createHash("sha256").update(seed).digest("hex").slice(0, 16);
}

function assertSessionShape(v: unknown): Session {
  if (typeof v !== "object" || v === null) throw new StoreCorruptError("session record is not an object");
  const s = v as Record<string, unknown>;
  for (const key of ["id", "url", "secret", "createdAt"]) {
    if (typeof s[key] !== "string") throw new StoreCorruptError(`session.${key} must be a string`);
  }
  if (!Array.isArray(s.events) || s.events.some((e) => typeof e !== "string")) {
    throw new StoreCorruptError("session.events must be a string array");
  }
  if (s.status !== "active" && s.status !== "suspended") {
    throw new StoreCorruptError("session.status must be active|suspended");
  }
  if (typeof s.failureCount !== "number" || !Number.isInteger(s.failureCount) || s.failureCount < 0) {
    throw new StoreCorruptError("session.failureCount must be a non-negative integer");
  }
  return v as unknown as Session;
}

function assertDeliveryShape(v: unknown): Delivery {
  if (typeof v !== "object" || v === null) throw new StoreCorruptError("delivery record is not an object");
  const d = v as Record<string, unknown>;
  for (const key of ["id", "sessionId", "event"]) {
    if (typeof d[key] !== "string") throw new StoreCorruptError(`delivery.${key} must be a string`);
  }
  const statuses: DeliveryStatus[] = ["pending", "delivered", "failed", "exhausted"];
  if (typeof d.status !== "string" || !statuses.includes(d.status as DeliveryStatus)) {
    throw new StoreCorruptError("delivery.status is invalid");
  }
  if (!Array.isArray(d.attempts)) throw new StoreCorruptError("delivery.attempts must be an array");
  for (const a of d.attempts) {
    const rec = a as Record<string, unknown>;
    if (typeof rec?.n !== "number" || typeof rec?.at !== "number" || typeof rec?.ok !== "boolean") {
      throw new StoreCorruptError("delivery.attempts entry is malformed");
    }
  }
  if (typeof d.createdAt !== "number") throw new StoreCorruptError("delivery.createdAt must be a number");
  return v as unknown as Delivery;
}

function loadJsonl(path: string, guard: (v: unknown) => unknown): unknown[] {
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8");
  const out: unknown[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined || line.trim() === "") continue;
    try {
      out.push(guard(JSON.parse(line)));
    } catch (err) {
      if (err instanceof StoreCorruptError) {
        throw new StoreCorruptError(`${path}:${i + 1}: ${(err as Error).message}`);
      }
      throw new StoreCorruptError(`${path}:${i + 1}: invalid JSON`);
    }
  }
  return out;
}

export interface SessionInput {
  url: string;
  secret: string;
  events: readonly string[];
}

export interface DeliveryFilter {
  sessionId?: string;
  status?: DeliveryStatus;
}

export interface StoreStats {
  sessions: number;
  activeSessions: number;
  deliveries: Record<DeliveryStatus, number>;
  totalAttempts: number;
}

export class WebhookStore {
  private readonly sessions = new Map<string, Session>();
  private readonly deliveries = new Map<string, Delivery>();
  private readonly dir: string | null;
  private seq = 0;

  constructor(dir: string | null = null) {
    this.dir = dir;
    if (dir !== null) {
      mkdirSync(dir, { recursive: true });
      for (const raw of loadJsonl(join(dir, SESSIONS_FILE), assertSessionShape)) {
        const s = raw as Session;
        this.sessions.set(s.id, s);
      }
      for (const raw of loadJsonl(join(dir, DELIVERIES_FILE), assertDeliveryShape)) {
        const d = raw as Delivery;
        this.deliveries.set(d.id, d);
        this.seq = Math.max(this.seq, d.attempts.length);
      }
    }
  }

  private persist(kind: "sessions" | "deliveries", record: unknown): void {
    if (this.dir === null) return;
    appendFileSync(join(this.dir, kind === "sessions" ? SESSIONS_FILE : DELIVERIES_FILE), `${JSON.stringify(record)}\n`);
  }

  addSession(input: SessionInput, nowMs: number = Date.now()): Session {
    const { url, secret, events } = input;
    if (typeof url !== "string" || !URL_RE.test(url)) {
      throw new ValidationError("url must be an absolute http(s) URL");
    }
    if (typeof secret !== "string" || secret.length < MIN_SECRET_LENGTH) {
      throw new ValidationError(`secret must be at least ${MIN_SECRET_LENGTH} characters`);
    }
    if (!Array.isArray(events) || events.length === 0 || events.some((e) => typeof e !== "string" || e.length === 0)) {
      throw new ValidationError("events must be a non-empty array of non-empty strings");
    }
    if (new Set(events).size !== events.length) {
      throw new ValidationError("events must not contain duplicates");
    }
    const id = `wh_${shortId(`${url}\n${[...events].sort().join(",")}\n${secret}`)}`;
    if (this.sessions.has(id)) {
      throw new ValidationError(`an identical session already exists (${id})`);
    }
    const session: Session = {
      id,
      url,
      secret,
      events: [...events],
      status: "active",
      createdAt: new Date(nowMs).toISOString(),
      failureCount: 0,
    };
    this.sessions.set(id, session);
    this.persist("sessions", session);
    return session;
  }

  getSession(id: string): Session {
    const s = this.sessions.get(id);
    if (!s) throw new NotFoundError(`session ${id} not found`);
    return s;
  }

  /** Internal lookup that tolerates missing ids (used by processDue for pruned sessions). */
  peekSession(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  listSessions(): Session[] {
    return [...this.sessions.values()].sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  }

  /** Persist a full session record (e.g. failureCount bookkeeping by the engine). */
  putSession(session: Session): void {
    this.getSession(session.id);
    this.sessions.set(session.id, session);
    this.persist("sessions", session);
  }

  setSessionStatus(id: string, status: SessionStatus): Session {
    if (status !== "active" && status !== "suspended") {
      throw new ValidationError(`status must be "active" or "suspended", got ${JSON.stringify(status)}`);
    }
    const s = this.getSession(id);
    if (s.status === status) return s;
    const next: Session = { ...s, status };
    this.sessions.set(id, next);
    this.persist("sessions", next);
    return next;
  }

  createDelivery(session: Session, event: string, payload: unknown, nowMs: number): Delivery {
    if (!session.events.includes(event)) {
      throw new ValidationError(`event "${event}" is not subscribed by session ${session.id}`);
    }
    this.seq += 1;
    const body = JSON.stringify(payload ?? null);
    const id = `dl_${shortId(`${session.id}|${event}|${body}|${nowMs}|${this.seq}`)}`;
    const delivery: Delivery = {
      id,
      sessionId: session.id,
      event,
      payload,
      status: "pending",
      attempts: [],
      nextAttemptAt: nowMs,
      createdAt: nowMs,
      deliveredAt: null,
      lastError: null,
    };
    this.deliveries.set(id, delivery);
    this.persist("deliveries", delivery);
    return delivery;
  }

  getDelivery(id: string): Delivery {
    const d = this.deliveries.get(id);
    if (!d) throw new NotFoundError(`delivery ${id} not found`);
    return d;
  }

  peekDelivery(id: string): Delivery | undefined {
    return this.deliveries.get(id);
  }

  updateDelivery(delivery: Delivery): void {
    this.deliveries.set(delivery.id, delivery);
    this.persist("deliveries", delivery);
  }

  listDeliveries(filter: DeliveryFilter = {}): Delivery[] {
    let out = [...this.deliveries.values()];
    if (filter.sessionId !== undefined) out = out.filter((d) => d.sessionId === filter.sessionId);
    if (filter.status !== undefined) out = out.filter((d) => d.status === filter.status);
    return out.sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
  }

  /** Pending deliveries whose next attempt is due, oldest-first, capped at `limit`. */
  dueDeliveries(nowMs: number, limit: number): Delivery[] {
    return this.listDeliveries({ status: "pending" })
      .filter((d) => d.nextAttemptAt !== null && d.nextAttemptAt <= nowMs)
      .sort((a, b) => (a.nextAttemptAt as number) - (b.nextAttemptAt as number) || (a.id < b.id ? -1 : 1))
      .slice(0, limit);
  }

  stats(): StoreStats {
    const deliveries: Record<DeliveryStatus, number> = { pending: 0, delivered: 0, failed: 0, exhausted: 0 };
    let totalAttempts = 0;
    for (const d of this.deliveries.values()) {
      deliveries[d.status] += 1;
      totalAttempts += d.attempts.length;
    }
    const sessions = [...this.sessions.values()];
    return {
      sessions: sessions.length,
      activeSessions: sessions.filter((s) => s.status === "active").length,
      deliveries,
      totalAttempts,
    };
  }
}
