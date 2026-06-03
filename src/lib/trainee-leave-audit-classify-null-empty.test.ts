import { describe, it, expect } from "vitest";
import { classifyLeaveOverlap } from "./trainee-leave-audit-classify";

/**
 * Safety tests for null, empty string, and missing leave status values.
 * These must all classify as "unknown / ignored" (counted = false)
 * without throwing.
 */

describe("classifyLeaveOverlap — null / undefined", () => {
  it("null is classified as unknown (ignored)", () => {
    const r = classifyLeaveOverlap(null);
    expect(r.counted).toBe(false);
    expect(r.reason.toLowerCase()).toContain("unknown");
  });

  it("undefined is classified as unknown (ignored)", () => {
    const r = classifyLeaveOverlap(undefined);
    expect(r.counted).toBe(false);
    expect(r.reason.toLowerCase()).toContain("unknown");
  });
});

describe("classifyLeaveOverlap — empty string", () => {
  it("empty string is classified as ignored", () => {
    const r = classifyLeaveOverlap("");
    expect(r.counted).toBe(false);
  });

  it("whitespace-only string is classified as ignored", () => {
    const r = classifyLeaveOverlap("   ");
    expect(r.counted).toBe(false);
  });

  it("tab-and-newline string is classified as ignored", () => {
    const r = classifyLeaveOverlap("\t\n");
    expect(r.counted).toBe(false);
  });
});

describe("classifyLeaveOverlap — structural safety", () => {
  it("never returns counted = true for falsy inputs", () => {
    const falsy = [null, undefined, "", "   ", "\t", "\n", "\r\n"] as const;
    for (const input of falsy) {
      const r = classifyLeaveOverlap(input);
      expect(r.counted).toBe(false);
    }
  });
});
