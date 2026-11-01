// Pure TS entitlement engine — no DB deps.
import {
  countLeaveWorkingDays,
  leaveYearWindow,
  prorationFraction,
  rangeOverlapsWindow,
} from "./leave-count";
// Computes per-staff, per-leave-year entitlement, taken, pending and remaining
// with pro-rating for LTFT fraction and mid-year start/leaver dates.

export type LeaveType =
  | "annual"
  | "study"
  | "professional"
  | "compassionate"
  | "carers"
  | "parental"
  | "jury"
  | "industrial"
  | "sick"
  | "toil"
  | "other";

export type LeaveStatus = "pending" | "approved" | "denied" | "cancelled" | "reserve";

export interface AllowanceRow {
  leave_year_start: string; // ISO date
  annual_days: number;
  study_days: number;
  professional_days: number;
  carers_days: number;
  parental_days: number;
  compassionate_days: number;
  ltft_fraction: number;
  carry_over_days: number;
  sla_target_days: number;
}

export interface LeaveRow {
  id: string;
  type: LeaveType;
  status: LeaveStatus;
  start_date: string;
  end_date: string;
  half_day_start?: string | null;
  half_day_end?: string | null;
  created_at?: string | null;
  decided_at?: string | null;
}

export interface LedgerRow {
  entry_date: string;
  kind: "accrual" | "spend" | "adjustment";
  hours: number;
}

export interface ProfileForProrating {
  start_date?: string | null;
  left_at?: string | null;
}

export type EntitlementUnit = "days" | "hours";

export interface EntitlementLine {
  type: LeaveType;
  label: string;
  unit: EntitlementUnit;
  entitlement: number; // raw before pro-rating
  prorated: number; // after LTFT / mid-year
  carryOver: number;
  taken: number;
  pending: number;
  remaining: number;
}

/**
 * Working-day count of a leave request (canonical convention, see
 * leave-count.ts). Optionally clipped to a leave year before counting.
 */
export function leaveDayCount(row: LeaveRow, yearStartISO?: string): number {
  return countLeaveWorkingDays(row, yearStartISO ? leaveYearWindow(yearStartISO) : undefined);
}

/**
 * Pro-rating fraction for a staff member in a given leave year:
 * LTFT fraction × (days in post within [yearStart, next anniversary) ÷ year
 * length). `left_at` is treated as the last day in post (inclusive).
 */
export function proratingFraction(allowance: AllowanceRow, profile: ProfileForProrating): number {
  return prorationFraction(allowance.leave_year_start, {
    employmentStart: profile.start_date ?? null,
    leftAt: profile.left_at ?? null,
    ltft: allowance.ltft_fraction ?? 1,
  });
}

/** Rows overlapping [yearStart, next anniversary). */
export function rowsInLeaveYear(rows: LeaveRow[], allowance: AllowanceRow): LeaveRow[] {
  const w = leaveYearWindow(allowance.leave_year_start);
  return rows.filter((r) => rangeOverlapsWindow(r, w));
}

const TYPE_LABEL: Record<LeaveType, string> = {
  annual: "Annual leave",
  study: "Study leave",
  professional: "Professional leave",
  compassionate: "Compassionate leave",
  carers: "Carers / dependants",
  parental: "Parental leave",
  jury: "Jury service",
  industrial: "Industrial action",
  sick: "Sickness",
  toil: "Time off in lieu",
  other: "Other",
};

function entitlementFor(type: LeaveType, a: AllowanceRow): number {
  switch (type) {
    case "annual":
      return a.annual_days;
    case "study":
      return a.study_days;
    case "professional":
      return a.professional_days;
    case "carers":
      return a.carers_days;
    case "parental":
      return a.parental_days;
    case "compassionate":
      return a.compassionate_days;
    default:
      return 0;
  }
}

/** The tracked-entitlement types shown in the ledger UI. */
export const LEDGER_TYPES: LeaveType[] = [
  "annual",
  "study",
  "professional",
  "compassionate",
  "carers",
  "parental",
];

export function computeEntitlementLedger(
  allowance: AllowanceRow,
  profile: ProfileForProrating,
  leaveRows: LeaveRow[],
  toilLedger: LedgerRow[] = [],
): EntitlementLine[] {
  const prorate = proratingFraction(allowance, profile);
  const rowsThisYear = rowsInLeaveYear(leaveRows, allowance);

  const lines = LEDGER_TYPES.map<EntitlementLine>((type) => {
    const raw = entitlementFor(type, allowance);
    const prorated = Math.round(raw * prorate * 100) / 100;
    const carryOver = type === "annual" ? allowance.carry_over_days : 0;
    const taken = rowsThisYear
      .filter((r) => r.type === type && r.status === "approved")
      .reduce((s, r) => s + leaveDayCount(r, allowance.leave_year_start), 0);
    const pending = rowsThisYear
      .filter((r) => r.type === type && r.status === "pending")
      .reduce((s, r) => s + leaveDayCount(r, allowance.leave_year_start), 0);
    const remaining = Math.round((prorated + carryOver - taken - pending) * 100) / 100;
    return {
      type,
      label: TYPE_LABEL[type],
      unit: "days",
      entitlement: raw,
      prorated,
      carryOver,
      taken: Math.round(taken * 100) / 100,
      pending: Math.round(pending * 100) / 100,
      remaining,
    };
  });

  // TOIL ledger — always hours
  const toilBalance = toilLedger.reduce((s, l) => {
    if (l.kind === "spend") return s - l.hours;
    return s + l.hours;
  }, 0);
  lines.push({
    type: "toil",
    label: TYPE_LABEL.toil,
    unit: "hours",
    entitlement: 0,
    prorated: 0,
    carryOver: 0,
    taken: 0,
    pending: 0,
    remaining: Math.round(toilBalance * 100) / 100,
  });

  return lines;
}

export { TYPE_LABEL as LEAVE_TYPE_LABEL };
