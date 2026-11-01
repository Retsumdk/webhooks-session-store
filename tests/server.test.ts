import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { startServer } from "../src/server.js";
import { WebhookEngine } from "../src/engine.js";
import { WebhookStore } from "../src/store.js";
import { signPayload, SIGNATURE_HEADER, TIMESTAMP_HEADER } from "../src/signer.js";
import type { Server } from "node:http";

const PORT = 18_077 + Math.floor(Math.random() * 500);
const TOKEN = "server-test-token";
const BASE = `http://127.0.0.1:${PORT}`;

const engine = new WebhookEngine({
  store: new WebhookStore(),
  clock: () => 1_767_225_600_000,
  host: async () => ({ status: 200 }),
});
let server: Server;
process.env.WHS_TOKEN = TOKEN;
afterAll(() => { server?.close(); delete process.env.WHS_TOKEN; });

async function post(path: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: any }> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

describe("HTTP API", () => {
  beforeAll(async () => {
    server = startServer({ engine, port: PORT });
    await new Promise((r) => server.on("listening", r)); // eslint-disable-line
  });

  test("GET /health and /stats are open", async () => {
    expect((await (await fetch(`${BASE}/health`)).json()).ok).toBe(true);
    const stats = await (await fetch(`${BASE}/stats`)).json();
    expect(stats.sessions).toBe(0);
  });

  test("writes require bearer auth; without WHS_TOKEN they would be 503", async () => {
    const unauth = await post("/sessions", { url: "https://a.example/h", secret: "server-secret-0123", events: ["e"] });
    expect(unauth.status).toBe(401);
    const bad = await post("/sessions", {}, { authorization: "Bearer wrong" });
    expect(bad.status).toBe(401);
  });

  test("session + dispatch + process round-trip", async () => {
    const created = await post("/sessions", { url: "https://srv.example/hooks", secret: "server-secret-0123", events: ["evt.a"] }, { authorization: `Bearer ${TOKEN}` });
    expect(created.status).toBe(201);
    expect(created.json.session.secret).toMatch(/^serv…/);
    const id = created.json.session.id;

    const dup = await post("/sessions", { url: "https://srv.example/hooks", secret: "server-secret-0123", events: ["evt.a"] }, { authorization: `Bearer ${TOKEN}` });
    expect(dup.status).toBe(200); // idempotent re-create returns the existing session
    expect(dup.json.session.id).toBe(id);

    const dispatched = await post("/dispatch", { sessionId: id, event: "evt.a", payload: { x: 1 } }, { authorization: `Bearer ${TOKEN}` });
    expect(dispatched.status).toBe(201);
    const deliveryId = dispatched.json.delivery.id as string;

    const badDispatch = await post("/dispatch", { sessionId: id, event: "evt.other", payload: null }, { authorization: `Bearer ${TOKEN}` });
    expect(badDispatch.status).toBe(400);

    const processed = await post("/process", { limit: 10 }, { authorization: `Bearer ${TOKEN}` });
    expect(processed.status).toBe(200);
    expect(processed.json.results[0].deliveryId).toBe(deliveryId);

    const list = await (await fetch(`${BASE}/deliveries?status=delivered&sessionId=${id}`)).json();
    expect(list.deliveries).toHaveLength(1);
  });

  test("replay + status routes and error mapping", async () => {
    const created = await post("/sessions", { url: "https://srv2.example/hooks", secret: "server-secret-0124", events: ["evt.a"] }, { authorization: `Bearer ${TOKEN}` });
    const id = created.json.session.id as string;
    const d = (await post("/dispatch", { sessionId: id, event: "evt.a", payload: null }, { authorization: `Bearer ${TOKEN}` })).json.delivery;
    await post("/process", { limit: 10 }, { authorization: `Bearer ${TOKEN}` });

    const replay = await post("/replay", { deliveryId: d.id }, { authorization: `Bearer ${TOKEN}` });
    expect(replay.status).toBe(200);
    expect(replay.json.delivery.status).toBe("pending");

    const suspended = await post(`/sessions/${id}/status`, { status: "suspended" }, { authorization: `Bearer ${TOKEN}` });
    expect(suspended.status).toBe(200);

    const missing = await post("/replay", { deliveryId: "dl_0000000000000000" }, { authorization: `Bearer ${TOKEN}` });
    expect(missing.status).toBe(404);

    const garbage = await post("/dispatch", { sessionId: "wh_0000000000000000" }, { authorization: `Bearer ${TOKEN}` });
    expect(garbage.status).toBe(404); // unknown session id is not-found
  });

  test("404 for unknown routes", async () => {
    const res = await fetch(`${BASE}/nope`);
    expect(res.status).toBe(404);
  });
});
