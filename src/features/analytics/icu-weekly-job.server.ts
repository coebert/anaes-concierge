// Server-only: the weekly intensive-care (ICU) backfill + audit job.
//
// A "pass" walks a 12-month horizon in bounded slices. Each invocation
// re-downloads the CLWRota report for one slice, re-scans it for ICU
// sessions (refreshing the stored source traces), compares the source count
// against the ICU audit's own rows and raises an alert row whenever the two
// diverge. Progress is persisted so the next invocation resumes rather than
// repeating work; a DB lease prevents overlapping runs and repeated failures
// pause the job until an admin resumes it.
//
// One CLWRota download per invocation keeps the Worker inside its memory
// budget — the same constraint that governs the daily ICU feed sync.

const DAY_MS = 86_400_000;
const DEFAULT_SLICE_DAYS = 14;
const MAX_SLICE_DAYS = 28;
const MAX_SLICES_PER_RUN = 1;
const LEASE_MINUTES = 20;
const FAILURE_LIMIT = 3;
const PASS_INTERVAL_DAYS = 7;
const HORIZON_DAYS = 365;

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function addDays(isoDate: string, days: number): string {
  return iso(new Date(new Date(`${isoDate}T00:00:00.000Z`).getTime() + days * DAY_MS));
}

export type IcuWeeklyJobResult = {
  status: "ran" | "idle" | "paused" | "locked" | "disabled" | "failed";
  message: string;
  slicesProcessed: number;
  divergences: number;
  cursor: string | null;
  horizon: string | null;
  nextPassAt: string | null;
};

