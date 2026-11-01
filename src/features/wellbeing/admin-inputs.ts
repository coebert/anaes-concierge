// Pure, testable selection of the 12-month signal inputs used by the admin
// Wellbeing & retention page. Every filter is anchored on an explicit
// `asOf` date so results are reproducible and future-dated rows never
// leak into "last 12 months" counts.

const DAY_MS = 86_400_000;

export interface AdminLeaveRow {
  id: string;
  staff_id: string;
  type: string;
  status: string;
  start_date: string;
  end_date: string;
  created_at?: string | null;
  decided_at: string | null;
}

export interface AdminChangeRow {
  staff_id: string | null;
  session_date: string;
  hours_before_session: number | null;
}

export interface AdminRtwRow {
  leave_request_id: string;
  conducted_at: string | null;
}

export interface AdminSignalInputs {
  denialRate12m: number;
  decisions12m: number;
  denials12m: number;
  shortNoticeChanges12m: number;
  /** null = no past/ongoing approved annual leave on record. */
  daysSinceLastAnnual: number | null;
  overdueRtwCount: number;
  /** Always null: no measured per-person pulse trend is wired in yet. */
  pulseTrend: null;
}

const day = (s: string) => s.slice(0, 10);
const addDays = (iso: string, n: number) =>
  new Date(Date.parse(iso + "T00:00:00Z") + n * DAY_MS).toISOString().slice(0, 10);

/**
 * Decision date for a leave decision. Documented fallback order:
 * decided_at → created_at → start_date (legacy rows without a decision stamp).
 */
export function leaveDecisionDay(l: AdminLeaveRow): string {
  return day(l.decided_at ?? l.created_at ?? l.start_date);
}

export function selectAdminSignalInputs(args: {
  staffId: string;
  asOf: Date;
  leave: AdminLeaveRow[];
  changes: AdminChangeRow[];
  rtws: AdminRtwRow[];
}): AdminSignalInputs {
  const asOfDay = args.asOf.toISOString().slice(0, 10);
  // 12 months = 365 inclusive calendar days ending on asOf.
  const yearStart = addDays(asOfDay, -364);
  const inYear = (d: string) => d >= yearStart && d <= asOfDay;

  const leave = args.leave.filter((l) => l.staff_id === args.staffId);

  const decisions = leave.filter(
    (l) => (l.status === "approved" || l.status === "rejected") && inYear(leaveDecisionDay(l)),
  );
  const denials = decisions.filter((l) => l.status === "rejected").length;

  const shortNotice = args.changes.filter(
    (c) =>
      c.staff_id === args.staffId &&
      inYear(day(c.session_date)) &&
      c.hours_before_session !== null &&
      c.hours_before_session <= 48 &&
      c.hours_before_session >= -48,
  ).length;

  // Only annual leave that has actually started counts as a break taken.
  // Ongoing leave (start ≤ asOf ≤ end) ⇒ 0 days since; future bookings ignored.
  const takenAnnual = leave.filter(
    (l) => l.type === "annual" && l.status === "approved" && day(l.start_date) <= asOfDay,
  );
  let daysSinceLastAnnual: number | null = null;
  for (const l of takenAnnual) {
    const effectiveEnd = day(l.end_date) < asOfDay ? day(l.end_date) : asOfDay;
    const days = Math.round(
      (Date.parse(asOfDay + "T00:00:00Z") - Date.parse(effectiveEnd + "T00:00:00Z")) / DAY_MS,
    );
    if (daysSinceLastAnnual === null || days < daysSinceLastAnnual) daysSinceLastAnnual = days;
  }

  // RTW only counts as done when it has a completion timestamp that is not
  // after asOf — a completion recorded later must not clear an interview
  // that was overdue on the as-of date.
  const asOfMs = args.asOf.getTime();
  const completedRtw = new Set(
    args.rtws
      .filter((r) => r.conducted_at != null && Date.parse(r.conducted_at) <= asOfMs)
      .map((r) => r.leave_request_id),
  );
  const overdueCutoff = addDays(asOfDay, -3);
  const overdueRtwCount = leave.filter(
    (l) =>
      l.type === "sick" &&
      l.status === "approved" &&
      day(l.end_date) <= overdueCutoff &&
      !completedRtw.has(l.id),
  ).length;

  return {
    denialRate12m: decisions.length > 0 ? denials / decisions.length : 0,
    decisions12m: decisions.length,
    denials12m: denials,
    shortNoticeChanges12m: shortNotice,
    daysSinceLastAnnual,
    overdueRtwCount,
    pulseTrend: null,
  };
}
