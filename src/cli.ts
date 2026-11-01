/**
 * Argument parsing for the `whs` CLI (no external deps).
 */
export interface ParsedArgs {
  command: string;
  flags: Record<string, string>;
  positionals: string[];
}

export const FLAG_ALIASES: Record<string, string> = {
  dir: "dir",
  url: "url",
  secret: "secret",
  events: "events",
  id: "id",
  session: "session",
  status: "status",
  limit: "limit",
  port: "port",
  event: "event",
  payload: "payload",
};

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const rest = [...argv];
  let command = "help";
  // A leading flag (e.g. `whs -h`) means "no command": help, with flags parsed.
  if (rest[0] !== undefined && !rest[0].startsWith("-")) {
    command = rest.shift() as string;
  }
  const flags: Record<string, string> = {};
  const positionals: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === undefined) continue;
    if (arg === "--help" || arg === "-h") {
      flags.help = "true";
      continue;
    }
    if (arg.startsWith("--")) {
      const raw = arg.slice(2);
      const eq = raw.indexOf("=");
      if (eq >= 0) {
        const name = FLAG_ALIASES[raw.slice(0, eq)];
        if (name === undefined) throw new Error(`unknown flag --${raw.slice(0, eq)}`);
        flags[name] = raw.slice(eq + 1);
      } else {
        const name = FLAG_ALIASES[raw];
        if (name === undefined) throw new Error(`unknown flag --${raw}`);
        const value = rest[i + 1];
        if (value === undefined || value.startsWith("--")) throw new Error(`flag --${raw} requires a value`);
        flags[name] = value;
        i += 1;
      }
      continue;
    }
    positionals.push(arg);
  }
  return { command, flags, positionals };
}

export const USAGE = `whs — durable signed webhook delivery sessions

Usage:
  whs demo                                  Print the deterministic demo report
  whs session add --url URL --secret S --events a,b [--dir DIR]
  whs session list [--dir DIR]
  whs session status --id ID --status active|suspended [--dir DIR]
  whs dispatch --session ID --event E [--payload JSON] [--dir DIR]
  whs process [--limit N] [--dir DIR]       Deliver everything currently due
  whs deliveries [--session ID] [--status S] [--dir DIR]
  whs replay --id ID [--dir DIR]
  whs stats [--dir DIR]
  whs serve [--port 8077] [--dir DIR]       HTTP API; writes need WHS_TOKEN

Exit codes: 0 ok · 2 usage/validation · 3 corrupt store · 4 not found · 5 signature`;
