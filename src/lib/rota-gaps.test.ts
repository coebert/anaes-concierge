import { describe, it, expect } from "vitest";
import { computeRotaGaps } from "./rota-gaps";

describe("computeRotaGaps", () => {
  it("returns no gaps when every weekday has an assignment", () => {
    // Mon 2025-06-02 → Fri 2025-06-06
    const dates = new Set([
      "2025-06-02",
      "2025-06-03",
      "2025-06-04",
      "2025-06-05",
      "2025-06-06",
    ]);
    const r = computeRotaGaps(dates, "2025-06-02", "2025-06-06");
    expect(r.ranges).toEqual([]);
    expect(r.totalMissingDays).toBe(0);
    expect(r.totalExpectedDays).toBe(5);
  });

  it("ignores weekends when counting missing days", () => {
    // Window covers Mon → Sun, no assignments at all
    const r = computeRotaGaps(new Set(), "2025-06-02", "2025-06-08");
    expect(r.totalExpectedDays).toBe(5);
    expect(r.totalMissingDays).toBe(5);
    expect(r.ranges).toHaveLength(1);
    // Span extends through the weekend because it's contiguous.
    expect(r.ranges[0].startISO).toBe("2025-06-02");
    expect(r.ranges[0].missingDays).toBe(5);
  });

  it("bridges a weekend between two missing weeks into one range", () => {
    // Two empty weeks, the weekend in between should not split the range.
    const r = computeRotaGaps(new Set(), "2025-06-02", "2025-06-13");
    expect(r.ranges).toHaveLength(1);
    expect(r.ranges[0].startISO).toBe("2025-06-02");
    expect(r.ranges[0].endISO).toBe("2025-06-13");
    expect(r.ranges[0].missingDays).toBe(10);
  });

  it("breaks a range on a worked weekday", () => {
    // Mon 02, Tue 03 missing; Wed 04 worked; Thu 05, Fri 06 missing
    const r = computeRotaGaps(new Set(["2025-06-04"]), "2025-06-02", "2025-06-06");
    expect(r.ranges).toHaveLength(2);
    expect(r.ranges[0]).toMatchObject({ startISO: "2025-06-02", endISO: "2025-06-03", missingDays: 2 });
    expect(r.ranges[1]).toMatchObject({ startISO: "2025-06-05", endISO: "2025-06-06", missingDays: 2 });
  });

  it("treats LTFT days off like weekends", () => {
    // Trainee never works Wednesday (day 3). All other weekdays missing.
    const r = computeRotaGaps(new Set(), "2025-06-02", "2025-06-06", [3]);
    expect(r.totalExpectedDays).toBe(4);
    expect(r.totalMissingDays).toBe(4);
    expect(r.ranges).toHaveLength(1);
    expect(r.ranges[0].startISO).toBe("2025-06-02");
    expect(r.ranges[0].endISO).toBe("2025-06-06");
  });

  it("returns empty result for an inverted window", () => {
    const r = computeRotaGaps(new Set(), "2025-06-10", "2025-06-01");
    expect(r.ranges).toEqual([]);
    expect(r.totalExpectedDays).toBe(0);
  });
});
