import { describe, it, expect } from "vitest";
import { validateHalfDayRange } from "./half-day-validation";

describe("validateHalfDayRange", () => {
  it("accepts a plain multi-day full-day range", () => {
    const r = validateHalfDayRange({
      start_date: "2026-01-05",
      end_date: "2026-01-09",
      half_day_start: null,
      half_day_end: null,
    });
    expect(r).toEqual({ ok: true, halfSessionCount: 10 });
  });

  it("accepts a single full day as 2 half-sessions", () => {
    const r = validateHalfDayRange({
      start_date: "2026-01-05",
      end_date: "2026-01-05",
      half_day_start: null,
      half_day_end: null,
    });
    expect(r).toEqual({ ok: true, halfSessionCount: 2 });
  });

  it("accepts single-day AM-only via half_day_end='am'", () => {
    const r = validateHalfDayRange({
      start_date: "2026-01-05",
      end_date: "2026-01-05",
      half_day_start: null,
      half_day_end: "am",
    });
    expect(r).toEqual({ ok: true, halfSessionCount: 1 });
  });

  it("accepts single-day PM-only via half_day_start='pm'", () => {
    const r = validateHalfDayRange({
      start_date: "2026-01-05",
      end_date: "2026-01-05",
      half_day_start: "pm",
      half_day_end: null,
    });
    expect(r).toEqual({ ok: true, halfSessionCount: 1 });
  });

  it("accepts multi-day with both markers (drop first-AM and last-PM)", () => {
    // 2026-01-05 (PM) .. 2026-01-07 (AM) → PM, AM, PM, AM = 4 halves.
    const r = validateHalfDayRange({
      start_date: "2026-01-05",
      end_date: "2026-01-07",
      half_day_start: "pm",
      half_day_end: "am",
    });
    expect(r).toEqual({ ok: true, halfSessionCount: 4 });
  });

  it("rejects reversed dates (end before start)", () => {
    const r = validateHalfDayRange({
      start_date: "2026-01-09",
      end_date: "2026-01-05",
      half_day_start: null,
      half_day_end: null,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.map((e) => e.code)).toContain("reversed_dates");
  });

  it("rejects missing/malformed dates", () => {
    const r = validateHalfDayRange({
      start_date: "",
      end_date: "2026-01-05",
      half_day_start: null,
      half_day_end: null,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0].code).toBe("missing_dates");
  });

  it("rejects semantically meaningless half_day_start='am'", () => {
    const r = validateHalfDayRange({
      start_date: "2026-01-05",
      end_date: "2026-01-05",
      half_day_start: "am",
      half_day_end: null,
    });
    expect(r.ok).toBe(false);
    if (!r.ok)
      expect(r.errors.map((e) => e.code)).toContain("invalid_start_marker");
  });

  it("rejects semantically meaningless half_day_end='pm'", () => {
    const r = validateHalfDayRange({
      start_date: "2026-01-05",
      end_date: "2026-01-05",
      half_day_start: null,
      half_day_end: "pm",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.map((e) => e.code)).toContain("invalid_end_marker");
  });

  it("rejects reversed single-day range: PM start + AM end on same date", () => {
    const r = validateHalfDayRange({
      start_date: "2026-01-05",
      end_date: "2026-01-05",
      half_day_start: "pm",
      half_day_end: "am",
    });
    expect(r.ok).toBe(false);
    if (!r.ok)
      expect(r.errors.map((e) => e.code)).toContain("reversed_single_day");
  });

  it("does NOT flag reversed_single_day on multi-day PM..AM (that's a valid range)", () => {
    const r = validateHalfDayRange({
      start_date: "2026-01-05",
      end_date: "2026-01-06",
      half_day_start: "pm",
      half_day_end: "am",
    });
    expect(r).toEqual({ ok: true, halfSessionCount: 2 });
  });

  it("aggregates multiple errors in a single result", () => {
    const r = validateHalfDayRange({
      start_date: "2026-01-09",
      end_date: "2026-01-05",
      half_day_start: "am",
      half_day_end: "pm",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const codes = r.errors.map((e) => e.code).sort();
      expect(codes).toEqual([
        "invalid_end_marker",
        "invalid_start_marker",
        "reversed_dates",
      ]);
    }
  });
});
