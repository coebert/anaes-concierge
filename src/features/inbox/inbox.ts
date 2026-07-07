/**
 * Coordinator inbox aggregation & prioritisation.
 *
 * Combines four independent to-do streams into a single priority-sorted feed:
 *  1. Pending leave decisions           (leave_requests.status = 'pending')
 *  2. Unacknowledged / overdue exceptions (exception_reports, open)
 *  3. Overdue RTW tasks                 (sick spells past cutoff, no RTW logged)
 *  4. Upcoming training/competency expiries (staff_competencies.expires_at soon)
 *
 * Priority score (higher = more urgent) is chosen so items sort into the
 * order a coordinator would triage them in the morning:
 *   1000+  immediate safety concern (exception, red-flag)
 *    900+  overdue (past SLA / past due date)
 *    700+  short-notice (leave starting within 7 days)
 *    500+  approaching SLA / expiry within 14 days
 *    300+  routine within 60 days
 */

export type InboxItemKind = "leave" | "exception" | "rtw" | "competency";

export interface InboxItem {
  id: string; // "<kind>:<row id>"
  kind: InboxItemKind;
  title: string;
  detail: string;
  staffName: string | null;
  staffId: string | null;
  dueDate: string | null; // ISO date the item is due / effective by
  priority: number;
  severity: "critical" | "warning" | "info";
  href: string; // in-app link the coordinator should follow
}

export interface LeaveInboxRow {
  id: string;
  staff_id: string;
  type: string;
  status: string;
  start_date: string;
  end_date: string;
  created_at: string;
}

export interface ExceptionInboxRow {
  id: string;
  trainee_id: string;
  status: string;
  due_by: string;
  immediate_safety_concern: boolean;
  description: string;
  category: string | null;
}

export interface RtwInboxRow {
  leave_request_id: string;
  staff_id: string;
  spell_start: string;
  spell_end: string;
  daysOverdue: number;
}

export interface CompetencyInboxRow {
  id: string;
  staff_id: string;
  competency_name: string;
  expires_at: string;
}

const MS_PER_DAY = 86_400_000;

function isoToUTC(iso: string): number {
  const [y, m, d] = iso.split("-").map((n) => parseInt(n, 10));
  return Date.UTC(y, m - 1, d);
}

function daysFromToday(iso: string, today: Date): number {
  const t = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  return Math.round((isoToUTC(iso) - t) / MS_PER_DAY);
}

const LEAVE_TYPE_LABEL: Record<string, string> = {
  annual: "Annual leave",
  study: "Study leave",
  sick: "Sick leave",
  parental: "Parental leave",
  professional: "Professional leave",
  other: "Leave",
};

