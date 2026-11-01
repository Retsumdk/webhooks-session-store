# webhooks-session-store

Durable outbound webhook delivery sessions with HMAC-signed payloads, deterministic
retry backoff, suspension/replay semantics, and a receiver-side verifier.
Zero runtime dependencies; Node >= 18 or Bun.

## The problem

Outbound webhooks fail constantly — receivers time out, deploy, rate-limit, or
return 500s — and most integrations handle this with a fire-and-forget `fetch`
plus, if you're lucky, one retry. That loses events silently. What you actually
need is a durable record of *every* delivery attempt, signatures your receiver
can verify, backoff that never synchronizes across endpoints, and a way to
re-queue a delivery after you've fixed the receiver. Building that ad hoc per
project is where delivery bugs come from.

## The solution

`webhooks-session-store` is a small, dependency-free library + CLI + HTTP API
that models outbound webhooks as first-class records:

- **Sessions** — a subscription (URL + signing secret + event filter) with an
  `active`/`suspended` switch.
- **Deliveries** — one event × one session, with the full attempt history
  (timestamp, status code, error, duration) retained forever.
- **A dispatcher** — signs each payload (`t=<unix>,v1=<hmac>` header scheme,
  Stripe-style), classifies the outcome (2xx → delivered; 408/429/5xx/network
  → retry; other 4xx → permanent failure), and schedules the next attempt.
- **Deterministic backoff** — exponential with jitter derived from a SHA-256
  of `(delivery id, attempt number)`, so schedules are reproducible in tests
  without a global RNG.
- **Replay** — any terminal delivery can be re-queued after a receiver fix.

Compared with rolling your own: the store is append-only JSONL with shape
guards (corrupt files fail loudly with a `file:line` reference, never silently
skipped), the clock and HTTP transport are injectable so the entire engine is
deterministic under test, and there is nothing to configure before your first
delivery.

## How it works

```
registerSession ──▶ dispatch ──▶ Delivery(pending, nextAttemptAt=now)
                                     │
                          processDue(now)  ◀── cron / CLI / server loop
                                     │
                        attemptDelivery (signed POST)
                                     │
                 classify ──┬── 2xx        → delivered (terminal)
                            ├── 408/429/5xx → pending + backoff(attempt n)
                            ├── network err → pending + backoff
                            └── other 4xx   → failed (permanent)
```

- **Signing** — the body is a JSON envelope `{id, event, created, data}`;
  headers are `webhook-id`, `webhook-timestamp`, and
  `webhook-signature: t=<unix>,v1=<hex hmac-sha256 of "<ts>.<body>">`.
  `verifySignature` accepts multiple `v1=` values (key rotation) and rejects
  timestamps outside a configurable tolerance window (default 5 minutes).
- **Backoff** — `delay(n) = min(base · 2^(n-1) · (1 + 0.2 · jitter), max)`,
  with `jitter = sha256(id:n)[0..4] / 2^32`. Defaults: base 1s, max 10min,
  8 attempts per delivery.
- **Failure accounting** — consecutive failures increment the session's
  `failureCount`; any success resets it to 0. Suspend a session to pause
  deliveries without deleting it; due deliveries are skipped and stay pending.
- **Persistence** — `sessions.jsonl` + `deliveries.jsonl`, append-only,
  rehydrated on construction. In-memory mode (no directory) for tests/demos.

## Getting started

Clone and run (Bun):

```bash
git clone https://github.com/Retsumdk/webhooks-session-store.git
cd webhooks-session-store
bun install
bun run demo
```

Or with Node 20+:

```bash
npm install
npm run build
node dist/cli-main.js demo
```

Install from GitHub (the package is not on npm):

```bash
npm install github:Retsumdk/webhooks-session-store
# Bun users: lifecycle scripts are blocked by default, so trust once:
#   bun add github:Retsumdk/webhooks-session-store && bun pm trust webhooks-session-store
```

## CLI

```bash
whs demo                                             # deterministic demo report
whs session add --url https://r.example/h --secret <>=16chars --events invoice.paid,user.created
whs session list [--dir DIR]
whs session status --id wh_… --status active|suspended [--dir DIR]
whs dispatch --session wh_… --event invoice.paid --payload '{"inv":"a1"}'
whs process [--limit 10] [--dir DIR]                 # deliver everything currently due
whs deliveries [--session wh_…] [--status pending|delivered|failed|exhausted]
whs replay --id dl_… [--dir DIR]
whs stats [--dir DIR]
whs serve [--port 8077] [--dir DIR]                  # writes need WHS_TOKEN
```

Exit codes: `0` ok · `2` usage/validation · `3` corrupt store · `4` not found · `5` signature.

A real round-trip (state survives across processes via `--dir`):

