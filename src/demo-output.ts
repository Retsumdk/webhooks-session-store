/**
 * Byte-exact expected output of `whs demo` (renderDemo()).
 * Enforced by scripts/verify-demo.ts and a dedicated test - regenerate only
 * when the demo scenario intentionally changes.
 */
export const DEMO_OUTPUT = `sessions
wh_f5678083d6576601 active https://flaky.example.com/hooks events=invoice.paid,invoice.void
wh_09341d0f08a82326 active https://strict.example.com/hooks events=invoice.paid

dispatched dl_c38c741febfae6a3 dl_f5130c907b3975d4
round 1 dl_c38c741febfae6a3 wh_f5678083d6576601 invoice.paid status=pending attempts=1 last=500 kind=retry next=2026-01-01T00:00:01.061Z
round 1 dl_f5130c907b3975d4 wh_09341d0f08a82326 invoice.paid status=failed attempts=1 last=400 kind=permanent next=-
round 2 dl_c38c741febfae6a3 wh_f5678083d6576601 invoice.paid status=delivered attempts=2 last=200 kind=delivered next=-

suspended wh_09341d0f08a82326
stats {"sessions":2,"activeSessions":1,"deliveries":{"pending":0,"delivered":1,"failed":1,"exhausted":0},"totalAttempts":3,"maxAttempts":4}
`;
