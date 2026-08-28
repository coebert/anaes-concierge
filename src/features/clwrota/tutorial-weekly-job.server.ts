import { runTutorialBackfill } from "./tutorial-backfill.server";
import { verifyTutorialWindow } from "./tutorial-verify.server";

/**
 * Weekly tutorial-delivery backfill + audit verification.
 *
 * A "pass" walks a 12-month horizon in bounded slices. Each cron invocation
 * processes at most `maxSlices` slices, so a Worker invocation always ends.
 * Progress is persisted (`cursor_start`), so a re-run resumes rather than
 * repeating work. A DB lease prevents two invocations running in parallel,
 * and repeated failures pause the job until an admin resumes it.
 */

const DAY_MS = 86_400_000;
const DEFAULT_SLICE_DAYS = 28;
const DEFAULT_MAX_SLICES = 1;
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

export type WeeklyTutorialJobResult = {
  status: "ran" | "idle" | "paused" | "locked" | "disabled" | "failed";
  message: string;
  slicesProcessed: number;
  divergences: number;
  cursor: string | null;
  horizon: string | null;
  nextPassAt: string | null;
};

export async function runWeeklyTutorialAuditJob(opts?: {
  maxSlices?: number;
  sliceDays?: number;
  force?: boolean;
}): Promise<WeeklyTutorialJobResult> {
  const maxSlices = Math.min(2, Math.max(1, opts?.maxSlices ?? DEFAULT_MAX_SLICES));
  const sliceDays = Math.min(90, Math.max(7, opts?.sliceDays ?? DEFAULT_SLICE_DAYS));
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

  const stateRes = await supabaseAdmin
    .from("tutorial_audit_job_state")
    .select("*")
    .eq("id", 1)
    .maybeSingle();
  if (stateRes.error) throw new Error(stateRes.error.message);
  const state = stateRes.data;
  if (!state) throw new Error("tutorial_audit_job_state row missing.");

  const now = new Date();
  const base = {
    slicesProcessed: 0,
    divergences: 0,
    cursor: (state.cursor_start as string | null) ?? null,
    horizon: (state.horizon_end as string | null) ?? null,
    nextPassAt: (state.next_pass_at as string | null) ?? null,
  };

  if (!state.enabled) {
    return { ...base, status: "disabled", message: "Weekly tutorial audit is disabled." };
  }
  if (state.paused && !opts?.force) {
    return {
      ...base,
      status: "paused",
      message: `Paused: ${state.paused_reason ?? "unknown reason"}. Resume from the tutorials audit page.`,
    };
  }

  // Single-flight lease.
  const leaseUntil = new Date(now.getTime() + LEASE_MINUTES * 60_000).toISOString();
  const claim = await supabaseAdmin
    .from("tutorial_audit_job_state")
    .update({ lease_until: leaseUntil })
    .eq("id", 1)
    .or(`lease_until.is.null,lease_until.lt.${now.toISOString()}`)
    .select("id");
  if (claim.error) throw new Error(claim.error.message);
  if (!claim.data || claim.data.length === 0) {
    return { ...base, status: "locked", message: "Another tutorial audit run is in progress." };
  }

  try {
    let cursor = state.cursor_start as string | null;
    let horizon = state.horizon_end as string | null;
    const nextPassAt = state.next_pass_at ? new Date(state.next_pass_at as string) : now;

    if (!cursor || !horizon) {
      if (!opts?.force && now < nextPassAt) {
        await supabaseAdmin
          .from("tutorial_audit_job_state")
          .update({ lease_until: null, last_run_at: now.toISOString() })
          .eq("id", 1);
        return {
          ...base,
          status: "idle",
          message: `Next weekly pass due ${nextPassAt.toISOString()}.`,
        };
      }
      cursor = iso(now);
      horizon = addDays(cursor, HORIZON_DAYS);
      await supabaseAdmin
        .from("tutorial_audit_job_state")
        .update({
          cursor_start: cursor,
          horizon_end: horizon,
          pass_started_at: now.toISOString(),
          next_pass_at: new Date(now.getTime() + PASS_INTERVAL_DAYS * DAY_MS).toISOString(),
        })
        .eq("id", 1);
    }

    let slicesProcessed = 0;
    let divergences = 0;

    while (slicesProcessed < maxSlices && cursor <= horizon) {
      const sliceStart = cursor;
      const sliceEnd = addDays(sliceStart, sliceDays - 1) > horizon
        ? horizon
        : addDays(sliceStart, sliceDays - 1);

      const backfill = await runTutorialBackfill({
        startIso: sliceStart,
        endIso: sliceEnd,
        // One upstream CLWRota fetch per slice — nesting the backfill's own
        // multi-slice refresh inside this loop is what blew the Worker
        // memory budget (maxSlices x refresh slices full payloads).
        sliceDays,
        maxSlices: 1,
      });
      const verify = await verifyTutorialWindow({
        startIso: sliceStart,
        endIso: sliceEnd,
      });

      const runInsert = await supabaseAdmin
        .from("tutorial_audit_runs")
        .insert({
          window_start: sliceStart,
          window_end: sliceEnd,
          source_count: verify.sourceCount,
          audit_count: verify.auditCount,
          promoted_to_teaching: backfill.promotedToTeaching,
          notes_updated: backfill.notesUpdated,
          diverged: verify.diverged,
          ok: true,
          details: {
            missingFromAudit: verify.missingFromAudit,
            extraInAudit: verify.extraInAudit,
            sourceRowsRefreshed: backfill.sourceRowsRefreshed,
          },
        })
        .select("id")
        .single();
      if (runInsert.error) throw new Error(runInsert.error.message);

      if (verify.diverged) {
        divergences += 1;
        const alertInsert = await supabaseAdmin.from("tutorial_audit_alerts").insert({
          run_id: runInsert.data.id,
          window_start: sliceStart,
          window_end: sliceEnd,
          source_count: verify.sourceCount,
          audit_count: verify.auditCount,
          details: {
            missingFromAudit: verify.missingFromAudit,
            extraInAudit: verify.extraInAudit,
          },
        });
        if (alertInsert.error) throw new Error(alertInsert.error.message);
      }

      // Idempotent progress: persist the cursor after each completed slice.
      cursor = addDays(sliceEnd, 1);
      slicesProcessed += 1;
      await supabaseAdmin
        .from("tutorial_audit_job_state")
        .update({
          cursor_start: cursor > horizon ? null : cursor,
          horizon_end: cursor > horizon ? null : horizon,
          last_run_at: new Date().toISOString(),
          last_error: null,
          consecutive_failures: 0,
        })
        .eq("id", 1);
    }

    const passComplete = cursor > horizon;
    await supabaseAdmin
      .from("tutorial_audit_job_state")
      .update({ lease_until: null, last_run_at: new Date().toISOString() })
      .eq("id", 1);

    return {
      status: "ran",
      message: passComplete
        ? `Weekly pass complete. ${divergences} window(s) diverged.`
        : `Processed ${slicesProcessed} window(s); pass continues from ${cursor}.`,
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
      .from("tutorial_audit_job_state")
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
    return {
      ...base,
      status: "failed",
      message,
    };
  }
}
