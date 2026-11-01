import { describe, test, expect } from "bun:test";
import { FLAG_ALIASES, parseArgs, USAGE } from "../src/cli.js";

describe("parseArgs", () => {
  test("splits command, flags (--flag value and --flag=value), positionals", () => {
    expect(parseArgs(["session", "add", "--url", "https://a.b/h", "--secret=s3cret-value-16", "--events", "a,b"])).toEqual({
      command: "session",
      flags: { url: "https://a.b/h", secret: "s3cret-value-16", events: "a,b" },
      positionals: ["add"],
    });
  });

  test("defaults to help; --help and -h are flags, not values", () => {
    expect(parseArgs([]).command).toBe("help");
    expect(parseArgs(["stats", "--help"]).flags.help).toBe("true");
    expect(parseArgs(["-h"]).flags.help).toBe("true");
  });

  test("unknown flags and valueless flags are usage errors", () => {
    expect(() => parseArgs(["x", "--nope", "v"])).toThrow(/unknown flag --nope/);
    expect(() => parseArgs(["x", "--url"])).toThrow(/requires a value/);
  });
});

describe("USAGE", () => {
  test("documents every command the CLI implements", () => {
    for (const cmd of ["demo", "session", "dispatch", "process", "deliveries", "replay", "stats", "serve"]) {
      expect(USAGE).toContain(cmd);
    }
    expect(USAGE).toContain("Exit codes");
  });

  test("every flag documented in USAGE is accepted by parseArgs", () => {
    const documented = new Set(
      [...USAGE.matchAll(/--[a-z]+/g)].map((m) => m[0].slice(2)),
    );
    const aliases = FLAG_ALIASES as unknown as Record<string, string>;
    for (const flag of documented) {
      expect(aliases).toHaveProperty(flag);
    }
  });
});
