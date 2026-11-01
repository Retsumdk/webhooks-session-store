/**
 * Shared rendering helpers for CLI, demo, and server outputs.
 */
import { Attempt, Delivery, Session } from "./types.js";

export function renderSessionLine(s: Session): string {
  const events = s.events.join(",");
  return `${s.id} ${s.status} ${s.url} events=${events}`;
}

export function renderDeliveryLine(d: Delivery): string {
  const last: Attempt | null = d.attempts.length > 0 ? d.attempts[d.attempts.length - 1]! : null;
  const attemptPart =
    last === null
      ? "attempts=0"
      : `attempts=${d.attempts.length} last=${last.statusCode === null ? "net-error" : last.statusCode}`;
  return `${d.id} ${d.sessionId} ${d.event} status=${d.status} ${attemptPart}`;
}
