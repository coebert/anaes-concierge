import { describe, it, expect } from "vitest";
import { sessionsCoveredByTimeRange } from "./parsing";

/**
 * Edge cases for the ME AM/PM splitter. The boundary rule under test is:
 *   AM = [00:00, 13:00)   PM = [13:00, 24:00)
 * and end must be strictly after start (else unknown → []).
 */
describe("sessionsCoveredByTimeRange — edge cases", () => {
  describe("end_time equals start_time (zero-length shift)", () => {
    it("returns [] for identical bare times in the AM", () => {
      expect(sessionsCoveredByTimeRange("09:00", "09:00")).toEqual([]);
    });

    it("returns [] for identical bare times exactly on the 13:00 boundary", () => {
      expect(sessionsCoveredByTimeRange("13:00", "13:00")).toEqual([]);
    });

    it("returns [] for identical ISO timestamps", () => {
      expect(
        sessionsCoveredByTimeRange(
          "2026-05-26T14:30:00+01:00",
          "2026-05-26T14:30:00+01:00",
        ),
      ).toEqual([]);
    });
  });

  describe("shift covers only part of a single half-day", () => {
    it("classifies an AM-only fragment (09:00–11:30) as AM", () => {
      expect(sessionsCoveredByTimeRange("09:00", "11:30")).toEqual(["am"]);
    });

    it("classifies a short AM fragment ending just before the boundary as AM", () => {
      expect(sessionsCoveredByTimeRange("12:00", "12:59")).toEqual(["am"]);
    });

    it("classifies a PM-only fragment (14:00–16:00) as PM", () => {
      expect(sessionsCoveredByTimeRange("14:00", "16:00")).toEqual(["pm"]);
    });

    it("classifies a short PM fragment starting just after the boundary as PM", () => {
      expect(sessionsCoveredByTimeRange("13:01", "13:30")).toEqual(["pm"]);
    });

    it("splits across the boundary when start<13 and end>13, even if brief", () => {
      expect(sessionsCoveredByTimeRange("12:45", "13:15")).toEqual(["am", "pm"]);
    });
  });

  describe("shift crosses midnight (end <= start)", () => {
    it("returns [] for a night on-call 20:00–08:00 range", () => {
      expect(sessionsCoveredByTimeRange("20:00", "08:00")).toEqual([]);
    });

    it("returns [] for a range ending at 00:00 (treated as end<=start)", () => {
      expect(sessionsCoveredByTimeRange("17:00", "00:00")).toEqual([]);
    });

    it("returns [] for an ISO overnight range where end wall-clock < start", () => {
      expect(
        sessionsCoveredByTimeRange(
          "2026-05-26T22:00:00+01:00",
          "2026-05-27T06:00:00+01:00",
        ),
      ).toEqual([]);
    });
  });
});
