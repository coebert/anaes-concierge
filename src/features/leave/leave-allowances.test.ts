import { describe, it, expect } from "vitest";
import {
  leaveWorkingDays,
  leaveOverlapsYear,
  bucketForType,
  summariseStaffLeave,
  remaining,
  DEFAULT_ANNUAL,
  DEFAULT_STUDY,
  DEFAULT_PROFESSIONAL,
  type LeaveRowLike,
  type AllowanceLike,
} from "./leave-allowances";

const STAFF = "staff-1";
const YEAR_START = "2026-04-01"; // Wed

function row(
  start: string,
  end: string,
  type: string,
  status: string = "approved",
  half: { start?: "am" | "pm"; end?: "am" | "pm" } = {},
  staff: string = STAFF,
): LeaveRowLike {
  return {
    staff_id: staff,
    type,
    status,
    start_date: start,
    end_date: end,
    half_day_start: half.start ?? null,
    half_day_end: half.end ?? null,
  };
}

describe("leaveWorkingDays", () => {
  it("counts Mon–Fri only across a full week", () => {
    // Mon 6 Apr – Fri 10 Apr 2026 = 5 working days
    expect(leaveWorkingDays(row("2026-04-06", "2026-04-10", "annual"))).toBe(5);
  });

  it("excludes Saturday and Sunday", () => {
    // Sat 11 Apr – Sun 12 Apr 2026 = 0 working days
    expect(leaveWorkingDays(row("2026-04-11", "2026-04-12", "annual"))).toBe(0);
    // Fri–Mon spans a weekend: Fri + Mon = 2
    expect(leaveWorkingDays(row("2026-04-10", "2026-04-13", "annual"))).toBe(2);
  });

  it("subtracts 0.5 for half_day_start and half_day_end", () => {
    // Mon–Wed = 3 days; PM-only start (-0.5) + AM-only end (-0.5) = 2
    expect(
      leaveWorkingDays(row("2026-04-06", "2026-04-08", "annual", "approved", {
        start: "am",
        end: "pm",
      })),
    ).toBe(2);
  });

  it("handles a single-day half-day request (0.5)", () => {
    // Single Mon, PM only (half_day_start='am' means morning is off, so afternoon off → 0.5)
    expect(
      leaveWorkingDays(row("2026-04-06", "2026-04-06", "annual", "approved", { start: "am" })),
    ).toBe(0.5);
  });

  it("never returns a negative count", () => {
    // Pure weekend with half-day markers shouldn't go below 0
    expect(
      leaveWorkingDays(row("2026-04-11", "2026-04-12", "annual", "approved", {
        start: "am",
        end: "pm",
      })),
    ).toBe(0);
  });
});

describe("leaveOverlapsYear", () => {
  it("includes a request entirely inside the leave year", () => {
    expect(leaveOverlapsYear(row("2026-06-01", "2026-06-05", "annual"), YEAR_START)).toBe(true);
  });
  it("excludes a request entirely before the leave year", () => {
    expect(leaveOverlapsYear(row("2026-03-01", "2026-03-05", "annual"), YEAR_START)).toBe(false);
  });
  it("excludes a request starting on the next year's start (exclusive end)", () => {
    expect(leaveOverlapsYear(row("2027-04-01", "2027-04-02", "annual"), YEAR_START)).toBe(false);
  });
  it("includes a request straddling the year boundary", () => {
    expect(leaveOverlapsYear(row("2026-03-30", "2026-04-02", "annual"), YEAR_START)).toBe(true);
  });
});

describe("bucketForType", () => {
  it("routes the canonical types", () => {
    expect(bucketForType("annual")).toBe("annual");
    expect(bucketForType("study")).toBe("study");
    expect(bucketForType("professional")).toBe("professional");
  });
  it("routes sick/parental/compassionate/unknown to other", () => {
    expect(bucketForType("sick")).toBe("other");
    expect(bucketForType("parental")).toBe("other");
    expect(bucketForType("compassionate")).toBe("other");
    expect(bucketForType("anything-else")).toBe("other");
  });
});

