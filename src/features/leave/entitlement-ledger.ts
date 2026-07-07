// Pure TS entitlement engine — no DB deps.
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

export type LeaveStatus =
  | "pending"
  | "approved"
  | "denied"
  | "cancelled"
  | "reserve";

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
  prorated: number;    // after LTFT / mid-year
  carryOver: number;
  taken: number;
  pending: number;
  remaining: number;
}

const DAY_MS = 86_400_000;

function toDate(s: string): Date {
  return new Date(s + (s.length === 10 ? "T00:00:00Z" : ""));
}

function daysBetweenInclusive(a: string, b: string): number {
  const d1 = toDate(a).getTime();
  const d2 = toDate(b).getTime();
  return Math.max(0, Math.round((d2 - d1) / DAY_MS) + 1);
}

/** Calendar-day count of a leave request, half-days counted as 0.5. */
export function leaveDayCount(row: LeaveRow): number {
  let days = daysBetweenInclusive(row.start_date, row.end_date);
  if (row.half_day_start) days -= 0.5;
  if (row.half_day_end && row.start_date !== row.end_date) days -= 0.5;
  if (row.half_day_start && row.start_date === row.end_date && row.half_day_end) {
    days = 0.5; // single-day half-day of a half — normalise to 0.5
  }
  return Math.max(0, days);
}

/**
 * Compute the pro-rating fraction for a staff member in a given leave year.
 * Combines LTFT fraction × (days-in-post inside the year / 365).
 */
export function proratingFraction(
  allowance: AllowanceRow,
  profile: ProfileForProrating,
): number {
  const yearStart = toDate(allowance.leave_year_start);
  const yearEnd = new Date(yearStart.getTime() + 365 * DAY_MS - 1);
  const startedAt = profile.start_date ? toDate(profile.start_date) : yearStart;
  const leftAt = profile.left_at ? toDate(profile.left_at) : yearEnd;
  const effectiveStart = startedAt > yearStart ? startedAt : yearStart;
  const effectiveEnd = leftAt < yearEnd ? leftAt : yearEnd;
  const daysInPost = Math.max(
    0,
    Math.round((effectiveEnd.getTime() - effectiveStart.getTime()) / DAY_MS) + 1,
  );
  const timeFraction = Math.min(1, daysInPost / 365);
  const ltft = allowance.ltft_fraction ?? 1;
  return Math.round(timeFraction * ltft * 1000) / 1000;
}

/**
 * Filter leave rows to those overlapping the given leave-year window.
 * A row overlaps if its date range intersects [yearStart, yearStart+365).
 */
export function rowsInLeaveYear(
  rows: LeaveRow[],
  allowance: AllowanceRow,
): LeaveRow[] {
  const start = toDate(allowance.leave_year_start).getTime();
  const end = start + 365 * DAY_MS;
  return rows.filter((r) => {
    const s = toDate(r.start_date).getTime();
    const e = toDate(r.end_date).getTime();
    return e >= start && s < end;
  });
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
    case "annual": return a.annual_days;
    case "study": return a.study_days;
    case "professional": return a.professional_days;
    case "carers": return a.carers_days;
    case "parental": return a.parental_days;
    case "compassionate": return a.compassionate_days;
    default: return 0;
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
      .reduce((s, r) => s + leaveDayCount(r), 0);
    const pending = rowsThisYear
      .filter((r) => r.type === type && r.status === "pending")
      .reduce((s, r) => s + leaveDayCount(r), 0);
    const remaining =
      Math.round((prorated + carryOver - taken - pending) * 100) / 100;
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
