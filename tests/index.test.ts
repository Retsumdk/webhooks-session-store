import { describe, test, expect } from "bun:test";
describe("webhooks-session-store", () => {
  test("module loads", async () => { const m = await import("./index"); expect(m).toBeDefined(); });
});
