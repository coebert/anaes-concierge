import { describe, it, expect } from "vitest";
import {
  isoDateOffsetUTC,
  computeLeaveWindow,
  leaveOverlapsWindow,
  LEAVE_LOOKAHEAD_DAYS,
} from "./trainee-leave-audit-window";

/**
 * Timezone-boundary regression tests for the 14-day "not yet started"
 * window. The window is computed at UTC midnight so the server's local
 * timezone (Cloudflare workerd = UTC; CI/dev = anything) does not shift
 * the bounds by ±1 day. These tests fix arbitrary instants via the
 * injectable `now` argument so they don't depend on the runtime's TZ.
 */

describe("isoDateOffsetUTC — UTC anchoring", () => {
  it("snaps to UTC date even when the instant is late at night locally", () => {
    // 23:30 UTC on 2026-06-15. Anywhere east of UTC this is already
    // 2026-06-16 locally; anywhere west it's still 2026-06-15. The
    // window must always report the UTC date.
    const now = new Date("2026-06-15T23:30:00Z");
    expect(isoDateOffsetUTC(0, now)).toBe("2026-06-15");
    expect(isoDateOffsetUTC(14, now)).toBe("2026-06-29");
  });

  it("snaps to UTC date when the instant is just past UTC midnight", () => {
    // 00:30 UTC on 2026-06-15. Anywhere west of UTC this is still
    // 2026-06-14 locally. UTC bucket must still be 2026-06-15.
    const now = new Date("2026-06-15T00:30:00Z");
    expect(isoDateOffsetUTC(0, now)).toBe("2026-06-15");
    expect(isoDateOffsetUTC(14, now)).toBe("2026-06-29");
  });

  it("two instants on the same UTC date produce identical windows", () => {
    const early = new Date("2026-06-15T00:01:00Z");
    const late = new Date("2026-06-15T23:59:59Z");
    expect(isoDateOffsetUTC(0, early)).toBe(isoDateOffsetUTC(0, late));
    expect(isoDateOffsetUTC(14, early)).toBe(isoDateOffsetUTC(14, late));
  });

  it("crosses a month boundary correctly (Apr 30 + 14 = May 14)", () => {
    const now = new Date("2026-04-30T12:00:00Z");
    expect(isoDateOffsetUTC(14, now)).toBe("2026-05-14");
  });

  it("crosses a year boundary correctly (Dec 28 + 14 = Jan 11 next year)", () => {
    const now = new Date("2026-12-28T12:00:00Z");
    expect(isoDateOffsetUTC(0, now)).toBe("2026-12-28");
    expect(isoDateOffsetUTC(14, now)).toBe("2027-01-11");
  });

  it("handles leap-day → DST-transition window without slipping a day", () => {
    // 29 Feb 2028 (leap) + 14d = 14 Mar 2028. UK clocks go forward on
    // Sun 26 Mar 2028; a naive local-time computation in Europe/London
    // would still land on 14 Mar, but only because the offset is +0/+1.
    // The point: arithmetic in UTC must not flinch around DST.
    const now = new Date("2028-02-29T12:00:00Z");
    expect(isoDateOffsetUTC(0, now)).toBe("2028-02-29");
    expect(isoDateOffsetUTC(14, now)).toBe("2028-03-14");
  });
});

describe("computeLeaveWindow", () => {
  it("returns a 14-day window anchored on UTC today", () => {
    const now = new Date("2026-06-15T10:00:00Z");
    const w = computeLeaveWindow(now);
    expect(w).toEqual({ window_start: "2026-06-15", window_end: "2026-06-29" });
  });

  it("exposes the constant 14-day lookahead", () => {
    expect(LEAVE_LOOKAHEAD_DAYS).toBe(14);
  });
});

describe("leaveOverlapsWindow — inclusive boundary behaviour", () => {
  const window = { window_start: "2026-06-15", window_end: "2026-06-29" };

  it("includes a leave row that starts on the same UTC day as window_start", () => {
    expect(
      leaveOverlapsWindow({ start_date: "2026-06-15", end_date: "2026-06-15" }, window),
    ).toBe(true);
  });

  it("includes a leave row that ends on the same UTC day as window_end", () => {
    expect(
      leaveOverlapsWindow({ start_date: "2026-06-29", end_date: "2026-06-29" }, window),
    ).toBe(true);
  });

  it("includes a leave row that ends exactly on window_start (1-day overlap)", () => {
    // Leave ending 2026-06-15 still has that working day in the window.
    expect(
      leaveOverlapsWindow({ start_date: "2026-06-10", end_date: "2026-06-15" }, window),
    ).toBe(true);
  });

  it("includes a leave row that starts exactly on window_end (1-day overlap)", () => {
    expect(
      leaveOverlapsWindow({ start_date: "2026-06-29", end_date: "2026-07-05" }, window),
    ).toBe(true);
  });

  it("excludes a leave row that ends the calendar day before window_start", () => {
    expect(
      leaveOverlapsWindow({ start_date: "2026-06-10", end_date: "2026-06-14" }, window),
    ).toBe(false);
  });

  it("excludes a leave row that starts the calendar day after window_end", () => {
    expect(
      leaveOverlapsWindow({ start_date: "2026-06-30", end_date: "2026-07-05" }, window),
    ).toBe(false);
  });

  it("includes a leave row that fully encloses the window", () => {
    expect(
      leaveOverlapsWindow({ start_date: "2026-05-01", end_date: "2026-12-31" }, window),
    ).toBe(true);
  });
});

describe("leaveOverlapsWindow — TZ-shifted instants land in the right bucket", () => {
  // Build the window from a UTC instant, then probe with leave rows whose
  // dates correspond to the *local* day the user would have seen in a
  // non-UTC zone. We assert the inclusive UTC-date behaviour: only the
  // string YYYY-MM-DD comparison matters, never the runtime TZ.
  const window = computeLeaveWindow(new Date("2026-06-15T23:30:00Z"));

  it("23:30 UTC on day-0 → leave dated 2026-06-15 is in-window", () => {
    expect(window.window_start).toBe("2026-06-15");
    expect(
      leaveOverlapsWindow({ start_date: "2026-06-15", end_date: "2026-06-15" }, window),
    ).toBe(true);
  });

  it("23:30 UTC on day-0 → leave dated 2026-06-29 is in-window (boundary)", () => {
    expect(window.window_end).toBe("2026-06-29");
    expect(
      leaveOverlapsWindow({ start_date: "2026-06-29", end_date: "2026-06-29" }, window),
    ).toBe(true);
  });

  it("23:30 UTC on day-0 → leave dated 2026-06-30 is out-of-window", () => {
    expect(
      leaveOverlapsWindow({ start_date: "2026-06-30", end_date: "2026-06-30" }, window),
    ).toBe(false);
  });

  it("00:30 UTC on day-0 (would be previous day in -05:00) still uses UTC date", () => {
    const w = computeLeaveWindow(new Date("2026-06-15T00:30:00Z"));
    expect(w.window_start).toBe("2026-06-15");
    // A leave row dated 2026-06-14 ("yesterday locally" west of UTC) must
    // be out-of-window — we go by the UTC calendar, not the user's clock.
    expect(
      leaveOverlapsWindow({ start_date: "2026-06-14", end_date: "2026-06-14" }, w),
    ).toBe(false);
  });
});
