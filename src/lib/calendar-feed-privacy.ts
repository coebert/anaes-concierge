/**
 * Least-disclosure labels for leave in the external iCal feed. Calendar apps
 * sync to phones, shared family calendars and lock screens, so health- or
 * family-related leave types are shown only as a generic "Leave".
 */
const DISCLOSABLE: Record<string, string> = {
  annual: "Annual Leave",
  study: "Study Leave",
  professional: "Professional Leave",
  toil: "TOIL",
};

export function calendarLeaveLabel(type: string | null | undefined): string {
  return `${DISCLOSABLE[String(type ?? "")] ?? "Leave"} (approved)`;
}