```
$ whs session add --url https://hooks.example.com/ingest --secret cli-walkthrough-secret \
    --events invoice.paid --dir /tmp/whs
created wh_a907db88130a2f2b -> https://hooks.example.com/ingest
$ whs dispatch --session wh_a907db88130a2f2b --event invoice.paid --payload '{"inv":"a1"}' --dir /tmp/whs
dl_b27b991aa0d1aac0 wh_a907db88130a2f2b invoice.paid status=pending attempts=0
$ whs session status --id wh_a907db88130a2f2b --status suspended --dir /tmp/whs
wh_a907db88130a2f2b suspended
$ whs process --dir /tmp/whs
processed 0                       # suspended: skipped, stays pending
$ whs session status --id wh_a907db88130a2f2b --status active --dir /tmp/whs
wh_a907db88130a2f2b active
$ whs process --dir /tmp/whs
dl_b27b991aa0d1aac0 kind=retry attempts=1 next=2026-11-01T21:09:07.062Z
processed 1
```

(`next=…` is a real retry: `hooks.example.com` is not reachable, so the
delivery is re-scheduled with seeded-jitter backoff.)

## HTTP API

Reads are open; writes require `Authorization: Bearer $WHS_TOKEN`
(the server refuses writes with `503` when the token is unset, rather than
being open by accident).

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/health` | – | liveness |
| GET | `/stats` | – | session/delivery/attempt counters |
| GET | `/sessions` | – | all sessions |
| GET | `/deliveries?sessionId=&status=` | – | filtered, oldest-first |
| POST | `/sessions` | bearer | `{url, secret, events}` → 201 (identical payload → 200, idempotent) |
| POST | `/dispatch` | bearer | `{sessionId, event, payload}` → 201 |
| POST | `/process` | bearer | `{limit}` → results |
| POST | `/replay` | bearer | `{deliveryId}` → re-queued delivery |
| POST | `/sessions/:id/status` | bearer | `{status}` → updated session |

```bash
export WHS_TOKEN=opensesame
curl -s localhost:8077/stats
curl -s -X POST localhost:8077/sessions \
  -H "authorization: Bearer $WHS_TOKEN" -H 'content-type: application/json' \
  -d '{"url":"https://r.example/h","secret":"a-string-at-least-16","events":["evt.a"]}'
curl -s -X POST localhost:8077/dispatch \
  -H "authorization: Bearer $WHS_TOKEN" -H 'content-type: application/json' \
  -d '{"sessionId":"wh_…","event":"evt.a","payload":{"x":1}}'
```

Errors map to codes: validation → 400, unknown id → 404, bad auth → 401.

## Library

```ts
import { WebhookEngine, WebhookStore, verifyWebhook } from "webhooks-session-store";

const engine = new WebhookEngine({ store: new WebhookStore("./whs-data") });
const session = engine.registerSession({
  url: "https://receiver.example/hooks",
  secret: "rotate-me-regularly-0123",
  events: ["invoice.paid"],
});
const delivery = engine.dispatch(session.id, "invoice.paid", { invoice: "inv_1", amount: 4200 });
const results = await engine.processDue();      // due attempts run now
console.log(results[0].kind, delivery.id);      // e.g. "retry dl_…"

// Receiver side — verify an incoming request against the same scheme:
const verdict = verifyWebhook("rotate-me-regularly-0123", {
  headers: req.headers,      // webhook-id / -timestamp / -signature
  rawBody: rawRequestBody,   // verify the exact bytes you received
});
if (!verdict.valid) return res.status(400).send(verdict.reason);
console.log(verdict.envelope.event, verdict.envelope.data);
```

## Demo output

`bun run demo` is byte-diff-enforced in CI (`scripts/verify-demo.ts`); the
checked-in expectation lives in `src/demo-output.ts`:

```
sessions
wh_f5678083d6576601 active https://flaky.example.com/hooks events=invoice.paid,invoice.void
wh_09341d0f08a82326 active https://strict.example.com/hooks events=invoice.paid

dispatched dl_c38c741febfae6a3 dl_f5130c907b3975d4
round 1 dl_c38c741febfae6a3 wh_f5678083d6576601 invoice.paid status=pending attempts=1 last=500 kind=retry next=2026-01-01T00:00:01.061Z
round 1 dl_f5130c907b3975d4 wh_09341d0f08a82326 invoice.paid status=failed attempts=1 last=400 kind=permanent next=-
round 2 dl_c38c741febfae6a3 wh_f5678083d6576601 invoice.paid status=delivered attempts=2 last=200 kind=delivered next=-

suspended wh_09341d0f08a82326
stats {"sessions":2,"activeSessions":1,"deliveries":{"pending":0,"delivered":1,"failed":1,"exhausted":0},"totalAttempts":3,"maxAttempts":4}
```

The flaky endpoint 500s twice then succeeds (retry path); the strict endpoint
answers 400 (permanent failure, no retries burned); the session is suspended
afterwards. Fixed clock, scripted transport, no network.

## Scope

This store does outbound delivery of events you already have. It does not do
ingress (the receiver-side verifier in `src/receiver.ts` is included so the
signing scheme is verifiable end-to-end), fan-out across providers, or
exactly-once guarantees — receivers must deduplicate on `webhook-id`, which is
stable across replay.

## License

MIT — see [LICENSE](./LICENSE).
