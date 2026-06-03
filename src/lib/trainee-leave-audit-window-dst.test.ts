import { describe, it, expect, afterEach, beforeEach } from "vitest";
import {
  isoDateOffsetUTC,
  computeLeaveWindow,
  leaveOverlapsWindow,
} from "./trainee-leave-audit-window";

/**
 * DST-transition regression tests for the 14-day "not yet started" window.
 *
 * The bug we're guarding against: any implementation that uses local-time
 * arithmetic (e.g. `setDate` / `setHours` on a `Date` without the `UTC`
 * variants) silently slips by ±1 hour at every DST boundary. A 14-day
 * window crossing a "spring forward" or "fall back" transition can then
 * land on the wrong calendar date, or — worse — on different dates
 * depending on which side of the transition the server clock is on.
 *
 * The window is computed in UTC, so every transition below MUST be a
 * no-op for the output. We assert that by:
 *   1. Pinning UTC instants on both sides of each transition and showing
 *      the 14-day output is exactly +14 calendar days, no slip.
 *   2. Running the same assertions under TZ=Europe/London,
 *      TZ=America/New_York, TZ=Australia/Sydney, and TZ=Pacific/Chatham
 *      (the half-hour-plus-DST edge case) — the answer must not change.
 *   3. Probing boundary leave rows around each transition.
 */

// Europe/London: BST starts last Sunday in March, ends last Sunday in October.
const LONDON_SPRING_FORWARD_2026 = new Date("2026-03-29T01:00:00Z"); // 02:00 BST
const LONDON_FALL_BACK_2026 = new Date("2026-10-25T01:00:00Z");      // 01:00 GMT after fallback

// America/New_York: EDT starts 2nd Sunday March, ends 1st Sunday November.
const NY_SPRING_FORWARD_2026 = new Date("2026-03-08T07:00:00Z"); // 02→03 local
const NY_FALL_BACK_2026 = new Date("2026-11-01T06:00:00Z");      // 02→01 local

// Australia/Sydney: AEDT ends 1st Sun April, starts 1st Sun October.
const SYDNEY_FALL_BACK_2026 = new Date("2026-04-05T16:00:00Z"); // 03→02 local
const SYDNEY_SPRING_FORWARD_2026 = new Date("2026-10-04T16:00:00Z"); // 02→03 local

// Pacific/Chatham: +12:45 / +13:45, transitions on different dates.
const CHATHAM_SPRING_FORWARD_2026 = new Date("2026-09-26T14:00:00Z");

const ALL_TRANSITIONS: Array<[string, Date, string, string]> = [
  ["London spring-forward", LONDON_SPRING_FORWARD_2026, "2026-03-29", "2026-04-12"],
  ["London fall-back", LONDON_FALL_BACK_2026, "2026-10-25", "2026-11-08"],
  ["NY spring-forward", NY_SPRING_FORWARD_2026, "2026-03-08", "2026-03-22"],
  ["NY fall-back", NY_FALL_BACK_2026, "2026-11-01", "2026-11-15"],
  ["Sydney fall-back", SYDNEY_FALL_BACK_2026, "2026-04-05", "2026-04-19"],
  ["Sydney spring-forward", SYDNEY_SPRING_FORWARD_2026, "2026-10-04", "2026-10-18"],
  ["Chatham spring-forward", CHATHAM_SPRING_FORWARD_2026, "2026-09-26", "2026-10-10"],
];

describe("DST transitions — UTC instants produce stable +14d windows", () => {
  for (const [label, instant, expectedStart, expectedEnd] of ALL_TRANSITIONS) {
    it(`${label}: window is exactly ${expectedStart} → ${expectedEnd}`, () => {
      const w = computeLeaveWindow(instant);
      expect(w).toEqual({
        window_start: expectedStart,
        window_end: expectedEnd,
      });
    });
  }

  it("Spanning London BST start: a window starting 22 Mar 2026 still covers exactly 14 calendar days", () => {
    // Sun 22 Mar (GMT) → Sun 5 Apr (BST). Days 7→8 cross the spring-forward.
    const w = computeLeaveWindow(new Date("2026-03-22T12:00:00Z"));
    expect(w).toEqual({ window_start: "2026-03-22", window_end: "2026-04-05" });
  });

  it("Spanning London BST end: a window starting 18 Oct 2026 still covers exactly 14 calendar days", () => {
    // Sun 18 Oct (BST) → Sun 1 Nov (GMT). Crosses the fall-back.
    const w = computeLeaveWindow(new Date("2026-10-18T12:00:00Z"));
    expect(w).toEqual({ window_start: "2026-10-18", window_end: "2026-11-01" });
  });

  it("Spanning NY DST start: window starting 1 Mar 2026 ends exactly 15 Mar 2026", () => {
    const w = computeLeaveWindow(new Date("2026-03-01T12:00:00Z"));
    expect(w).toEqual({ window_start: "2026-03-01", window_end: "2026-03-15" });
  });

  it("Spanning NY DST end: window starting 25 Oct 2026 ends exactly 8 Nov 2026", () => {
    const w = computeLeaveWindow(new Date("2026-10-25T12:00:00Z"));
    expect(w).toEqual({ window_start: "2026-10-25", window_end: "2026-11-08" });
  });
});