export function buildInbox(
  data: {
    leave: LeaveInboxRow[];
    exceptions: ExceptionInboxRow[];
    rtws: RtwInboxRow[];
    competencies: CompetencyInboxRow[];
    nameById: Map<string, string>;
  },
  referenceDate: Date = new Date(),
): InboxItem[] {
  const items: InboxItem[] = [];
  const today = new Date(Date.UTC(
    referenceDate.getUTCFullYear(),
    referenceDate.getUTCMonth(),
    referenceDate.getUTCDate(),
  ));

  // --- Pending leave decisions -------------------------------------------
  for (const r of data.leave) {
    if (r.status !== "pending") continue;
    const daysUntilStart = daysFromToday(r.start_date, today);
    let priority = 400;
    let severity: InboxItem["severity"] = "info";
    if (daysUntilStart < 0) {
      priority = 950; severity = "critical";
    } else if (daysUntilStart <= 7) {
      priority = 780; severity = "warning";
    } else if (daysUntilStart <= 21) {
      priority = 560; severity = "warning";
    } else if (daysUntilStart <= 42) {
      priority = 420; severity = "info";
    } else {
      priority = 320; severity = "info";
    }
    const label = LEAVE_TYPE_LABEL[r.type] ?? "Leave";
    const staffName = data.nameById.get(r.staff_id) ?? "Unknown staff";
    items.push({
      id: `leave:${r.id}`,
      kind: "leave",
      title: `Approve ${label.toLowerCase()} — ${staffName}`,
      detail: `${r.start_date} → ${r.end_date}${daysUntilStart < 0 ? " (start date has passed)" : daysUntilStart <= 7 ? ` (starts in ${daysUntilStart}d)` : ""}`,
      staffName,
      staffId: r.staff_id,
      dueDate: r.start_date,
      priority,
      severity,
      href: "/coordinator/leave",
    });
  }

  // --- Exception reports --------------------------------------------------
  for (const r of data.exceptions) {
    if (r.status === "resolved" || r.status === "withdrawn") continue;
    const daysUntilDue = daysFromToday(r.due_by, today);
    let priority: number;
    let severity: InboxItem["severity"];
    if (r.immediate_safety_concern) {
      priority = 1100; severity = "critical";
    } else if (daysUntilDue < 0) {
      priority = 960; severity = "critical";
    } else if (daysUntilDue <= 2) {
      priority = 760; severity = "warning";
    } else {
      priority = 520; severity = "info";
    }
    const staffName = data.nameById.get(r.trainee_id) ?? "Unknown trainee";
    items.push({
      id: `exception:${r.id}`,
      kind: "exception",
      title: `${r.immediate_safety_concern ? "SAFETY — " : ""}Respond to exception — ${staffName}`,
      detail: `${r.category ? r.category + " · " : ""}Due ${r.due_by}${daysUntilDue < 0 ? ` (${-daysUntilDue}d overdue)` : daysUntilDue === 0 ? " (today)" : ""}`,
      staffName,
      staffId: r.trainee_id,
      dueDate: r.due_by,
      priority,
      severity,
      href: "/admin/exceptions",
    });
  }

  // --- Overdue RTW --------------------------------------------------------
  for (const r of data.rtws) {
    const staffName = data.nameById.get(r.staff_id) ?? "Unknown staff";
    const priority = 900 + Math.min(80, r.daysOverdue * 4);
    items.push({
      id: `rtw:${r.leave_request_id}`,
      kind: "rtw",
      title: `Return-to-work interview — ${staffName}`,
      detail: `Sick spell ${r.spell_start} → ${r.spell_end} · ${r.daysOverdue} working day${r.daysOverdue === 1 ? "" : "s"} overdue`,
      staffName,
      staffId: r.staff_id,
      dueDate: r.spell_end,
      priority,
      severity: "critical",
      href: "/admin/absence",
    });
  }

  // --- Upcoming competency expiries --------------------------------------
  for (const r of data.competencies) {
    const daysUntil = daysFromToday(r.expires_at, today);
    let priority: number;
    let severity: InboxItem["severity"];
    if (daysUntil < 0) {
      priority = 940; severity = "critical";
    } else if (daysUntil <= 14) {
      priority = 720; severity = "warning";
    } else if (daysUntil <= 60) {
      priority = 340; severity = "info";
    } else {
      continue;
    }
    const staffName = data.nameById.get(r.staff_id) ?? "Unknown staff";
    items.push({
      id: `competency:${r.id}`,
      kind: "competency",
      title: `${r.competency_name} — ${staffName}`,
      detail: daysUntil < 0
        ? `Expired ${r.expires_at} (${-daysUntil}d ago)`
        : `Expires ${r.expires_at} (in ${daysUntil}d)`,
      staffName,
      staffId: r.staff_id,
      dueDate: r.expires_at,
      priority,
      severity,
      href: "/admin/competencies",
    });
  }

  items.sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority;
    const ad = a.dueDate ?? "9999-12-31";
    const bd = b.dueDate ?? "9999-12-31";
    if (ad !== bd) return ad.localeCompare(bd);
    return a.title.localeCompare(b.title);
  });

  return items;
}
