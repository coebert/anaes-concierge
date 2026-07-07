export type ExceptionCategory =
  | "hours"
  | "rest"
  | "education"
  | "service_support"
  | "patient_safety";

export type ExceptionStatus =
  | "submitted"
  | "acknowledged"
  | "under_review"
  | "resolved"
  | "escalated"
  | "withdrawn";

export type ExceptionOutcome =
  | "no_action"
  | "toil"
  | "payment"
  | "work_schedule_review"
  | "immediate_safety_action"
  | "other";

export type SessionHalf = "am" | "pm" | "eve" | "night";

export type ExceptionReport = {
  id: string;
  trainee_id: string;
  event_date: string;
  event_session: SessionHalf | null;
  category: ExceptionCategory;
  immediate_safety_concern: boolean;
  description: string;
  hours_worked_extra: number | null;
  rest_missed_hours: number | null;
  status: ExceptionStatus;
  outcome: ExceptionOutcome | null;
  outcome_note: string | null;
  responder_id: string | null;
  acknowledged_at: string | null;
  resolved_at: string | null;
  due_by: string;
  created_at: string;
  updated_at: string;
};

export const CATEGORY_LABEL: Record<ExceptionCategory, string> = {
  hours: "Hours of work",
  rest: "Rest / breaks",
  education: "Educational opportunities",
  service_support: "Service support / patient care",
  patient_safety: "Patient safety",
};

export const CATEGORY_DESCRIPTION: Record<ExceptionCategory, string> = {
  hours: "Worked beyond rostered hours — extra sessions, overrunning shift, additional on-call.",
  rest: "Natural breaks or minimum rest between shifts not achieved.",
  education: "Missed teaching, training list, study leave, or clinic exposure required by the curriculum.",
  service_support: "Rota gap or workload meant service delivery was compromised.",
  patient_safety: "A situation that put, or could have put, patients at risk.",
};

export const STATUS_LABEL: Record<ExceptionStatus, string> = {
  submitted: "Submitted",
  acknowledged: "Acknowledged",
  under_review: "Under review",
  resolved: "Resolved",
  escalated: "Escalated to Guardian",
  withdrawn: "Withdrawn",
};

export const OUTCOME_LABEL: Record<ExceptionOutcome, string> = {
  no_action: "No further action",
  toil: "Time off in lieu",
  payment: "Payment for additional hours",
  work_schedule_review: "Work schedule review",
  immediate_safety_action: "Immediate safety action taken",
  other: "Other (see note)",
};

/**
 * 2016 TCS Schedule 5: educational supervisor must respond within 7 days of
 * submission. Immediate patient-safety concerns require same-working-day
 * response by the Guardian of Safe Working.
 */
export const RESPONSE_SLA_DAYS = 7;
export const SAFETY_SLA_HOURS = 24;

export function computeDueBy(now: Date, immediateSafety: boolean): Date {
  const ms = immediateSafety
    ? SAFETY_SLA_HOURS * 3_600_000
    : RESPONSE_SLA_DAYS * 86_400_000;
  return new Date(now.getTime() + ms);
}