describe("DST transitions — same UTC instant under different TZ envs returns the same window", () => {
  // We simulate "the server runs in TZ X" by setting process.env.TZ and
  // creating a fresh Date instance. Node honours process.env.TZ at Date
  // construction time on most platforms; we still assert the *function
  // contract* — UTC arithmetic — and not any particular host behaviour.
  const originalTz = process.env.TZ;

  beforeEach(() => {
    /* reset between cases */
  });
  afterEach(() => {
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  });

  const ZONES = [
    "UTC",
    "Europe/London",
    "America/New_York",
    "Australia/Sydney",
    "Pacific/Chatham",
  ];

  for (const [label, instant, expectedStart, expectedEnd] of ALL_TRANSITIONS) {
    for (const tz of ZONES) {
      it(`${label} under TZ=${tz} still yields ${expectedStart} → ${expectedEnd}`, () => {
        process.env.TZ = tz;
        // Re-pass the same UTC instant — getTime() is TZ-independent.
        const w = computeLeaveWindow(new Date(instant.getTime()));
        expect(w.window_start).toBe(expectedStart);
        expect(w.window_end).toBe(expectedEnd);
      });
    }
  }
});

describe("DST transitions — instants minutes either side of the jump map to the same UTC date", () => {
  it("London spring-forward: 00:59 UTC and 01:01 UTC on 29 Mar 2026 both yield 2026-03-29", () => {
    // The local clock jumps from 01:00 GMT to 02:00 BST at 01:00 UTC. Both
    // sides of that jump are still the same UTC calendar day.
    expect(isoDateOffsetUTC(0, new Date("2026-03-29T00:59:00Z"))).toBe("2026-03-29");
    expect(isoDateOffsetUTC(0, new Date("2026-03-29T01:01:00Z"))).toBe("2026-03-29");
    expect(isoDateOffsetUTC(14, new Date("2026-03-29T00:59:00Z"))).toBe("2026-04-12");
    expect(isoDateOffsetUTC(14, new Date("2026-03-29T01:01:00Z"))).toBe("2026-04-12");
  });

  it("London fall-back: 00:59 UTC and 01:01 UTC on 25 Oct 2026 both yield 2026-10-25", () => {
    expect(isoDateOffsetUTC(0, new Date("2026-10-25T00:59:00Z"))).toBe("2026-10-25");
    expect(isoDateOffsetUTC(0, new Date("2026-10-25T01:01:00Z"))).toBe("2026-10-25");
    expect(isoDateOffsetUTC(14, new Date("2026-10-25T00:59:00Z"))).toBe("2026-11-08");
    expect(isoDateOffsetUTC(14, new Date("2026-10-25T01:01:00Z"))).toBe("2026-11-08");
  });

  it("NY spring-forward: 06:59 UTC and 07:01 UTC on 8 Mar 2026 both yield 2026-03-08", () => {
    expect(isoDateOffsetUTC(0, new Date("2026-03-08T06:59:00Z"))).toBe("2026-03-08");
    expect(isoDateOffsetUTC(0, new Date("2026-03-08T07:01:00Z"))).toBe("2026-03-08");
  });
});

describe("leaveOverlapsWindow — DST-adjacent boundary leave rows", () => {
  it("London spring-forward: leave on the transition day itself is in-window", () => {
    const window = computeLeaveWindow(new Date("2026-03-22T12:00:00Z"));
    expect(
      leaveOverlapsWindow(
        { start_date: "2026-03-29", end_date: "2026-03-29" },
        window,
      ),
    ).toBe(true);
  });

  it("London fall-back: leave starting on the fallback day is included at the window-end boundary", () => {
    // Window 2026-10-18 → 2026-11-01. Fall-back is 25 Oct (inside).
    const window = computeLeaveWindow(new Date("2026-10-18T12:00:00Z"));
    expect(
      leaveOverlapsWindow(
        { start_date: "2026-10-25", end_date: "2026-10-25" },
        window,
      ),
    ).toBe(true);
    // And the boundary day 2026-11-01 itself is still in-window.
    expect(
      leaveOverlapsWindow(
        { start_date: "2026-11-01", end_date: "2026-11-01" },
        window,
      ),
    ).toBe(true);
    // 2026-11-02 is one calendar day past, regardless of DST.
    expect(
      leaveOverlapsWindow(
        { start_date: "2026-11-02", end_date: "2026-11-02" },
        window,
      ),
    ).toBe(false);
  });

  it("NY spring-forward: a leave row dated on the transition day is in-window when computed from a UTC instant inside the window", () => {
    const window = computeLeaveWindow(new Date("2026-03-01T12:00:00Z"));
    expect(window).toEqual({ window_start: "2026-03-01", window_end: "2026-03-15" });
    expect(
      leaveOverlapsWindow(
        { start_date: "2026-03-08", end_date: "2026-03-08" },
        window,
      ),
    ).toBe(true);
  });
});
