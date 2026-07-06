import { describe, it, expect } from "vitest";
import { classifyLeaveOverlap } from "./trainee-leave-audit-classify";

/**
 * Regression tests for the "not yet started" leave-overlap classifier.
 *
 * Only `approved` and `pending` rows should block the not-yet-started
 * prediction (counted = true). Every other status — including
 * `cancelled`, `denied`, `reserve`, blank, unknown — must be ignored
 * (counted = false), otherwise a stale cancelled leave row would keep a
 * trainee who has not actually started looking like they're on leave.
 */

describe("classifyLeaveOverlap — counted statuses (block not-yet-started)", () => {
  it("approved is counted", () => {
    const r = classifyLeaveOverlap("approved");
    expect(r.counted).toBe(true);
    expect(r.reason).toMatch(/approved/i);
  });

  it("pending is counted", () => {
    const r = classifyLeaveOverlap("pending");
    expect(r.counted).toBe(true);
    expect(r.reason).toMatch(/pending/i);
  });
});

describe("classifyLeaveOverlap — ignored statuses (do NOT block)", () => {
  it("cancelled is ignored", () => {
    const r = classifyLeaveOverlap("cancelled");
    expect(r.counted).toBe(false);
    expect(r.reason).toMatch(/cancelled/i);
  });

  it("denied is ignored", () => {
    const r = classifyLeaveOverlap("denied");
    expect(r.counted).toBe(false);
    expect(r.reason).toMatch(/denied/i);
  });

  it("reserve is ignored", () => {
    const r = classifyLeaveOverlap("reserve");
    expect(r.counted).toBe(false);
    expect(r.reason).toMatch(/reserve/i);
  });

  it("unknown status falls through to ignored and surfaces the raw value", () => {
    const r = classifyLeaveOverlap("withdrawn");
    expect(r.counted).toBe(false);
    expect(r.reason).toContain("withdrawn");
  });

  it("empty string is ignored (no fall-through to counted)", () => {
    const r = classifyLeaveOverlap("");
    expect(r.counted).toBe(false);
  });
});

describe("classifyLeaveOverlap — case-insensitive matching", () => {
  it("'Approved' (capitalised) IS treated as approved", () => {
    const r = classifyLeaveOverlap("Approved");
    expect(r.counted).toBe(true);
    expect(r.reason).toMatch(/approved/i);
  });
  it("'PENDING' (upper) IS treated as pending", () => {
    const r = classifyLeaveOverlap("PENDING");
    expect(r.counted).toBe(true);
    expect(r.reason).toMatch(/pending/i);
  });
  it("'CaNcElLeD' (mixed case) IS treated as cancelled (ignored)", () => {
    const r = classifyLeaveOverlap("CaNcElLeD");
    expect(r.counted).toBe(false);
    expect(r.reason).toMatch(/cancelled/i);
  });
  it("'DENIED' (upper) IS treated as denied (ignored)", () => {
    const r = classifyLeaveOverlap("DENIED");
    expect(r.counted).toBe(false);
    expect(r.reason).toMatch(/denied/i);
  });
  it("'Reserve' (title case) IS treated as reserve (ignored)", () => {
    const r = classifyLeaveOverlap("Reserve");
    expect(r.counted).toBe(false);
    expect(r.reason).toMatch(/reserve/i);
  });
});

describe("classifyLeaveOverlap — full status matrix snapshot", () => {
  // Single shot table to make any future status-list drift obvious.
  it("matches expected counted-flag for every known status", () => {
    const matrix: Array<[string, boolean]> = [
      ["approved", true],
      ["pending", true],
      ["cancelled", false],
      ["denied", false],
      ["reserve", false],
      ["", false],
      ["something-new", false],
    ];
    for (const [status, expected] of matrix) {
      expect(
        { status, counted: classifyLeaveOverlap(status).counted },
      ).toEqual({ status, counted: expected });
    }
  });
});
