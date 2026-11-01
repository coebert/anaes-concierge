import { describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs script without type declarations
import { evaluateAudit } from "./check-supply-chain.mjs";

describe("supply-chain scanner fails closed", () => {
  it("ENOAUDIT error payload is a failure (exit 2), not clean", () => {
    expect(
      evaluateAudit(JSON.stringify({ error: { code: "ENOAUDIT", summary: "no audit" } })).code,
    ).toBe(2);
  });
  it("non-JSON / empty / wrong shape output is a failure", () => {
    expect(evaluateAudit("<html>502</html>").code).toBe(2);
    expect(evaluateAudit("").code).toBe(2);
    expect(evaluateAudit("[]").code).toBe(2);
    expect(evaluateAudit(JSON.stringify({ pkg: [{ severity: "weird" }] })).code).toBe(2);
  });
  it("advisories at/above the level fail (exit 1); below the level pass", () => {
    const out = JSON.stringify({
      a: [{ severity: "moderate", vulnerable_versions: "<2" }],
      b: [{ severity: "low" }],
    });
    expect(evaluateAudit(out, "moderate").code).toBe(1);
    expect(evaluateAudit(out, "high").code).toBe(0);
  });
  it("clean report passes", () => {
    expect(evaluateAudit("{}").code).toBe(0);
  });
});
