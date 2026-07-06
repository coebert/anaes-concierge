import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { classifyLeaveOverlap } from "./trainee-leave-audit-classify";
import { isoDateOffsetUTC, LEAVE_LOOKAHEAD_DAYS } from "./trainee-leave-audit-window";
import { compareBySurnameAsc } from "@/lib/utils";
import { isIcuBlockOnly } from "@/lib/audit/trainee-audit";

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

const LOOKAHEAD_DAYS = LEAVE_LOOKAHEAD_DAYS;

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
  /**
   * Per-trainee warnings explaining why leave logic for this person may be
   * incomplete (e.g. no CLWRota link so CLWRota-side leave can't be mapped,
   * or no leave_allowances row for the current year).
   */
  leave_source_warnings: string[];
  /** True when every remaining clinical day in this trainee's rotation is
   *  an ICU shift — no theatre lists are expected for them. */
  icu_block_only: boolean;
};

export type LeaveSourceStatus = {
  /** True when admins have configured a CLWRota leave report URL. */
  clwrota_leave_url_configured: boolean;
  /** Last CLWRota sync timestamp (any kind) or null if never run. */
  clwrota_last_sync_at: string | null;
  /** Status of the most recent CLWRota sync. */
  clwrota_last_status: string | null;
  /** Last CLWRota sync error message, if any. */
  clwrota_last_error: string | null;
  /**
   * Global warnings about the leave-data pipeline. Surface these so the
   * admin knows why some trainees may be missing leave entries.
   */
  warnings: string[];
};

export type AuditResult = {
  window_start: string;
  window_end: string;
  trainees: AuditTrainee[];
  leave_sources: LeaveSourceStatus;
};

const isoDateOffset = (days: number) => isoDateOffsetUTC(days);




export const getTraineeStartDateAudit = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<AuditResult> => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: role } = await context.supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", context.userId)
      .eq("role", "admin")
      .maybeSingle();
    if (!role) throw new Error("Forbidden: admin only.");

    const today = isoDateOffset(0);
    const windowEnd = isoDateOffset(LOOKAHEAD_DAYS);

    // --- Leave-source pipeline health ------------------------------------
    // Pull CLWRota sync state so we can warn when the upstream leave feed
    // is missing or unhealthy. We tolerate any error here — a degraded
    // sync_state read should not break the audit.
    const { data: syncState } = await supabaseAdmin
      .from("clwrota_sync_state")
      .select("leave_report_url, last_sync_at, last_status, last_error")
      .eq("id", 1)
      .maybeSingle();
    const leave_sources: LeaveSourceStatus = {
      clwrota_leave_url_configured: !!syncState?.leave_report_url,
      clwrota_last_sync_at: syncState?.last_sync_at ?? null,
      clwrota_last_status: syncState?.last_status ?? null,
      clwrota_last_error: syncState?.last_error ?? null,
      warnings: [],
    };
    if (!leave_sources.clwrota_leave_url_configured) {
      leave_sources.warnings.push(
        "CLWRota leave report URL is not configured — only locally-entered leave is being considered.",
      );
    }
    if (leave_sources.clwrota_last_status && leave_sources.clwrota_last_status !== "ok") {
      leave_sources.warnings.push(
        `Last CLWRota sync did not succeed (status: ${leave_sources.clwrota_last_status}). Leave data may be stale.`,
      );
    }
    if (leave_sources.clwrota_last_sync_at) {
      const ageMs = Date.now() - new Date(leave_sources.clwrota_last_sync_at).getTime();
      if (ageMs > 24 * 60 * 60 * 1000) {
        leave_sources.warnings.push(
          "Last CLWRota sync is over 24 hours old. Leave data may be stale.",
        );
      }
    } else if (leave_sources.clwrota_leave_url_configured) {
      leave_sources.warnings.push(
        "CLWRota sync has never run — no upstream leave has been imported yet.",
      );
    }

    const { data: trainees, error: tErr } = await supabaseAdmin
      .from("profiles")
      .select("id, full_name, email, start_date, clwrota_external_id, rotation_end_date")
      .eq("grade", "trainee")
      .eq("active", true);
    if (tErr) throw new Error(tErr.message);
    const ids = (trainees ?? []).map((t) => t.id);
    if (ids.length === 0) {
      return {
        window_start: today,
        window_end: windowEnd,
        trainees: [],
        leave_sources,
      };
    }

    // Current leave-year allowance coverage. Trainees without a row have
    // no recorded entitlement, so day-counting against an allowance can't
    // be done — flag them so the admin knows.
    const { data: allowanceRows } = await supabaseAdmin
      .from("leave_allowances")
      .select("staff_id, leave_year_start")
      .in("staff_id", ids);
    const allowanceByStaff = new Set<string>(
      (allowanceRows ?? []).map((r) => r.staff_id),
    );

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
    // Also drives ICU-block detection — pull duty_type so we can decide
    // whether the trainee's remaining rotation is ICU-only.
    const { data: futureRows, error: fErr } = await supabaseAdmin
      .from("rota_assignments")
      .select("staff_id, session_date, duty_type")
      .in("staff_id", ids)
      .gt("session_date", today)
      .order("session_date", { ascending: true })
      .range(0, 49999);
    if (fErr) throw new Error(fErr.message);
    const firstFuture = new Map<string, string>();
    const futureByStaff = new Map<
      string,
      Array<{ duty_type: string | null; session_date: string }>
    >();
    for (const r of futureRows ?? []) {
      if (!firstFuture.has(r.staff_id))
        firstFuture.set(r.staff_id, r.session_date);
      const list = futureByStaff.get(r.staff_id) ?? [];
      list.push({ duty_type: r.duty_type, session_date: r.session_date });
      futureByStaff.set(r.staff_id, list);
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
      const warnings: string[] = [];
      if (!t.clwrota_external_id) {
        warnings.push(
          "No CLWRota link on profile — CLWRota leave cannot be mapped to this trainee.",
        );
      }
      if (!allowanceByStaff.has(t.id)) {
        warnings.push(
          "No leave_allowances row — entitlement is unknown, day-count audits will be incomplete.",
        );
      }
      const icu_block_only = isIcuBlockOnly(
        futureByStaff.get(t.id) ?? [],
        today,
        (t as { rotation_end_date?: string | null }).rotation_end_date ?? null,
      );
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
        leave_source_warnings: warnings,
        icu_block_only,
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
      return compareBySurnameAsc(a.full_name ?? a.email, b.full_name ?? b.email);
    });

    return { window_start: today, window_end: windowEnd, trainees: out, leave_sources };
  });
