/**
 * Zero-dependency HTTP API (node:http) over a WebhookEngine.
 *
 * Reads are open; every write requires `Authorization: Bearer <WHS_TOKEN>`.
 * If WHS_TOKEN is unset, write routes reject with 503 rather than being open.
 */
import { createServer, IncomingMessage, Server, ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { WebhookEngine } from "./engine.js";
import { NotFoundError, ValidationError, WhsError } from "./types.js";
import { defaultHost } from "./dispatcher.js";
import { WebhookStore } from "./store.js";

const MAX_BODY_BYTES = 1_000_000;

function bearerOk(req: IncomingMessage): boolean {
  const token = process.env.WHS_TOKEN;
  if (!token) return false;
  const auth = req.headers.authorization ?? "";
  if (!auth.startsWith("Bearer ")) return false;
  const provided = Buffer.from(auth.slice(7), "utf8");
  const expected = Buffer.from(token, "utf8");
  if (provided.length !== expected.length) {
    timingSafeEqual(provided, provided);
    return false;
  }
  return timingSafeEqual(provided, expected);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
  res.end(payload);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new ValidationError("body exceeds 1MB"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export interface ServeOptions {
  engine: WebhookEngine;
  port: number;
  host?: string;
}

export function startServer(options: ServeOptions): Server {
  const { engine, port } = options;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);
    const path = url.pathname;
    try {
      if (req.method === "GET" && path === "/health") {
        sendJson(res, 200, { ok: true });
        return;
      }
      if (req.method === "GET" && path === "/stats") {
        sendJson(res, 200, engine.stats());
        return;
      }
      if (req.method === "GET" && path === "/sessions") {
        sendJson(res, 200, { sessions: engine.listSessions() });
        return;
      }
      if (req.method === "GET" && path === "/deliveries") {
        const sessionId = url.searchParams.get("sessionId") ?? undefined;
        const statusParam = url.searchParams.get("status") ?? undefined;
        const filter: { sessionId?: string; status?: "pending" | "delivered" | "failed" | "exhausted" } = {};
        if (sessionId) filter.sessionId = sessionId;
        if (statusParam) {
          if (!["pending", "delivered", "failed", "exhausted"].includes(statusParam)) {
            throw new ValidationError(`unknown status "${statusParam}"`);
          }
          filter.status = statusParam as "pending" | "delivered" | "failed" | "exhausted";
        }
        sendJson(res, 200, { deliveries: engine.listDeliveries(filter) });
        return;
      }
      if (req.method === "POST" && (path === "/sessions" || path === "/dispatch" || path === "/replay" || path === "/process" || path.startsWith("/sessions/") && path.endsWith("/status"))) {
        if (!bearerOk(req)) {
          sendJson(res, process.env.WHS_TOKEN ? 401 : 503, { error: process.env.WHS_TOKEN ? "unauthorized" : "WHS_TOKEN not configured; writes disabled" });
          return;
        }
        const bodyText = await readBody(req);
        let body: Record<string, unknown> = {};
        if (bodyText.trim() !== "") {
          try {
            body = JSON.parse(bodyText) as Record<string, unknown>;
          } catch {
            throw new ValidationError("body is not valid JSON");
          }
        }
        if (path === "/sessions") {
          try {
            const session = engine.registerSession({
              url: String(body.url ?? ""),
              secret: String(body.secret ?? ""),
              events: Array.isArray(body.events) ? body.events.map(String) : [],
            });
            sendJson(res, 201, { session: { ...session, secret: `${session.secret.slice(0, 4)}…` } });
          } catch (err) {
            // Session ids are content hashes: an identical POST is idempotent.
            if (err instanceof ValidationError && /already exists/.test(err.message)) {
              const sessions = engine.listSessions();
              const existing = sessions.find((s) => s.url === String(body.url ?? "") && s.secret === String(body.secret ?? ""));
              if (existing) {
                sendJson(res, 200, { session: { ...existing, secret: `${existing.secret.slice(0, 4)}…` } });
                return;
              }
            }
            throw err;
          }
          return;
        }
        const statusMatch = /^\/sessions\/([^/]+)\/status$/.exec(path);
        if (statusMatch) {
          const status = body.status === "suspended" || body.status === "active" ? body.status : null;
          if (!status) throw new ValidationError('body.status must be "active" or "suspended"');
          const session = engine.setSessionStatus(statusMatch[1] as string, status);
          sendJson(res, 200, { session });
          return;
        }
        if (path === "/dispatch") {
          const delivery = engine.dispatch(String(body.sessionId ?? ""), String(body.event ?? ""), body.payload);
          sendJson(res, 201, { delivery });
          return;
        }
        if (path === "/replay") {
          const delivery = engine.replay(String(body.deliveryId ?? ""));
          sendJson(res, 200, { delivery });
          return;
        }
        if (path === "/process") {
          const limit = body.limit === undefined ? 10 : Number(body.limit);
          const results = await engine.processDue(undefined, limit);
          sendJson(res, 200, { results });
          return;
        }
      }
      sendJson(res, 404, { error: `no route for ${req.method} ${path}` });
    } catch (err) {
      if (err instanceof WhsError) {
        const status = err instanceof NotFoundError ? 404 : err instanceof ValidationError ? 400 : 400;
        sendJson(res, status, { error: err.message, code: err.code });
        return;
      }
      sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  });
  server.listen(port, options.host ?? "127.0.0.1");
  return server;
}

/** CLI entry for `whs serve`. Blocks until the process is killed. */
export function runServe(port: number, dir: string | null): void {
  const engine = new WebhookEngine({ store: new WebhookStore(dir), host: defaultHost() });
  const server = startServer({ engine, port });
  server.on("listening", () => {
    console.log(`whs listening on http://127.0.0.1:${port}`);
  });
}
