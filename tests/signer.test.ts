import { describe, test, expect } from "bun:test";
import { signPayload, verifySignature, DEFAULT_TOLERANCE_SEC, SIGNATURE_HEADER } from "../src/signer.js";
import { SignatureError } from "../src/types.js";

const SECRET = "signer-test-secret-012345";
const BODY = '{"hello":"world"}';
const T = 1_767_225_600;

describe("signPayload", () => {
  test("produces the t=,v1= scheme", () => {
    const sig = signPayload(SECRET, BODY, T);
    expect(sig).toMatch(new RegExp(`^t=${T},v1=[0-9a-f]{64}$`));
  });

  test("is secret-, body-, and timestamp-sensitive", () => {
    const base = signPayload(SECRET, BODY, T);
    expect(signPayload("other-secret-0123456789ab", BODY, T)).not.toBe(base);
    expect(signPayload(SECRET, BODY + " ", T)).not.toBe(base);
    expect(signPayload(SECRET, BODY, T + 1)).not.toBe(base);
  });
});

describe("verifySignature", () => {
  test("accepts the exact signature and multi-v1 rotation windows", () => {
    expect(() => verifySignature(SECRET, BODY, signPayload(SECRET, BODY, T), T, DEFAULT_TOLERANCE_SEC, T)).not.toThrow();
    const rotated = `t=${T},v1=${"0".repeat(64)},v1=${signPayload(SECRET, BODY, T).split("v1=")[1]}`;
    expect(() => verifySignature(SECRET, BODY, rotated, T, DEFAULT_TOLERANCE_SEC, T)).not.toThrow();
  });

  test("rejects with precise SignatureError reasons", () => {
    const cases: Array<[string, () => void]> = [
      ["non-integer timestamp", () => verifySignature(SECRET, BODY, `t=${T},v1=x`, 1.5, 300, T)],
      ["timestamp outside window", () => verifySignature(SECRET, BODY, `t=${T},v1=x`, T, 300, T + 301)],
      ["future timestamp outside window", () => verifySignature(SECRET, BODY, `t=${T},v1=x`, T, 300, T - 301)],
      ["missing t= component", () => verifySignature(SECRET, BODY, `v1=x`, T, 300, T)],
      ["header/timestamp mismatch", () => verifySignature(SECRET, BODY, `t=${T + 1},v1=x`, T, 300, T)],
      ["missing v1= signature", () => verifySignature(SECRET, BODY, `t=${T}`, T, 300, T)],
      ["signature mismatch", () => verifySignature("wrong", BODY, `t=${T},v1=x`, T, 300, T)],
    ];
    for (const [, fn] of cases) expect(fn).toThrow(SignatureError);
  });

  test("tolerance boundary is inclusive", () => {
    expect(() => verifySignature(SECRET, BODY, `t=${T - 300},v1=x`, T - 300, 300, T)).toThrow(SignatureError); // wrong sig anyway
    const sig = signPayload(SECRET, BODY, T - 300);
    expect(() => verifySignature(SECRET, BODY, sig, T - 300, 300, T)).not.toThrow();
  });

  test("header name constant is stable", () => {
    expect(SIGNATURE_HEADER).toBe("webhook-signature");
  });
});
