#!/usr/bin/env node
/**
 * `whs` CLI entry point.
 */
import { parseArgs, USAGE } from "./cli.js";
import { renderDemo } from "./demo.js";
import { WebhookEngine } from "./engine.js";
import { renderDeliveryLine, renderSessionLine } from "./report.js";
import { defaultHost } from "./dispatcher.js";
import { runServe } from "./server.js";
import { WebhookStore } from "./store.js";
import { WhsError } from "./types.js";

function buildEngine(dir: string | null, opts: { host?: boolean } = {}): WebhookEngine {
  return new WebhookEngine({
    store: new WebhookStore(dir),
    ...(opts.host === false ? {} : { host: defaultHost() }),
  });
}

async function main(argv: readonly string[]): Promise<number> {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    console.error(`error: ${(err as Error).message}\n\n${USAGE}`);
    return 2;
  }
  if (parsed.flags.help === "true" || parsed.command === "help") {
    console.log(USAGE);
    return 0;
  }

  const dir = parsed.flags.dir || null;
  switch (parsed.command) {
    case "demo": {
      process.stdout.write(await renderDemo());
      return 0;
    }
    case "session": {
      const engine = buildEngine(dir, { host: false });
      if (parsed.positionals[0] === "add") {
        const events = (parsed.flags.events ?? "").split(",").map((e) => e.trim()).filter((e) => e !== "");
        const session = engine.registerSession({ url: parsed.flags.url ?? "", secret: parsed.flags.secret ?? "", events });
        console.log(`created ${session.id} -> ${session.url}`);
        return 0;
      }
      if (parsed.positionals[0] === "list") {
        for (const s of engine.listSessions()) console.log(renderSessionLine(s));
        return 0;
      }
      if (parsed.positionals[0] === "status") {
        const status = parsed.flags.status === "suspended" ? "suspended" : parsed.flags.status === "active" ? "active" : null;
        if (!status) {
          console.error("error: --status must be active or suspended");
          return 2;
        }
        const session = engine.setSessionStatus(parsed.flags.id ?? "", status);
        console.log(`${session.id} ${session.status}`);
        return 0;
      }
      console.error(`error: unknown session subcommand "${parsed.positionals[0] ?? ""}"\n\n${USAGE}`);
      return 2;
    }
    case "dispatch": {
      const engine = buildEngine(dir, { host: false });
      let payload: unknown = null;
      if (parsed.flags.payload) {
        try {
          payload = JSON.parse(parsed.flags.payload);
        } catch {
          console.error("error: --payload is not valid JSON");
          return 2;
        }
      }
      const delivery = engine.dispatch(parsed.flags.session ?? "", parsed.flags.event ?? "", payload);
      console.log(renderDeliveryLine(delivery));
      return 0;
    }
    case "process": {
      const engine = buildEngine(dir);
      const limit = parsed.flags.limit ? Number(parsed.flags.limit) : 10;
      const results = await engine.processDue(undefined, limit);
      for (const r of results) console.log(`${r.deliveryId} kind=${r.kind} attempts=${r.attempts} next=${r.nextAttemptAt === null ? "-" : new Date(r.nextAttemptAt).toISOString()}`);
      console.log(`processed ${results.length}`);
      return 0;
    }
    case "deliveries": {
      const engine = buildEngine(dir, { host: false });
      const status = parsed.flags.status as "pending" | "delivered" | "failed" | "exhausted" | undefined;
      const filter: { sessionId?: string; status?: "pending" | "delivered" | "failed" | "exhausted" } = {};
      if (parsed.flags.session) filter.sessionId = parsed.flags.session;
      if (status) filter.status = status;
      for (const d of engine.listDeliveries(filter)) {
        console.log(renderDeliveryLine(d));
      }
      return 0;
    }
    case "replay": {
      const engine = buildEngine(dir, { host: false });
      const delivery = engine.replay(parsed.flags.id ?? "");
      console.log(`requeued ${delivery.id}`);
      return 0;
    }
    case "stats": {
      const engine = buildEngine(dir, { host: false });
      console.log(JSON.stringify(engine.stats()));
      return 0;
    }
    case "serve": {
      const port = parsed.flags.port ? Number(parsed.flags.port) : 8077;
      runServe(port, dir);
      return 0;
    }
    default:
      console.error(`error: unknown command "${parsed.command}"\n\n${USAGE}`);
      return 2;
  }
}

process.exitCode = 1;
main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    if (err instanceof WhsError) {
      console.error(`error [${err.code}]: ${err.message}`);
      process.exitCode = err.exitCode;
    } else {
      console.error(`error: ${err instanceof Error ? err.stack : String(err)}`);
      process.exitCode = 1;
    }
  });
