import type { QueryClient } from "@tanstack/react-query";

/**
 * Invalidate every wellbeing-derived cache. Call after any mutation to
 * leave_requests, return_to_work_interviews, or exception_reports so the
 * admin and personal wellbeing dashboards reflect the change on the next
 * render without waiting for the 10-minute refetch interval or window focus.
 */
export function invalidateWellbeing(qc: QueryClient): void {
  void qc.invalidateQueries({ queryKey: ["admin-wellbeing"] });
  void qc.invalidateQueries({ queryKey: ["my-wellbeing"] });
}
