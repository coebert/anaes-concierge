/**
 * Pure classifier for leave_requests.status when deciding whether a
 * leave row blocks a trainee's "not yet started" prediction.
 *
 *  - approved / pending → counted (blocks not-yet-started)
 *  - cancelled / denied / reserve / anything else → ignored
 *
 * Extracted so it can be unit-tested without pulling in Supabase / the
 * server runtime.
 */
export function classifyLeaveOverlap(
  status: string | null | undefined,
): {
  counted: boolean;
  reason: string;
} {
  if (status == null) {
    return { counted: false, reason: "Unknown status — ignored" };
  }
  const s = status.toLowerCase();
  if (s === "approved")
    return { counted: true, reason: "Approved — blocks not-yet-started" };
  if (s === "pending")
    return { counted: true, reason: "Pending — blocks not-yet-started" };
  if (s === "cancelled")
    return { counted: false, reason: "Cancelled — ignored" };
  if (s === "denied")
    return { counted: false, reason: "Denied — ignored" };
  if (s === "reserve")
    return { counted: false, reason: "Reserve listed — ignored" };
  return { counted: false, reason: `Status "${status}" — ignored` };
}
