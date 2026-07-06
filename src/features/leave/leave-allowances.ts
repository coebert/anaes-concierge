/**
 * Pure helpers for leave-allowance aggregation. Kept free of React/Supabase
 * imports so they can be unit-tested.
 */

export type LeaveBucketKey = "annual" | "study" | "professional" | "other";

export interface LeaveRowLike {
  staff_id: string;
  type: string;
  status: string;
  start_date: string; // YYYY-MM-DD
  end_date: string;   // YYYY-MM-DD
  half_day_start: string | null;
  half_day_end: string | null;
}

export interface AllowanceLike {
  staff_id: string;
  leave_year_start: string;
  annual_days: number;
  study_days: number;
  professional_days: number;
}

export interface Bucket {
  taken: number;   // approved
  booked: number;  // pending
}

export interface AllowanceSummary {
  staffId: string;
  yearStartISO: string;
  annualAllowance: number;
  studyAllowance: number;
  professionalAllowance: number;
  annual: Bucket;
  study: Bucket;
  professional: Bucket;
  other: Bucket;
}

export const DEFAULT_ANNUAL = 27;
export const DEFAULT_STUDY = 10;
export const DEFAULT_PROFESSIONAL = 5;

/**
 * Working-day length of a leave request (Mon–Fri only), with half-day
 * markers reducing the total by 0.5 each.
 */
export function leaveWorkingDays(
  r: Pick<LeaveRowLike, "start_date" | "end_date" | "half_day_start" | "half_day_end">,
): number {
  let count = 0;
  const start = new Date(r.start_date + "T00:00:00Z");
  const end = new Date(r.end_date + "T00:00:00Z");
  for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) count++;
  }
  if (r.half_day_start) count -= 0.5;
  if (r.half_day_end) count -= 0.5;
  return Math.max(0, count);
}

/** True if the leave window overlaps [yearStart, yearStart + 1y). */
export function leaveOverlapsYear(
  r: Pick<LeaveRowLike, "start_date" | "end_date">,
  yearStartISO: string,
): boolean {
  const yStart = new Date(yearStartISO + "T00:00:00Z");
  const yEnd = new Date(yStart);
  yEnd.setUTCFullYear(yEnd.getUTCFullYear() + 1);
  const lStart = new Date(r.start_date + "T00:00:00Z");
  const lEnd = new Date(r.end_date + "T00:00:00Z");
  return lStart < yEnd && lEnd >= yStart;
}

/** Map a leave_requests.type value into its allowance bucket. */
export function bucketForType(type: string): LeaveBucketKey {
  if (type === "annual") return "annual";
  if (type === "study") return "study";
  if (type === "professional") return "professional";
  return "other";
}

/**
 * Aggregate one staff member's leave into bucketed taken/booked totals.
 * - approved → taken
 * - pending  → booked
 * - other statuses (rejected/cancelled) are ignored
 * - rows outside the staff's leave year are ignored
 */
export function summariseStaffLeave(
  staffId: string,
  rows: LeaveRowLike[],
  allowance: AllowanceLike | undefined,
  defaultYearStartISO: string,
): AllowanceSummary {
  const yearStartISO = allowance?.leave_year_start ?? defaultYearStartISO;
  const annualAllowance = Number(allowance?.annual_days ?? DEFAULT_ANNUAL);
  const studyAllowance = Number(allowance?.study_days ?? DEFAULT_STUDY);
  const professionalAllowance = Number(allowance?.professional_days ?? DEFAULT_PROFESSIONAL);

  const buckets: Record<LeaveBucketKey, Bucket> = {
    annual: { taken: 0, booked: 0 },
    study: { taken: 0, booked: 0 },
    professional: { taken: 0, booked: 0 },
    other: { taken: 0, booked: 0 },
  };

  for (const r of rows) {
    if (r.staff_id !== staffId) continue;
    if (!leaveOverlapsYear(r, yearStartISO)) continue;
    const days = leaveWorkingDays(r);
    if (days <= 0) continue;
    const key = bucketForType(r.type);
    if (r.status === "approved") buckets[key].taken += days;
    else if (r.status === "pending") buckets[key].booked += days;
  }

  return {
    staffId,
    yearStartISO,
    annualAllowance,
    studyAllowance,
    professionalAllowance,
    annual: buckets.annual,
    study: buckets.study,
    professional: buckets.professional,
    other: buckets.other,
  };
}

/** Remaining days for a given bucket (allowance minus taken+booked). */
export function remaining(allowance: number, b: Bucket): number {
  return allowance - b.taken - b.booked;
}
