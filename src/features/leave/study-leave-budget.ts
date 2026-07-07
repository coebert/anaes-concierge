/**
 * Study-leave budget calculations.
 *
 * Trainees typically have both a DAYS allowance (e.g. HEE minimum of 30 days
 * over 3 years, ≈10/year) and a £ budget (e.g. £800/year for courses, travel
 * and accommodation). Coordinators need to see BOTH remaining figures before
 * approving a study-leave request.
 *
 * Both figures are computed over the staff member's leave year:
 *   - Approved requests → "taken" (already spent)
 *   - Pending requests  → "committed" (ring-fenced pending decision)
 *   - The current request under review is excluded so previewing a new
 *     decision doesn't double-count it.
 */

import {
  leaveOverlapsYear,
  leaveWorkingDays,
  type LeaveRowLike,
} from "./leave-allowances";

export interface StudyLeaveRow extends LeaveRowLike {
  id: string;
  study_cost_gbp: number | null;
}

export interface StudyBudget {
  yearStartISO: string;
  daysAllowance: number;
  daysTaken: number;
  daysPending: number;
  daysRemaining: number;
  budgetGbp: number;
  spentGbp: number;
  pendingGbp: number;
  remainingGbp: number;
}

/**
 * Compute a trainee's study-leave budget for the given leave year.
 *
 * @param staffId          The staff member the budget belongs to.
 * @param rows             All that staff member's leave rows (any type / status).
 * @param allowance        Their annual allowance (days + £), or undefined for defaults.
 * @param defaultYearStart Fallback leave-year start if no allowance row exists.
 * @param excludeRequestId If set, that leave-request id is ignored when
 *                         totalling — used when previewing a decision on it.
 */
export function computeStudyBudget(
  staffId: string,
  rows: StudyLeaveRow[],
  allowance: { leave_year_start: string; study_days: number; study_budget_gbp: number } | undefined,
  defaultYearStart: string,
  excludeRequestId?: string,
): StudyBudget {
  const yearStartISO = allowance?.leave_year_start ?? defaultYearStart;
  const daysAllowance = Number(allowance?.study_days ?? 0);
  const budgetGbp = Number(allowance?.study_budget_gbp ?? 0);

  let daysTaken = 0;
  let daysPending = 0;
  let spentGbp = 0;
  let pendingGbp = 0;

  for (const r of rows) {
    if (r.staff_id !== staffId) continue;
    if (r.type !== "study") continue;
    if (excludeRequestId && r.id === excludeRequestId) continue;
    if (!leaveOverlapsYear(r, yearStartISO)) continue;
    const days = leaveWorkingDays(r);
    const cost = Number(r.study_cost_gbp ?? 0);
    if (r.status === "approved") {
      daysTaken += days;
      spentGbp += cost;
    } else if (r.status === "pending") {
      daysPending += days;
      pendingGbp += cost;
    }
  }

  return {
    yearStartISO,
    daysAllowance,
    daysTaken,
    daysPending,
    daysRemaining: daysAllowance - daysTaken - daysPending,
    budgetGbp,
    spentGbp,
    pendingGbp,
    remainingGbp: budgetGbp - spentGbp - pendingGbp,
  };
}

/**
 * Preview the budget position AFTER a hypothetical decision on `request`.
 * Only the £ figure is affected by `costGbp` — days come from the request
 * itself.
 */
export function previewAfterDecision(
  base: StudyBudget,
  request: { days: number; costGbp: number },
  decision: "approved" | "rejected" | "pending",
): StudyBudget {
  const days = Math.max(0, request.days);
  const cost = Math.max(0, request.costGbp);
  if (decision === "approved") {
    const daysTaken = base.daysTaken + days;
    const spentGbp = base.spentGbp + cost;
    return {
      ...base,
      daysTaken,
      spentGbp,
      daysRemaining: base.daysAllowance - daysTaken - base.daysPending,
      remainingGbp: base.budgetGbp - spentGbp - base.pendingGbp,
    };
  }
  if (decision === "pending") {
    const daysPending = base.daysPending + days;
    const pendingGbp = base.pendingGbp + cost;
    return {
      ...base,
      daysPending,
      pendingGbp,
      daysRemaining: base.daysAllowance - base.daysTaken - daysPending,
      remainingGbp: base.budgetGbp - base.spentGbp - pendingGbp,
    };
  }
  // rejected → base unchanged
  return base;
}

/**
 * Two-line human summary suitable for a tooltip / aria-label.
 * Uses en-GB pounds formatting.
 */
export function formatBudgetSummary(b: StudyBudget): string {
  const gbp = (n: number) =>
    new Intl.NumberFormat("en-GB", {
      style: "currency",
      currency: "GBP",
      maximumFractionDigits: 0,
    }).format(n);
  return (
    `Days: ${b.daysRemaining.toFixed(1)} of ${b.daysAllowance} remaining ` +
    `(${b.daysTaken} taken, ${b.daysPending} pending). ` +
    `Budget: ${gbp(b.remainingGbp)} of ${gbp(b.budgetGbp)} remaining ` +
    `(${gbp(b.spentGbp)} spent, ${gbp(b.pendingGbp)} pending).`
  );
}
