import { describe, expect, it } from "vitest";
import {
  computePoacWeeklyStats,
  validatePoacBaseline,
  type PoacAssignmentInput,
} from "./poac-baseline";

// Helpers -----------------------------------------------------------------
function isoAddDays(start: string, days: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(start)!;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function dow(iso: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)!;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getDay();
}

// Build a year-long synthetic dataset starting at 2026-01-01 with mixed
// Wed AM/PM/both coverage and assorted other-day sessions.
function buildSyntheticYear(): PoacAssignmentInput[] {
  const start = "2026-01-01";
  const out: PoacAssignmentInput[] = [];
  for (let i = 0; i < 365; i += 1) {
    const date = isoAddDays(start, i);
    const d = dow(date);
    // Always add a non-Wed Friday clinic to push total above baseline.
    if (d === 5) out.push({ date, session: "am", staffId: "s-fri" });
    if (d === 3) {
      const week = Math.floor(i / 7);
      // Rotate: every 4th week skip Wed entirely (baseline 0).
      if (week % 4 === 0) continue;
      // Every 4th+1 → AM only, +2 → PM only, +3 → BOTH AM and PM.
      const mode = week % 4;
      if (mode === 1 || mode === 3) out.push({ date, session: "am", staffId: "s-wed-am" });
      if (mode === 2 || mode === 3) out.push({ date, session: "pm", staffId: "s-wed-pm" });
    }
  }
  return out;
}

describe("POAC baseline rule", () => {
  it("baseline is 1 for Wed AM only", () => {
    const w = computePoacWeeklyStats([
      { date: "2026-01-07", session: "am" }, // Wed
    ]);
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ baseline: 1, total: 1, additional: 0 });
  });

  it("baseline is 1 for Wed PM only", () => {
    const w = computePoacWeeklyStats([
      { date: "2026-01-07", session: "pm" },
    ]);
    expect(w[0]).toMatchObject({ baseline: 1, total: 1, additional: 0 });
  });

  it("baseline is still 1 when BOTH Wed AM and Wed PM are covered", () => {
    const w = computePoacWeeklyStats([
      { date: "2026-01-07", session: "am" },
      { date: "2026-01-07", session: "pm" },
    ]);
    expect(w[0]).toMatchObject({ baseline: 1, total: 2, additional: 1 });
  });

  it("baseline is 0 when no Wednesday session exists", () => {
    const w = computePoacWeeklyStats([
      { date: "2026-01-05", session: "am" }, // Mon
      { date: "2026-01-09", session: "pm" }, // Fri
    ]);
    expect(w[0]).toMatchObject({ baseline: 0, total: 2, additional: 2 });
  });
});

describe("POAC baseline validation across full 2026 range", () => {
  const weeks = computePoacWeeklyStats(buildSyntheticYear());

  it("produces 52-54 weekly buckets for a full year", () => {
    expect(weeks.length).toBeGreaterThanOrEqual(52);
    expect(weeks.length).toBeLessThanOrEqual(54);
  });

  it("every week's baseline is 0 or 1", () => {
    for (const w of weeks) {
      expect(w.baseline === 0 || w.baseline === 1).toBe(true);
    }
  });

  it("baseline is exactly 1 iff the week has a Wed AM or Wed PM session", () => {
    for (const w of weeks) {
      const hasWed = w.wedAm > 0 || w.wedPm > 0;
      expect(w.baseline).toBe(hasWed ? 1 : 0);
    }
  });

  it("baseline stays at 1 (not 2) when both Wed AM and PM are present", () => {
    const both = weeks.filter((w) => w.wedAm > 0 && w.wedPm > 0);
    expect(both.length).toBeGreaterThan(0);
    for (const w of both) expect(w.baseline).toBe(1);
  });

  it("additional == max(0, total - baseline) for every week", () => {
    for (const w of weeks) {
      expect(w.additional).toBe(Math.max(0, w.total - w.baseline));
    }
  });

  it("validatePoacBaseline reports no violations", () => {
    expect(validatePoacBaseline(weeks)).toEqual([]);
  });
});
