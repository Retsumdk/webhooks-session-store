/**
 * Deterministic demo: a fixed clock, a scripted host, two sessions, retries,
 * a permanent failure, and a suspension — printed as a stable report.
 * `verify:demo` and the test suite diff-enforce this against demo-output.ts.
 */
import { WebhookEngine } from "./engine.js";
import { DeliveryHost } from "./dispatcher.js";
import { WebhookStore } from "./store.js";
import { renderDeliveryLine, renderSessionLine } from "./report.js";

export const DEMO_EPOCH = 1_767_225_600_000; // 2026-01-01T00:00:00Z

/** Host script: flaky endpoint 500s twice then 200s; strict endpoint 400s immediately. */
export function scriptedHost(): { host: DeliveryHost; callCount: () => number } {
  let calls = 0;
  const host: DeliveryHost = (url) => {
    calls += 1;
    if (url.includes("flaky.example.com")) {
      return Promise.resolve({ status: calls <= 2 ? 500 : 200 });
    }
    if (url.includes("strict.example.com")) {
      return Promise.resolve({ status: 400 });
    }
    return Promise.resolve({ status: 200 });
  };
  return { host, callCount: () => calls };
}

export async function renderDemo(): Promise<string> {
  const lines: string[] = [];
  let now = DEMO_EPOCH;
  const clock = () => now;
  const { host } = scriptedHost();
  const engine = new WebhookEngine({ store: new WebhookStore(), clock, host, maxAttempts: 4 });

  const flaky = engine.registerSession({
    url: "https://flaky.example.com/hooks",
    secret: "flaky-endpoint-signing-secret",
    events: ["invoice.paid", "invoice.void"],
  });
  const strict = engine.registerSession({
    url: "https://strict.example.com/hooks",
    secret: "strict-endpoint-signing-secret",
    events: ["invoice.paid"],
  });

  lines.push("sessions");
  for (const s of engine.listSessions()) lines.push(renderSessionLine(s));

  const d1 = engine.dispatch(flaky.id, "invoice.paid", { invoice: "inv_001", amount: 4200 });
  const d2 = engine.dispatch(strict.id, "invoice.paid", { invoice: "inv_002", amount: 1500 });
  lines.push("");
  lines.push(`dispatched ${d1.id} ${d2.id}`);

  for (let round = 1; round <= 3; round++) {
    const results = await engine.processDue(now);
    for (const r of results) {
      const delivery = engine.store.getDelivery(r.deliveryId);
      const next = r.nextAttemptAt === null ? "-" : new Date(r.nextAttemptAt).toISOString();
      lines.push(`round ${round} ${renderDeliveryLine(delivery)} kind=${r.kind} next=${next}`);
    }
    now += 5 * 60 * 1000;
  }

  engine.setSessionStatus(strict.id, "suspended");
  lines.push("");
  lines.push(`suspended ${strict.id}`);
  lines.push(`stats ${JSON.stringify(engine.stats())}`);
  return lines.join("\n") + "\n";
}
