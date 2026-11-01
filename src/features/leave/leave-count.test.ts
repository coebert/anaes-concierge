import { describe, expect, it } from "vitest";
import {
  addYearsIso,
  countLeaveWorkingDays,
  isValidIsoDate,
  leaveYearLength,
  leaveYearStartFor,
  leaveYearWindow,
  prorationFraction,
} from "./leave-count";
import { leaveWorkingDays, summariseStaffLeave } from "./leave-allowances";
import { computeEntitlementLedger, leaveDayCount, proratingFraction } from "./entitlement-ledger";
import { computeStudyBudget } from "./study-leave-budget";
import { countWorkingDays } from "./leave-utils";
import { validateHalfDayRange } from "./half-day-validation";

const Y26 = "2026-04-01";
const r = (
  start_date: string,
  end_date: string,
  half_day_start: string | null = null,
  half_day_end: string | null = null,
) => ({ start_date, end_date, half_day_start, half_day_end });

describe("A. unified leave counting", () => {
  it("30 Mar–2 Apr 2026 clipped to the year starting 1 Apr 2026 counts 2 working days, not 4", () => {
    expect(countLeaveWorkingDays(r("2026-03-30", "2026-04-02"), leaveYearWindow(Y26))).toBe(2);
    expect(leaveWorkingDays(r("2026-03-30", "2026-04-02"), Y26)).toBe(2);
  });
  it("Sat 11 Apr PM → Mon 13 Apr full counts 1, not 0.5 (weekend half marker ignored)", () => {
    expect(countLeaveWorkingDays(r("2026-04-11", "2026-04-13", "pm"))).toBe(1);
    expect(countWorkingDays("2026-04-11", "2026-04-13", "pm")).toBe(1);
  });
  it("Fri 10 Apr → Mon 13 Apr counts 2, not 4", () => {
    expect(countLeaveWorkingDays(r("2026-04-10", "2026-04-13"))).toBe(2);
    expect(
      leaveDayCount({
        id: "x",
        type: "annual",
        status: "approved",
        ...r("2026-04-10", "2026-04-13"),
      }),
    ).toBe(2);
  });
  it("Mon 6 Apr with end='am' counts 0.5, not 1", () => {
    expect(countLeaveWorkingDays(r("2026-04-06", "2026-04-06", null, "am"))).toBe(0.5);
    expect(
      leaveDayCount({
        id: "x",
        type: "annual",
        status: "approved",
        ...r("2026-04-06", "2026-04-06", null, "am"),
      }),
    ).toBe(0.5);
  });
  it("half marker on a clipped-away boundary is not applied", () => {
    // starts PM on Tue 31 Mar (previous year) — the 2026 year sees 1–2 Apr full days.
    expect(countLeaveWorkingDays(r("2026-03-31", "2026-04-02", "pm"), leaveYearWindow(Y26))).toBe(
      2,
    );
    // ends AM on Wed 1 Apr 2027 — clipped out of the 2026 year, Mon 29–Wed 31 Mar count fully.
    expect(
      countLeaveWorkingDays(r("2027-03-29", "2027-04-01", null, "am"), leaveYearWindow(Y26)),
    ).toBe(3);
  });
  it("allowance summary, entitlement ledger, study budget and dialog agree", () => {
    const rows = [
      { staff_id: "s", type: "annual", status: "approved", ...r("2026-03-30", "2026-04-02") },
    ];
    const sum = summariseStaffLeave("s", rows, undefined, Y26);
    expect(sum.annual.taken).toBe(2);
    const ledger = computeEntitlementLedger(
      {
        leave_year_start: Y26,
        annual_days: 27,
        study_days: 10,
        professional_days: 5,
        carers_days: 0,
        parental_days: 0,
        compassionate_days: 0,
        ltft_fraction: 1,
        carry_over_days: 0,
        sla_target_days: 0,
      },
      {},
      [{ id: "1", type: "annual", status: "approved", ...r("2026-03-30", "2026-04-02") }],
    );
    expect(ledger.find((l) => l.type === "annual")?.taken).toBe(2);
    const study = computeStudyBudget(
      "s",
      [
        {
          id: "a",
          staff_id: "s",
          type: "study",
          status: "approved",
          study_cost_gbp: 300,
          ...r("2026-03-30", "2026-04-02"),
        },
      ],
      { leave_year_start: Y26, study_days: 10, study_budget_gbp: 800 },
      Y26,
    );
    expect(study.daysTaken).toBe(2);
    // cross-year cost is attributed to the start year (2025) and flagged, not split
    expect(study.spentGbp).toBe(0);
    expect(study.crossYearCostRequestIds).toEqual(["a"]);
  });
});

describe("B. leave-year anniversary arithmetic", () => {
  it("31 Mar 2028 belongs to the year starting 1 Apr 2027 (leap year)", () => {
    expect(leaveYearStartFor("2028-03-31", "2026-04-01")).toBe("2027-04-01");
    expect(leaveYearStartFor("2028-04-01", "2026-04-01")).toBe("2028-04-01");
    expect(leaveYearLength("2027-04-01")).toBe(366);
    expect(leaveYearWindow("2027-04-01").endExclusive).toBe("2028-04-01");
  });
  it("leave on 31 Mar 2028 is counted in the 2027 year, not dropped", () => {
    expect(
      countLeaveWorkingDays(r("2028-03-31", "2028-03-31"), leaveYearWindow("2027-04-01")),
    ).toBe(1);
    expect(
      countLeaveWorkingDays(r("2028-03-31", "2028-03-31"), leaveYearWindow("2028-04-01")),
    ).toBe(0);
  });
  it("proration: start 1 Oct 2026 in year 1 Apr 2026 = 182/365 → 0.499", () => {
    expect(prorationFraction(Y26, { employmentStart: "2026-10-01" })).toBe(0.499);
    expect(
      proratingFraction({ leave_year_start: Y26, ltft_fraction: 1 } as never, {
        start_date: "2026-10-01",
      }),
    ).toBe(0.499);
  });
  it("full year = 1; single day; leap year; leaver; LTFT", () => {
    expect(prorationFraction(Y26)).toBe(1);
    expect(prorationFraction("2027-04-01")).toBe(1);
    expect(prorationFraction(Y26, { employmentStart: "2027-03-31" })).toBe(
      Math.round((1 / 365) * 1000) / 1000,
    );
    expect(prorationFraction(Y26, { leftAt: "2026-04-01" })).toBe(
      Math.round((1 / 365) * 1000) / 1000,
    );
    expect(prorationFraction(Y26, { employmentStart: "2027-04-01" })).toBe(0);
    expect(prorationFraction(Y26, { ltft: 0.6 })).toBe(0.6);
  });
  it("29 Feb anniversaries clamp to 28 Feb", () => {
    expect(addYearsIso("2028-02-29", 1)).toBe("2029-02-28");
  });
  it("rejects impossible dates", () => {
    expect(isValidIsoDate("2026-02-30")).toBe(false);
    expect(isValidIsoDate("2026-13-01")).toBe(false);
    expect(isValidIsoDate("2028-02-29")).toBe(true);
    expect(
      validateHalfDayRange({
        start_date: "2026-02-30",
        end_date: "2026-03-02",
        half_day_start: null,
        half_day_end: null,
      }).ok,
    ).toBe(false);
    expect(countWorkingDays("2026-02-30", "2026-03-02")).toBe(0);
  });
});
