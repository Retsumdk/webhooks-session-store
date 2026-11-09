# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-11-09

First tagged release. This is the state the README describes, at the version
`package.json` already declared (`1.0.0`); no source changed for the tag.

### Added

- Sessions: a subscription record (URL, signing secret, event filter) with an
  `active` / `suspended` switch. A suspended session keeps its pending
  deliveries, they are simply skipped while it is suspended.
- Deliveries: one event for one session, carrying the full attempt history
  (timestamp, status code, error, duration) rather than a single "last
  attempt" field.
- `WebhookEngine`: `registerSession`, `dispatch`, `processDue`, `replay`,
  `listDeliveries` and `stats`, with the clock and the HTTP transport
  injectable so the engine is deterministic under test.
- `signPayload` / `verifySignature` / `verifyWebhook`: Stripe-style headers
  (`webhook-id`, `webhook-timestamp`, `webhook-signature: t=<unix>,v1=<hex
  hmac-sha256 of "<ts>.<body>">`). `verifySignature` accepts several `v1=`
  values for key rotation and rejects timestamps outside the tolerance window
  (default 5 minutes).
- Deterministic backoff: `min(base * 2^(n-1) * (1 + 0.2 * jitter), max)` where
  `jitter` is the first 32 bits of `sha256(id:n)`, so a schedule is reproducible
  from the delivery id and attempt number with no global RNG. Defaults: base
  1s, max 10 min, 8 attempts.
- Outcome classification: 2xx is delivered, 408/429/5xx and network errors are
  retried, any other 4xx is a permanent failure.
- Replay: any terminal delivery can be re-queued after the receiver is fixed.
- Append-only JSONL persistence (`sessions.jsonl`, `deliveries.jsonl`) that
  rehydrates on construction, plus an in-memory mode with no directory.
  Corrupt records fail loudly with a `file:line` reference instead of being
  skipped. Writes go through a temporary file and a rename.
- A `whs` CLI (`demo`, `session add|list|status`, `dispatch`, `process`,
  `deliveries`, `replay`, `stats`, `serve`) with documented exit codes, and a
  zero-dependency `node:http` API whose writes require
  `Authorization: Bearer $WHS_TOKEN`.
- A deterministic demo (`whs demo`) and a CI check (`bun run verify:demo`)
  that compares its output against the committed transcript.

### Notes on scope

Stated plainly so nobody installs this expecting more than it does:

- There is no internal retry timer. `setTimeout` appears once, as the abort
  timeout for an HTTP attempt; a retry only happens when something calls
  `processDue` (a cron, the CLI, or `POST /process`).
- Unary delivery only: one signed POST per attempt, no batching, no ordering
  guarantee between deliveries, and no streaming or SSE.
- One process per state directory: there is no file lock, so two processes
  writing the same `--dir` can interleave.
- The HTTP server does one JWT-free bearer check, caps a request body at 1 MB,
  and has no rate limiting, TLS, pagination or UI. Put it behind a proxy if it
  is reachable from anywhere untrusted.
- The package is not published to npm. The install path is
  `npm install github:Retsumdk/webhooks-session-store`, which runs the
  `prepare` step (`tsc`) to build `dist/`.
- `bun test` covers 47 cases across 8 files; the suite uses injected clocks and
  transports, so it does not exercise a real network.

[1.0.0]: https://github.com/Retsumdk/webhooks-session-store/releases/tag/v1.0.0
