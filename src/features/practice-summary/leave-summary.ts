/**
 * Leave section of "My practice summary": the caller's own APPROVED leave in
 * the chosen dates. Working days come only from the canonical
 * `countLeaveWorkingDays` (Mon–Fri, clipped to the range before counting,
 * half-day markers at kept boundary days). Pending, rejected and cancelled
 * requests are counted but never added to the days. No reasons or notes.
 */
import { addDaysIso, countLeaveWorkingDays, type DateWindow } from "@/features/leave/leave-count";
import { LEAVE_TYPE_LABEL, type LeaveType } from "@/features/leave/entitlement-ledger";

export interface PracticeLeaveRow {
  id: string;
  type: string | null;
  status: string | null;
  start_date: string | null;
  end_date: string | null;
  half_day_start: string | null;
  half_day_end: string | null;
  clwrota_external_id: string | null;
}

export interface LeaveTypeLine {
  type: string;
  label: string;
  requests: number;
  workingDays: number;
  /** Of `workingDays`, those after today (booked, not yet taken). */
  plannedWorkingDays: number;
}

export interface PracticeLeaveSummary {
  byType: LeaveTypeLine[];
  approvedRequests: number;
  workingDays: number;
  plannedWorkingDays: number;
  pendingRequests: number;
  /** Rejected or cancelled — shown for completeness, never counted as days. */
  notTakenRequests: number;
  /** Approved requests imported from CLWRota (it sends no half-day markers). */
  fromClwrota: number;
  withHalfDay: number;
}

const ORDER: LeaveType[] = [
  "annual",
  "study",
  "professional",
  "toil",
  "sick",
  "parental",
  "compassionate",
  "carers",
  "jury",
  "industrial",
  "other",
];

const round2 = (n: number) => Math.round(n * 100) / 100;

export function summariseLeave(input: {
  rows: readonly PracticeLeaveRow[];
  from: string;
  to: string;
  today: string;
}): PracticeLeaveSummary {
  const { from, to, today } = input;
  const range: DateWindow = { start: from, endExclusive: addDaysIso(to, 1) };
  const afterToday = addDaysIso(today, 1);
  const future: DateWindow | null =
    afterToday <= to
      ? { start: afterToday > from ? afterToday : from, endExclusive: range.endExclusive }
      : null;

  const byType = new Map<string, LeaveTypeLine>();
  const seen = new Set<string>();
  let pending = 0;
  let notTaken = 0;
  let fromClwrota = 0;
  let withHalfDay = 0;
  for (const r of input.rows) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    if (!r.start_date || !r.end_date || r.start_date > to || r.end_date < from) continue;
    if (r.status === "pending") {
      pending += 1;
      continue;
    }
    if (r.status !== "approved") {
      notTaken += 1;
      continue;
    }
    const leave = {
      start_date: r.start_date,
      end_date: r.end_date,
      half_day_start: r.half_day_start,
      half_day_end: r.half_day_end,
    };
    const type = r.type && r.type in LEAVE_TYPE_LABEL ? r.type : "other";
    const line = byType.get(type) ?? {
      type,
      label: LEAVE_TYPE_LABEL[type as LeaveType],
      requests: 0,
      workingDays: 0,
      plannedWorkingDays: 0,
    };
    line.requests += 1;
    line.workingDays = round2(line.workingDays + countLeaveWorkingDays(leave, range));
    if (future)
      line.plannedWorkingDays = round2(
        line.plannedWorkingDays + countLeaveWorkingDays(leave, future),
      );
    byType.set(type, line);
    if (r.clwrota_external_id) fromClwrota += 1;
    if (r.half_day_start || r.half_day_end) withHalfDay += 1;
  }
  const lines = ORDER.filter((t) => byType.has(t)).map((t) => byType.get(t)!);
  return {
    byType: lines,
    approvedRequests: lines.reduce((a, l) => a + l.requests, 0),
    workingDays: round2(lines.reduce((a, l) => a + l.workingDays, 0)),
    plannedWorkingDays: round2(lines.reduce((a, l) => a + l.plannedWorkingDays, 0)),
    pendingRequests: pending,
    notTakenRequests: notTaken,
    fromClwrota,
    withHalfDay,
  };
}
