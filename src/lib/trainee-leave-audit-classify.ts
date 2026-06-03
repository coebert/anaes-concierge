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
export function classifyLeaveOverlap(status: string): {
  counted: boolean;
  reason: string;
} {
  if (status === "approved")
    return { counted: true, reason: "Approved — blocks not-yet-started" };
  if (status === "pending")
    return { counted: true, reason: "Pending — blocks not-yet-started" };
  if (status === "cancelled")
    return { counted: false, reason: "Cancelled — ignored" };
  if (status === "denied")
    return { counted: false, reason: "Denied — ignored" };
  if (status === "reserve")
    return { counted: false, reason: "Reserve listed — ignored" };
  return { counted: false, reason: `Status "${status}" — ignored` };
}
