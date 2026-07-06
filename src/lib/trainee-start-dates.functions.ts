import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/**
 * Trainee "not yet started" prediction
 * ------------------------------------
 *
 * Trainees who appear in CLWRota but have NOT actually started working at
 * Salisbury show up as active trainees with no rota assignments and no leave
 * in the immediate future. We use that signature to:
 *
 * 1. Detect them (no activity AND no leave in the next 14 days).
 * 2. Predict their start date as the FIRST future rota assignment in CLWRota
 *    (if any exists).
 * 3. Persist that predicted date into `profiles.start_date` so the UI can
 *    badge them as "Not yet started" until the date arrives.
 *
 * The UI then treats any trainee whose `start_date > today` as not yet
 * started — that single rule covers both predicted dates and dates already
 * provided by the staff feed.
 */

const LOOKAHEAD_DAYS = 14;

export type PredictionResult = {
  scanned: number;
  noActivityNoLeave: number;
  updated: Array<{
    id: string;
    full_name: string | null;
    previous_start: string | null;
    predicted_start: string;
  }>;
  notYetStarted: Array<{
    id: string;
    full_name: string | null;
    start_date: string;
  }>;
};

function isoDateOffset(days: number): string {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Internal implementation, callable from the CLWRota sync pipeline without
 * the auth middleware.
 */
export async function predictTraineeStartDatesImpl(): Promise<PredictionResult> {
  const today = isoDateOffset(0);
  const windowEnd = isoDateOffset(LOOKAHEAD_DAYS);

  const { data: trainees, error: tErr } = await supabaseAdmin
    .from("profiles")
    .select("id, full_name, start_date")
    .eq("grade", "trainee")
    .eq("active", true);
  if (tErr) throw new Error(tErr.message);

  const ids = (trainees ?? []).map((t) => t.id);
  if (ids.length === 0) {
    return { scanned: 0, noActivityNoLeave: 0, updated: [], notYetStarted: [] };
  }

  // Activity in window [today, today+14]
  const { data: activityRows, error: aErr } = await supabaseAdmin
    .from("rota_assignments")
    .select("staff_id")
    .in("staff_id", ids)
    .gte("session_date", today)
    .lte("session_date", windowEnd)
    .range(0, 49999);
  if (aErr) throw new Error(aErr.message);
  const hasActivity = new Set((activityRows ?? []).map((r) => r.staff_id));

  // Leave overlapping window (any non-cancelled/non-denied status counts).
  const { data: leaveRows, error: lErr } = await supabaseAdmin
    .from("leave_requests")
    .select("staff_id, start_date, end_date, status")
    .in("staff_id", ids)
    .lte("start_date", windowEnd)
    .gte("end_date", today)
    .range(0, 49999);
  if (lErr) throw new Error(lErr.message);
  const hasLeave = new Set(
    (leaveRows ?? [])
      .filter((r) => r.status === "approved" || r.status === "pending")
      .map((r) => r.staff_id),
  );

  // First future rota assignment per trainee (for prediction).
  const candidates = (trainees ?? []).filter(
    (t) => !hasActivity.has(t.id) && !hasLeave.has(t.id),
  );
  const candidateIds = candidates.map((c) => c.id);

  const futureFirstByStaff = new Map<string, string>();
  if (candidateIds.length) {
    const { data: futureRows, error: fErr } = await supabaseAdmin
      .from("rota_assignments")
      .select("staff_id, session_date")
      .in("staff_id", candidateIds)
      .gt("session_date", today)
      .order("session_date", { ascending: true })
      .range(0, 49999);
    if (fErr) throw new Error(fErr.message);
    for (const r of futureRows ?? []) {
      if (!futureFirstByStaff.has(r.staff_id)) {
        futureFirstByStaff.set(r.staff_id, r.session_date);
      }
    }
  }

  const updated: PredictionResult["updated"] = [];
  for (const t of candidates) {
    const predicted = futureFirstByStaff.get(t.id);
    if (!predicted) continue; // No CLWRota signal — leave start_date alone.
    // Only overwrite when the existing date is missing or clearly stale
    // (in the past). Never overwrite a future-dated start with a different
    // future-dated start, since the staff feed's value is more authoritative.
    const cur = t.start_date;
    const shouldUpdate = !cur || cur <= today;
    if (!shouldUpdate) continue;
    if (cur === predicted) continue;

    const { error: uErr } = await supabaseAdmin
      .from("profiles")
      .update({ start_date: predicted })
      .eq("id", t.id);
    if (uErr) throw new Error(uErr.message);

    updated.push({
      id: t.id,
      full_name: t.full_name,
      previous_start: cur,
      predicted_start: predicted,
    });
  }

  // Refresh start_date for the response's "not yet started" snapshot.
  const startsByStaff = new Map<string, string | null>();
  for (const t of trainees ?? []) startsByStaff.set(t.id, t.start_date);
  for (const u of updated) startsByStaff.set(u.id, u.predicted_start);

  const notYetStarted: PredictionResult["notYetStarted"] = (trainees ?? [])
    .map((t) => ({
      id: t.id,
      full_name: t.full_name as string | null,
      start_date: startsByStaff.get(t.id) ?? null,
    }))
    .filter(
      (t): t is { id: string; full_name: string | null; start_date: string } =>
        typeof t.start_date === "string" && t.start_date > today,
    )
    .sort((a, b) => a.start_date.localeCompare(b.start_date));

  return {
    scanned: trainees?.length ?? 0,
    noActivityNoLeave: candidates.length,
    updated,
    notYetStarted,
  };
}

/** Admin-callable wrapper. */
export const predictTraineeStartDates = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: role } = await context.supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", context.userId)
      .eq("role", "admin")
      .maybeSingle();
    if (!role) throw new Error("Forbidden: admin only.");
    return predictTraineeStartDatesImpl();
  });
