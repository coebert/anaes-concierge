// @vitest-environment jsdom
/**
 * Regression: when a consultant's recent window contains zero SPA sessions
 * or zero on-call sessions, the working-patterns card must render the
 * weekday strip without a "%" cell (and specifically without `NaN%` /
 * `0%` masquerading as a real distribution). When the totals are
 * positive, each highlighted cell must show the correct
 * count / total percentage.
 */
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import React from "react";

import {
  SpaStrip,
  WeekdayStrip,
} from "@/components/working-pattern-strips";

afterEach(() => cleanup());

describe("SpaStrip percentage rendering", () => {
  it("suppresses the percentage on every cell when totalSpaSessions is 0", () => {
    // Consultant has a regular SPA weekday recorded from a stale pattern
    // but the recent window contains zero SPA sessions.
    render(
      <SpaStrip
        amDays={[3]}
        pmDays={[]}
        countsByWeekday={[0, 0, 0, 0, 0, 0, 0]}
        totalSessions={0}
      />,
    );
    // No % text anywhere in the strip
    expect(screen.queryByText(/%/)).toBeNull();
    expect(screen.queryByText(/NaN/)).toBeNull();
    // And no per-cell pct span was rendered
    for (const d of [1, 2, 3, 4, 5]) {
      expect(screen.queryByTestId(`spa-pct-${d}`)).toBeNull();
    }
    // The active SPA cell (Wed) still labels its half-session.
    expect(screen.getByTestId("spa-cell-3").textContent).toBe("AM");
  });

  it("renders count / total percentages on every SPA weekday that has sessions", () => {
    // 8 SPA sessions total: 4 on Wed AM, 2 on Fri PM, and 2 stray on Mon
    // AM that don't hit the regularity threshold (so not in amDays). The
    // strip now surfaces the Monday share too, so consultants can see
    // where their non-regular SPA time falls.
    render(
      <SpaStrip
        amDays={[3]}
        pmDays={[5]}
        countsByWeekday={[0, 2, 0, 4, 0, 2, 0]}
        totalSessions={8}
      />,
    );
    expect(screen.getByTestId("spa-pct-1").textContent).toBe("25%");
    expect(screen.getByTestId("spa-pct-3").textContent).toBe("50%");
    expect(screen.getByTestId("spa-pct-5").textContent).toBe("25%");
    // Weekdays with zero SPA sessions still render no %.
    for (const d of [2, 4]) {
      expect(screen.queryByTestId(`spa-pct-${d}`)).toBeNull();
    }
  });
});

describe("WeekdayStrip percentage rendering (on-call)", () => {
  it("suppresses the percentage when totalOnCallSessions is 0", () => {
    render(
      <WeekdayStrip
        label="On-call"
        highlighted={[1]}
        tone="amber"
        countsByWeekday={[0, 0, 0, 0, 0, 0, 0]}
        totalSessions={0}
      />,
    );
    expect(screen.queryByText(/%/)).toBeNull();
    expect(screen.queryByText(/NaN/)).toBeNull();
    for (const d of [1, 2, 3, 4, 5]) {
      expect(screen.queryByTestId(`weekday-pct-${d}`)).toBeNull();
    }
  });

  it("suppresses the percentage when countsByWeekday is omitted entirely", () => {
    // Private/SAG-style call site: highlighted-only, no counts wired in.
    render(
      <WeekdayStrip label="Private / SAG" highlighted={[2, 4]} tone="primary" />,
    );
    expect(screen.queryByText(/%/)).toBeNull();
    for (const d of [1, 2, 3, 4, 5]) {
      expect(screen.queryByTestId(`weekday-pct-${d}`)).toBeNull();
    }
  });

  it("renders count / total percentages on every on-call weekday that has sessions", () => {
    // 10 on-call sessions total: 6 on Tue (regular), 3 on Fri (regular),
    // and 1 stray Wed shift that didn't hit the regularity threshold.
    render(
      <WeekdayStrip
        label="On-call"
        highlighted={[2, 5]}
        tone="amber"
        countsByWeekday={[0, 0, 6, 1, 0, 3, 0]}
        totalSessions={10}
      />,
    );
    expect(screen.getByTestId("weekday-pct-2").textContent).toBe("60%");
    expect(screen.getByTestId("weekday-pct-3").textContent).toBe("10%");
    expect(screen.getByTestId("weekday-pct-5").textContent).toBe("30%");
    // Weekdays with zero on-call sessions still render no %.
    for (const d of [1, 4]) {
      expect(screen.queryByTestId(`weekday-pct-${d}`)).toBeNull();
    }
  });
});
