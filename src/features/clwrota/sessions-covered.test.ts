import { describe, it, expect } from "vitest";
import { sessionsCoveredByTimeRange } from "./parsing";

describe("sessionsCoveredByTimeRange (medical examiner AM/PM splitting)", () => {
  it("splits an all-day 08:00–17:00 range into both AM and PM", () => {
    expect(sessionsCoveredByTimeRange("08:00", "17:00")).toEqual(["am", "pm"]);
  });

  it("splits ISO-timestamped all-day ranges", () => {
    expect(
      sessionsCoveredByTimeRange(
        "2026-05-26T08:00:00+01:00",
        "2026-05-26T17:00:00+01:00",
      ),
    ).toEqual(["am", "pm"]);
  });

  it("keeps AM-only when the shift ends at exactly 13:00", () => {
    expect(sessionsCoveredByTimeRange("08:00", "13:00")).toEqual(["am"]);
  });

  it("keeps PM-only when the shift starts at exactly 13:00", () => {
    expect(sessionsCoveredByTimeRange("13:00", "17:00")).toEqual(["pm"]);
  });

  it("returns empty when the range cannot be parsed so callers fall back to the session label", () => {
    expect(sessionsCoveredByTimeRange(null, null)).toEqual([]);
    expect(sessionsCoveredByTimeRange("not-a-time", "also-nonsense")).toEqual([]);
  });

  it("returns empty when end is not after start (unsupported / crosses-midnight)", () => {
    expect(sessionsCoveredByTimeRange("22:00", "06:00")).toEqual([]);
  });
});
