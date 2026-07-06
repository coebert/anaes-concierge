/**
 * Pure helpers for the 14-day "not yet started" leave-overlap window.
 *
 * All date arithmetic is intentionally done in UTC so the window is stable
 * regardless of the server's local timezone (Cloudflare Workers run UTC;
 * developer machines and CI may not). A leave row overlaps the window iff
 *   leave.start_date <= window_end  AND  leave.end_date >= window_start
 * which matches the Supabase query in `getTraineeStartDateAudit`.
 */

export const LEAVE_LOOKAHEAD_DAYS = 14;

/**
 * Return YYYY-MM-DD `days` away from `now`, computed at UTC midnight.
 * Defaults to "now = wall clock" but accepts an explicit instant for tests.
 */
export function isoDateOffsetUTC(days: number, now: Date = new Date()): string {
  const d = new Date(now.getTime());
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export interface LeaveWindow {
  window_start: string;
  window_end: string;
}

/** The [today, today+14] window used by the audit, in UTC. */
export function computeLeaveWindow(now: Date = new Date()): LeaveWindow {
  return {
    window_start: isoDateOffsetUTC(0, now),
    window_end: isoDateOffsetUTC(LEAVE_LOOKAHEAD_DAYS, now),
  };
}

/**
 * Inclusive overlap test between a leave row and the window. Mirrors the
 * Supabase predicate: `start_date <= window_end AND end_date >= window_start`.
 */
export function leaveOverlapsWindow(
  leave: { start_date: string; end_date: string },
  window: LeaveWindow,
): boolean {
  return (
    leave.start_date <= window.window_end &&
    leave.end_date >= window.window_start
  );
}
