import { describe, expect, it } from "vitest";
import { weeksInRangeInclusive } from "./robustness.consultant-audits";

describe("weeksInRangeInclusive", () => {
  it("returns 0 for an empty range", () => {
    expect(weeksInRangeInclusive("", "")).toBe(0);
    expect(weeksInRangeInclusive("2026-01-01", "")).toBe(0);
    expect(weeksInRangeInclusive("", "2026-01-01")).toBe(0);
  });

  it("returns 0 when end is before start", () => {
    expect(weeksInRangeInclusive("2026-01-10", "2026-01-05")).toBe(0);
  });

  it("returns 0 for invalid date strings", () => {
    expect(weeksInRangeInclusive("not-a-date", "2026-01-10")).toBe(0);
    expect(weeksInRangeInclusive("2026-01-10", "not-a-date")).toBe(0);
  });

  it("counts a single day as one week", () => {
    // Monday
    expect(weeksInRangeInclusive("2026-01-05", "2026-01-05")).toBe(1);
    // Wednesday
    expect(weeksInRangeInclusive("2026-01-07", "2026-01-07")).toBe(1);
    // Sunday
    expect(weeksInRangeInclusive("2026-01-11", "2026-01-11")).toBe(1);
  });

  it("counts a full Monday-to-Sunday week as one week", () => {
    expect(weeksInRangeInclusive("2026-01-05", "2026-01-11")).toBe(1);
  });

  it("counts two full consecutive weeks as two weeks", () => {
    expect(weeksInRangeInclusive("2026-01-05", "2026-01-18")).toBe(2);
  });

  it("counts a partial start week as a whole week", () => {
    // Thursday to Sunday → should snap start back to Monday, spanning 1 week
    expect(weeksInRangeInclusive("2026-01-08", "2026-01-11")).toBe(1);
  });

  it("counts a partial end week as a whole week", () => {
    // Monday to Thursday → should snap end forward to Sunday, spanning 1 week
    expect(weeksInRangeInclusive("2026-01-05", "2026-01-08")).toBe(1);
  });

  it("counts partial weeks at both ends", () => {
    // Thursday to next Wednesday → snaps to Monday…Sunday on both ends = 2 weeks
    expect(weeksInRangeInclusive("2026-01-08", "2026-01-14")).toBe(2);
  });

  it("counts multiple complete weeks plus partial edges", () => {
    // Wednesday (8th) to next Tuesday (14th) → snaps Mon 5th … Sun 18th = 3 weeks
    // 2026-01-05 is Monday, 2026-01-18 is Sunday of week 2
    expect(weeksInRangeInclusive("2026-01-08", "2026-01-14")).toBe(2);
  });

  it("handles a long multi-week range", () => {
    // 2026-01-05 (Mon) to 2026-02-22 (Sun) = 7 full weeks
    expect(weeksInRangeInclusive("2026-01-05", "2026-02-22")).toBe(7);
    // 2026-01-07 (Wed) to 2026-02-20 (Fri) → snaps to Mon 5th … Sun 22nd = 7 weeks
    expect(weeksInRangeInclusive("2026-01-07", "2026-02-20")).toBe(7);
    // 2026-01-07 (Wed) to 2026-02-21 (Sat) → snaps to Mon 5th … Sun 22nd = 7 weeks
    expect(weeksInRangeInclusive("2026-01-07", "2026-02-21")).toBe(7);
  });

  it("handles Saturday-to-Sunday weekend range", () => {
    // Saturday 10th to Sunday 11th → snaps to Mon 5th … Sun 11th = 1 week
    expect(weeksInRangeInclusive("2026-01-10", "2026-01-11")).toBe(1);
  });

  it("handles a Friday-to-Monday range spanning a weekend", () => {
    // Friday 9th to Monday 12th → snaps to Mon 5th … Sun 18th = 2 weeks
    expect(weeksInRangeInclusive("2026-01-09", "2026-01-12")).toBe(2);
  });
});
