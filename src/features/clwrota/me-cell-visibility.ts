/**
 * AM/PM visibility filter for Medical examiner (and SPA/Admin) assignments
 * rendered on the global calendar.
 *
 * A Medical examiner assignment must appear ONLY on the day and half-day
 * (am / pm) it was persisted for. All-day CLWRota rows are split at sync
 * time (see sessionsCoveredByTimeRange) into distinct am/pm rows with
 * `|am` / `|pm` suffixed external ids; this filter is the last-line guard
 * that stops a PM row from leaking into an AM cell or vice versa.
 */
export type SessionHalf = "am" | "pm";

export interface CalendarSpaAdminAssignment {
  duty_type: "spa" | "admin" | "medical_examiner" | "tutorial";
  session_date: string;
  session: SessionHalf;
}

export function filterAssignmentsForCell<T extends CalendarSpaAdminAssignment>(
  assignments: readonly T[] | null | undefined,
  dutyType: T["duty_type"],
  dayIso: string,
  half: SessionHalf,
): T[] {
  return (assignments ?? []).filter(
    (a) =>
      a.duty_type === dutyType &&
      a.session_date === dayIso &&
      a.session === half,
  );
}