describe("summariseStaffLeave — mixed types & statuses", () => {
  const rows: LeaveRowLike[] = [
    // Annual: 5 approved + 2 pending
    row("2026-04-06", "2026-04-10", "annual", "approved"),       // 5
    row("2026-05-04", "2026-05-05", "annual", "pending"),        // 2
    // Study: 3 approved (attended a course)
    row("2026-06-08", "2026-06-10", "study", "approved"),        // 3
    // Professional: 1 approved (teaching) + 0.5 pending (PM faculty)
    row("2026-07-13", "2026-07-13", "professional", "approved"), // 1
    row("2026-08-10", "2026-08-10", "professional", "pending", { start: "am" }), // 0.5
    // Other: 2 sick (informational)
    row("2026-09-07", "2026-09-08", "sick", "approved"),         // 2
    // Ignored: rejected & cancelled
    row("2026-10-05", "2026-10-09", "annual", "rejected"),
    row("2026-11-02", "2026-11-06", "study", "cancelled"),
    // Ignored: outside leave year (before 1 Apr 2026)
    row("2026-03-02", "2026-03-06", "annual", "approved"),
    // Ignored: different staff
    row("2026-04-13", "2026-04-17", "annual", "approved", {}, "staff-2"),
  ];

  const allowance: AllowanceLike = {
    staff_id: STAFF,
    leave_year_start: YEAR_START,
    annual_days: 27,
    study_days: 10,
    professional_days: 5,
  };

  const summary = summariseStaffLeave(STAFF, rows, allowance, YEAR_START);

  it("sums annual taken/booked correctly", () => {
    expect(summary.annual.taken).toBe(5);
    expect(summary.annual.booked).toBe(2);
  });

  it("keeps study and professional separate (post-backfill invariant)", () => {
    expect(summary.study.taken).toBe(3);
    expect(summary.study.booked).toBe(0);
    expect(summary.professional.taken).toBe(1);
    expect(summary.professional.booked).toBe(0.5);
  });

  it("groups sick into the informational 'other' bucket", () => {
    expect(summary.other.taken).toBe(2);
    expect(summary.other.booked).toBe(0);
  });

  it("computes remaining = allowance - taken - booked", () => {
    expect(remaining(summary.annualAllowance, summary.annual)).toBe(27 - 5 - 2); // 20
    expect(remaining(summary.studyAllowance, summary.study)).toBe(10 - 3);       // 7
    expect(remaining(summary.professionalAllowance, summary.professional)).toBe(5 - 1 - 0.5); // 3.5
  });

  it("ignores rejected, cancelled, out-of-year and other-staff rows", () => {
    // If any were counted, annual.taken would exceed 5.
    expect(summary.annual.taken).toBe(5);
    expect(summary.study.taken).toBe(3);
  });
});

describe("summariseStaffLeave — backfill effect (study → professional)", () => {
  // Same staff, same dates; only the type changes. Before backfill all 3 entries
  // were 'study'; after backfill, the teaching/faculty entries are 'professional'.
  const datesAndStatus: Array<[string, string, string]> = [
    ["2026-04-20", "2026-04-20", "approved"], // faculty 1 day
    ["2026-05-18", "2026-05-19", "approved"], // teaching 2 days
    ["2026-06-15", "2026-06-15", "approved"], // genuine course 1 day
  ];

  it("pre-backfill: all 4 days land in study", () => {
    const rows = datesAndStatus.map(([s, e, st]) => row(s, e, "study", st));
    const s = summariseStaffLeave(STAFF, rows, undefined, YEAR_START);
    expect(s.study.taken).toBe(4);
    expect(s.professional.taken).toBe(0);
    expect(remaining(s.studyAllowance, s.study)).toBe(DEFAULT_STUDY - 4);
    expect(remaining(s.professionalAllowance, s.professional)).toBe(DEFAULT_PROFESSIONAL);
  });

  it("post-backfill: 3 days move to professional, 1 stays as study", () => {
    const rows = [
      row("2026-04-20", "2026-04-20", "professional"),
      row("2026-05-18", "2026-05-19", "professional"),
      row("2026-06-15", "2026-06-15", "study"),
    ];
    const s = summariseStaffLeave(STAFF, rows, undefined, YEAR_START);
    expect(s.study.taken).toBe(1);
    expect(s.professional.taken).toBe(3);
    // Critical: total days off the books is unchanged by the reclassification.
    expect(s.study.taken + s.professional.taken).toBe(4);
    expect(remaining(s.studyAllowance, s.study)).toBe(DEFAULT_STUDY - 1);
    expect(remaining(s.professionalAllowance, s.professional)).toBe(DEFAULT_PROFESSIONAL - 3);
  });
});

describe("summariseStaffLeave — partial-day edge cases", () => {
  it("two single-day halves on the same week sum to 1 day", () => {
    const rows = [
      row("2026-04-06", "2026-04-06", "professional", "approved", { start: "am" }), // 0.5
      row("2026-04-08", "2026-04-08", "professional", "approved", { end: "pm" }),   // 0.5
    ];
    const s = summariseStaffLeave(STAFF, rows, undefined, YEAR_START);
    expect(s.professional.taken).toBe(1);
  });

  it("a multi-day request with both half-day markers deducts exactly 1 day", () => {
    // Mon–Fri = 5 working days; -0.5 start -0.5 end = 4
    const rows = [
      row("2026-04-06", "2026-04-10", "study", "approved", { start: "am", end: "pm" }),
    ];
    const s = summariseStaffLeave(STAFF, rows, undefined, YEAR_START);
    expect(s.study.taken).toBe(4);
  });

  it("falls back to DEFAULT_* allowances when none stored", () => {
    const s = summariseStaffLeave(STAFF, [], undefined, YEAR_START);
    expect(s.annualAllowance).toBe(DEFAULT_ANNUAL);
    expect(s.studyAllowance).toBe(DEFAULT_STUDY);
    expect(s.professionalAllowance).toBe(DEFAULT_PROFESSIONAL);
  });
});
