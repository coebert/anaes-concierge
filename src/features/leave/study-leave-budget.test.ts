import { describe, it, expect } from "vitest";
import { computeStudyBudget, previewAfterDecision, type StudyLeaveRow } from "./study-leave-budget";

const staffId = "s1";
const allowance = { leave_year_start: "2026-04-01", study_days: 10, study_budget_gbp: 800 };
const defaultYear = "2026-04-01";

function row(
  o: Partial<StudyLeaveRow> & Pick<StudyLeaveRow, "id" | "status" | "start_date" | "end_date">,
): StudyLeaveRow {
  return {
    staff_id: staffId,
    type: "study",
    half_day_start: null,
    half_day_end: null,
    study_cost_gbp: null,
    ...o,
  };
}

describe("computeStudyBudget", () => {
  it("returns full allowance / budget when there are no study rows", () => {
    const b = computeStudyBudget(staffId, [], allowance, defaultYear);
    expect(b.daysAllowance).toBe(10);
    expect(b.budgetGbp).toBe(800);
    expect(b.daysRemaining).toBe(10);
    expect(b.remainingGbp).toBe(800);
  });

  it("subtracts approved days and £ as taken/spent", () => {
    const b = computeStudyBudget(
      staffId,
      [
        row({
          id: "A",
          status: "approved",
          start_date: "2026-05-04",
          end_date: "2026-05-06",
          study_cost_gbp: 250,
        }), // Mon–Wed = 3 days
      ],
      allowance,
      defaultYear,
    );
    expect(b.daysTaken).toBe(3);
    expect(b.spentGbp).toBe(250);
    expect(b.daysRemaining).toBe(7);
    expect(b.remainingGbp).toBe(550);
  });

  it("subtracts pending days and £ as booked/pending", () => {
    const b = computeStudyBudget(
      staffId,
      [
        row({
          id: "P",
          status: "pending",
          start_date: "2026-06-01",
          end_date: "2026-06-02",
          study_cost_gbp: 400,
        }), // 2 days
      ],
      allowance,
      defaultYear,
    );
    expect(b.daysPending).toBe(2);
    expect(b.pendingGbp).toBe(400);
    expect(b.daysRemaining).toBe(8);
    expect(b.remainingGbp).toBe(400);
  });

  it("ignores non-study, other-staff and out-of-year rows", () => {
    const b = computeStudyBudget(
      staffId,
      [
        row({
          id: "1",
          type: "annual",
          status: "approved",
          start_date: "2026-05-04",
          end_date: "2026-05-08",
        }),
        row({
          id: "2",
          staff_id: "other",
          status: "approved",
          start_date: "2026-05-04",
          end_date: "2026-05-08",
          study_cost_gbp: 999,
        }),
        row({
          id: "3",
          status: "approved",
          start_date: "2025-05-04",
          end_date: "2025-05-06",
          study_cost_gbp: 500,
        }),
      ],
      allowance,
      defaultYear,
    );
    expect(b.daysTaken).toBe(0);
    expect(b.spentGbp).toBe(0);
  });

  it("excludes the request under review when previewing", () => {
    const rows: StudyLeaveRow[] = [
      row({
        id: "P",
        status: "pending",
        start_date: "2026-06-01",
        end_date: "2026-06-02",
        study_cost_gbp: 400,
      }),
    ];
    const b = computeStudyBudget(staffId, rows, allowance, defaultYear, "P");
    expect(b.daysPending).toBe(0);
    expect(b.pendingGbp).toBe(0);
  });

  it("goes negative when a request would exceed budget (does not clamp)", () => {
    const b = computeStudyBudget(
      staffId,
      [
        row({
          id: "A",
          status: "approved",
          start_date: "2026-05-04",
          end_date: "2026-05-08",
          study_cost_gbp: 900,
        }), // 5 days, £900
      ],
      allowance,
      defaultYear,
    );
    expect(b.remainingGbp).toBe(-100);
    expect(b.daysRemaining).toBe(5);
  });

  it("falls back to zero allowance / budget when no allowance row exists", () => {
    const b = computeStudyBudget(staffId, [], undefined, defaultYear);
    expect(b.daysAllowance).toBe(0);
    expect(b.budgetGbp).toBe(0);
  });
});

describe("previewAfterDecision", () => {
  const base = {
    yearStartISO: "2026-04-01",
    daysAllowance: 10,
    daysTaken: 3,
    daysPending: 2,
    daysRemaining: 5,
    budgetGbp: 800,
    spentGbp: 250,
    pendingGbp: 400,
    remainingGbp: 150,
    crossYearCostRequestIds: [] as string[],
    unallocatedCosts: [],
    unallocatedGbp: 0,
    balanceProvisional: false,
  };

  it("approving adds days and £ to taken/spent", () => {
    const p = previewAfterDecision(base, { days: 2, costGbp: 100 }, "approved");
    expect(p.daysTaken).toBe(5);
    expect(p.spentGbp).toBe(350);
    expect(p.daysRemaining).toBe(3);
    expect(p.remainingGbp).toBe(50);
  });

  it("rejecting leaves the base unchanged", () => {
    expect(previewAfterDecision(base, { days: 2, costGbp: 100 }, "rejected")).toBe(base);
  });

  it("pending adds to booked totals", () => {
    const p = previewAfterDecision(base, { days: 1, costGbp: 200 }, "pending");
    expect(p.daysPending).toBe(3);
    expect(p.pendingGbp).toBe(600);
    expect(p.daysRemaining).toBe(4);
    expect(p.remainingGbp).toBe(-50);
  });
});

describe("cross-year course cost — owner policy: leave for manual review", () => {
  // Synthetic course 30 Mar – 2 Apr 2026 straddling the 1 Apr leave-year start.
  const course = row({
    id: "X",
    status: "approved",
    start_date: "2026-03-30",
    end_date: "2026-04-02",
    study_cost_gbp: 600,
  });
  const y25 = { leave_year_start: "2025-04-01", study_days: 10, study_budget_gbp: 800 };
  const y26 = { leave_year_start: "2026-04-01", study_days: 10, study_budget_gbp: 800 };

  it("charges the cost to neither the starting nor the following year", () => {
    const a = computeStudyBudget(staffId, [course], y25, "2025-04-01");
    const b = computeStudyBudget(staffId, [course], y26, "2026-04-01");
    expect(a.spentGbp).toBe(0);
    expect(b.spentGbp).toBe(0);
    // days still split by actual date (Mon 30, Tue 31 Mar | Wed 1, Thu 2 Apr)
    expect(a.daysTaken).toBe(2);
    expect(b.daysTaken).toBe(2);
  });

  it("shows the pending £ amount and list in both years", () => {
    for (const al of [y25, y26]) {
      const b = computeStudyBudget(staffId, [course], al, al.leave_year_start);
      expect(b.unallocatedGbp).toBe(600);
      expect(b.unallocatedCosts).toEqual([{ id: "X", costGbp: 600, status: "approved" }]);
    }
  });

  it("marks the balance provisional so the excluded cost never reads as spare budget", () => {
    const b = computeStudyBudget(staffId, [course], y26, "2026-04-01");
    expect(b.remainingGbp).toBe(800);
    expect(b.balanceProvisional).toBe(true);
    const plain = computeStudyBudget(staffId, [], y26, "2026-04-01");
    expect(plain.balanceProvisional).toBe(false);
  });

  it("keeps the original cost on the record untouched", () => {
    computeStudyBudget(staffId, [course], y26, "2026-04-01");
    expect(course.study_cost_gbp).toBe(600);
  });
});