export async function runIcuWeeklyAuditJob(opts?: {
  maxSlices?: number;
  sliceDays?: number;
  force?: boolean;
}): Promise<IcuWeeklyJobResult> {
  const maxSlices = Math.min(MAX_SLICES_PER_RUN, Math.max(1, opts?.maxSlices ?? 1));
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

  const stateRes = await supabaseAdmin
    .from("icu_audit_job_state")
    .select("*")
    .eq("id", 1)
    .maybeSingle();
  if (stateRes.error) throw new Error(stateRes.error.message);
  const state = stateRes.data;
  if (!state) throw new Error("icu_audit_job_state row missing.");

  const sliceDays = Math.min(
    MAX_SLICE_DAYS,
    Math.max(7, opts?.sliceDays ?? state.slice_days ?? DEFAULT_SLICE_DAYS),
  );

  const now = new Date();
  const base = {
    slicesProcessed: 0,
    divergences: 0,
    cursor: (state.cursor_start as string | null) ?? null,
    horizon: (state.horizon_end as string | null) ?? null,
    nextPassAt: (state.next_pass_at as string | null) ?? null,
  };

  if (!state.enabled) {
    return { ...base, status: "disabled", message: "Weekly ICU audit is switched off." };
  }
  if (state.paused && !opts?.force) {
    return {
      ...base,
      status: "paused",
      message: `Paused: ${state.paused_reason ?? "unknown reason"}. Resume from the ICU dashboard.`,
    };
  }

  // Single-flight lease: a second invocation while one is running exits early.
  const leaseUntil = new Date(now.getTime() + LEASE_MINUTES * 60_000).toISOString();
  const claim = await supabaseAdmin
    .from("icu_audit_job_state")
    .update({ lease_until: leaseUntil })
    .eq("id", 1)
    .or(`lease_until.is.null,lease_until.lt.${now.toISOString()}`)
    .select("id");
  if (claim.error) throw new Error(claim.error.message);
  if (!claim.data || claim.data.length === 0) {
    return { ...base, status: "locked", message: "Another ICU audit run is in progress." };
  }

  try {
    let cursor = state.cursor_start as string | null;
    let horizon = state.horizon_end as string | null;
    const nextPassAt = state.next_pass_at ? new Date(state.next_pass_at as string) : now;

    if (!cursor || !horizon) {
      if (!opts?.force && now < nextPassAt) {
        await supabaseAdmin
          .from("icu_audit_job_state")
          .update({ lease_until: null, last_run_at: now.toISOString() })
          .eq("id", 1);
        return {
          ...base,
          status: "idle",
          message: `Next weekly ICU pass due ${nextPassAt.toISOString()}.`,
        };
      }
      // Cover the past six months and the next six, so appraisal periods
      // already worked are re-checked as well as the rota ahead.
      cursor = addDays(iso(now), -HORIZON_DAYS / 2);
      horizon = addDays(cursor, HORIZON_DAYS);
      await supabaseAdmin
        .from("icu_audit_job_state")
        .update({
          cursor_start: cursor,
          horizon_end: horizon,
          slice_days: sliceDays,
          pass_started_at: now.toISOString(),
          next_pass_at: new Date(now.getTime() + PASS_INTERVAL_DAYS * DAY_MS).toISOString(),
        })
        .eq("id", 1);
    }

    const { verifyIcuWindow } = await import("./icu-verify.server");
    let slicesProcessed = 0;
    let divergences = 0;

    while (slicesProcessed < maxSlices && cursor <= horizon) {
      const sliceStart = cursor;
      const naturalEnd = addDays(sliceStart, sliceDays - 1);
      const sliceEnd = naturalEnd > horizon ? horizon : naturalEnd;
      const startedAt = Date.now();

      // Re-downloads CLWRota for the slice, re-classifies ICU sessions and
      // refreshes the stored source traces.
      const verify = await verifyIcuWindow({ startIso: sliceStart, endIso: sliceEnd });

      const runInsert = await supabaseAdmin
        .from("icu_sync_runs")
        .insert({
          window_start: sliceStart,
          window_end: sliceEnd,
          source_count: verify.sourceCount,
          audit_count: verify.auditCount,
          traces_written: verify.sourceCount,
          diverged: verify.diverged,
          ok: true,
          duration_ms: Date.now() - startedAt,
        })
        .select("id")
        .single();
      if (runInsert.error) throw new Error(runInsert.error.message);

      if (verify.diverged) {
        divergences += 1;
        const alertInsert = await supabaseAdmin.from("icu_audit_alerts").insert({
          run_id: runInsert.data.id,
          window_start: sliceStart,
          window_end: sliceEnd,
          source_count: verify.sourceCount,
          audit_count: verify.auditCount,
          details: {
            missingFromAudit: verify.missingFromAudit,
            extraInAudit: verify.extraInAudit,
            byStaff: verify.byStaff.filter((r) => r.diff !== 0),
          },
        });
        if (alertInsert.error) throw new Error(alertInsert.error.message);
      }

      // Idempotent progress: persist the cursor after each completed slice.
      cursor = addDays(sliceEnd, 1);
      slicesProcessed += 1;
      const passComplete = cursor > horizon;
      await supabaseAdmin
        .from("icu_audit_job_state")
        .update({
          cursor_start: passComplete ? null : cursor,
          horizon_end: passComplete ? null : horizon,
          last_run_at: new Date().toISOString(),
          last_error: null,
          consecutive_failures: 0,
        })
        .eq("id", 1);
    }

    const passComplete = cursor > horizon;
    await supabaseAdmin
      .from("icu_audit_job_state")
      .update({ lease_until: null, last_run_at: new Date().toISOString() })
      .eq("id", 1);

    return {
      status: "ran",
      message: passComplete
        ? `Weekly ICU pass complete. ${divergences} window(s) diverged.`
        : `Checked ${slicesProcessed} window(s); pass continues from ${cursor}.`,
      slicesProcessed,
      divergences,
      cursor: passComplete ? null : cursor,
      horizon: passComplete ? null : horizon,
      nextPassAt: base.nextPassAt,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const failures = (state.consecutive_failures ?? 0) + 1;
    await supabaseAdmin
      .from("icu_audit_job_state")
      .update({
        lease_until: null,
        last_error: message,
        last_run_at: new Date().toISOString(),
        consecutive_failures: failures,
        paused: failures >= FAILURE_LIMIT,
        paused_reason:
          failures >= FAILURE_LIMIT
            ? `${failures} consecutive failures. Last error: ${message}`
            : null,
      })
      .eq("id", 1);
    return { ...base, status: "failed", message };
  }
}
