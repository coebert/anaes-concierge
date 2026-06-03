import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { classifyLeaveOverlap } from "./trainee-leave-audit-classify";
import { isoDateOffsetUTC, LEAVE_LOOKAHEAD_DAYS } from "./trainee-leave-audit-window";

/**
 * Verification view for the "not yet started" decision.
 *
 * For every active trainee this returns:
 *   - The 14-day window used by the predictor (today .. today+14).
 *   - Every leave_request row overlapping the window, including status.
 *   - Per-row classification: `counted` (approved/pending — blocks
 *     "not yet started") or `ignored` (cancelled / denied / other — does NOT
 *     block). Each ignored row carries a short reason.
 *   - Whether the trainee has any in-window rota activity.
 *   - The final decision: `has_activity`, `has_counted_leave`,
 *     `not_yet_started`, or `no_signal` (no activity, no leave, no future
 *     rota row yet — kept active with no prediction).
 *
 * This mirrors exactly the logic in `predictTraineeStartDatesImpl` so the
 * UI can audit every decision the sync made.
 */

const LOOKAHEAD_DAYS = 14;

export type AuditLeaveRow = {
  id: string;
  start_date: string;
  end_date: string;
  status: string;
  type: string;
  reason: string | null;
  counted: boolean;
  classification_reason: string;
};

export type AuditTrainee = {
  id: string;
  full_name: string | null;
  email: string;
  start_date: string | null;
  decision:
    | "has_activity"
    | "has_counted_leave"
    | "not_yet_started"
    | "no_signal";
  has_activity: boolean;
  activity_count: number;
  predicted_start: string | null;
  leave_rows: AuditLeaveRow[];
};

export type AuditResult = {
  window_start: string;
  window_end: string;
  trainees: AuditTrainee[];
};

import { isoDateOffsetUTC, LEAVE_LOOKAHEAD_DAYS as _LOOKAHEAD } from "./trainee-leave-audit-window";
const isoDateOffset = (days: number) => isoDateOffsetUTC(days);
void _LOOKAHEAD;




export const getTraineeStartDateAudit = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<AuditResult> => {
    const { data: role } = await context.supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", context.userId)
      .eq("role", "admin")
      .maybeSingle();
    if (!role) throw new Error("Forbidden: admin only.");

    const today = isoDateOffset(0);
    const windowEnd = isoDateOffset(LOOKAHEAD_DAYS);

    const { data: trainees, error: tErr } = await supabaseAdmin
      .from("profiles")
      .select("id, full_name, email, start_date")
      .eq("grade", "trainee")
      .eq("active", true);
    if (tErr) throw new Error(tErr.message);
    const ids = (trainees ?? []).map((t) => t.id);
    if (ids.length === 0) {
      return { window_start: today, window_end: windowEnd, trainees: [] };
    }

    const { data: activityRows, error: aErr } = await supabaseAdmin
      .from("rota_assignments")
      .select("staff_id")
      .in("staff_id", ids)
      .gte("session_date", today)
      .lte("session_date", windowEnd)
      .range(0, 49999);
    if (aErr) throw new Error(aErr.message);
    const activityCount = new Map<string, number>();
    for (const r of activityRows ?? []) {
      activityCount.set(r.staff_id, (activityCount.get(r.staff_id) ?? 0) + 1);
    }

    const { data: leaveRows, error: lErr } = await supabaseAdmin
      .from("leave_requests")
      .select("id, staff_id, start_date, end_date, status, type, reason")
      .in("staff_id", ids)
      .lte("start_date", windowEnd)
      .gte("end_date", today)
      .range(0, 49999);
    if (lErr) throw new Error(lErr.message);
    const leaveByStaff = new Map<string, AuditLeaveRow[]>();
    for (const r of leaveRows ?? []) {
      const { counted, reason } = classifyLeaveOverlap(r.status);
      const row: AuditLeaveRow = {
        id: r.id,
        start_date: r.start_date,
        end_date: r.end_date,
        status: r.status,
        type: r.type as string,
        reason: r.reason ?? null,
        counted,
        classification_reason: reason,
      };
      const arr = leaveByStaff.get(r.staff_id) ?? [];
      arr.push(row);
      leaveByStaff.set(r.staff_id, arr);
    }

    // Future first assignment for "no activity & no counted leave" trainees.
    const { data: futureRows, error: fErr } = await supabaseAdmin
      .from("rota_assignments")
      .select("staff_id, session_date")
      .in("staff_id", ids)
      .gt("session_date", today)
      .order("session_date", { ascending: true })
      .range(0, 49999);
    if (fErr) throw new Error(fErr.message);
    const firstFuture = new Map<string, string>();
    for (const r of futureRows ?? []) {
      if (!firstFuture.has(r.staff_id))
        firstFuture.set(r.staff_id, r.session_date);
    }

    const out: AuditTrainee[] = (trainees ?? []).map((t) => {
      const aCount = activityCount.get(t.id) ?? 0;
      const has_activity = aCount > 0;
      const leave = leaveByStaff.get(t.id) ?? [];
      const has_counted_leave = leave.some((l) => l.counted);
      const predicted = firstFuture.get(t.id) ?? null;
      let decision: AuditTrainee["decision"];
      if (has_activity) decision = "has_activity";
      else if (has_counted_leave) decision = "has_counted_leave";
      else if (predicted) decision = "not_yet_started";
      else decision = "no_signal";
      return {
        id: t.id,
        full_name: t.full_name as string | null,
        email: t.email,
        start_date: t.start_date,
        decision,
        has_activity,
        activity_count: aCount,
        predicted_start: predicted,
        leave_rows: leave.sort((a, b) =>
          a.start_date.localeCompare(b.start_date),
        ),
      };
    });

    out.sort((a, b) => {
      const order = {
        not_yet_started: 0,
        has_counted_leave: 1,
        no_signal: 2,
        has_activity: 3,
      } as const;
      const d = order[a.decision] - order[b.decision];
      if (d !== 0) return d;
      return (a.full_name ?? a.email).localeCompare(b.full_name ?? b.email);
    });

    return { window_start: today, window_end: windowEnd, trainees: out };
  });
