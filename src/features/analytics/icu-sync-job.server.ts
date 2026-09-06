// Server-only: the daily intensive-care (ICU) feed job.
//
// Each run pulls ONE bounded slice of the CLWRota window, classifies the ICU
// sessions in it and stores the raw source records (`icu_detection_matches`),
// so the ICU feed builds up gradually instead of needing an admin to run a
// large comparison by hand. Progress is persisted in `icu_sync_state`, so the
// next run continues where this one stopped and wraps around at the end of
// the window. One slice per invocation keeps the Worker inside its memory
// budget.

const DAY_MS = 86_400_000;
const DEFAULT_SLICE_DAYS = 3;
// The forward sweep only covers the near horizon so newly published dates are
// re-checked every couple of days; anything further out is picked up by the
// slower full-window rotation.
const FORWARD_HORIZON_DAYS = 60;
const MAX_SLICE_DAYS = 14;
const MAX_SLICES_PER_RUN = 2;
const FAILURE_LIMIT = 5;

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function addDays(isoDate: string, days: number): string {
  return iso(new Date(new Date(`${isoDate}T00:00:00.000Z`).getTime() + days * DAY_MS));
}
function daysBetween(a: string, b: string): number {
  return Math.round(
    (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS,
  );
}

export type IcuSyncJobResult = {
  status: "ran" | "disabled" | "failed";
  message: string;
  slicesProcessed: number;
  windows: { start: string; end: string; sourceCount: number; auditCount: number }[];
  cursor: string | null;
  futureCursor: string | null;
  windowStart: string;
  windowEnd: string;
};

export async function runIcuSyncJob(opts?: {
  maxSlices?: number;
  sliceDays?: number;
}): Promise<IcuSyncJobResult> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

  const stateRes = await supabaseAdmin
    .from("icu_sync_state")
    .select("*")
    .eq("id", 1)
    .maybeSingle();
  if (stateRes.error) throw new Error(stateRes.error.message);
  const state = stateRes.data;
  if (!state) throw new Error("icu_sync_state row missing.");

  const sliceDays = Math.min(
    MAX_SLICE_DAYS,
    Math.max(1, opts?.sliceDays ?? state.slice_days ?? DEFAULT_SLICE_DAYS),
  );
  const maxSlices = Math.min(MAX_SLICES_PER_RUN, Math.max(1, opts?.maxSlices ?? 1));

  const today = iso(new Date());
  const windowStart = addDays(today, -(state.days_back ?? 365));
  const windowEnd = addDays(today, state.days_ahead ?? 60);

  if (!state.enabled) {
    return {
      status: "disabled",
      message: "The daily ICU sync is switched off.",
      slicesProcessed: 0,
      windows: [],
      cursor: state.cursor_start ?? null,
      futureCursor: (state as { future_cursor_start?: string | null }).future_cursor_start ?? null,
      windowStart,
      windowEnd,
    };
  }

  let cursor = state.cursor_start as string | null;
  if (!cursor || cursor < windowStart || cursor > windowEnd) cursor = windowStart;

  // A second, forward-only cursor sweeps today -> windowEnd continuously and
  // wraps back to today. It gets the FIRST slice of every run, so upcoming
  // dates are re-checked as soon as they land on CLWRota instead of waiting
  // for the slow historical rotation to come round.
  const forwardEnd = addDays(today, Math.min(FORWARD_HORIZON_DAYS, state.days_ahead ?? 60));
  let futureCursor = (state as { future_cursor_start?: string | null })
    .future_cursor_start as string | null;
  if (!futureCursor || futureCursor < today || futureCursor > forwardEnd) {
    futureCursor = today;
  }

  const { verifyIcuWindow } = await import("./icu-verify.server");
  const windows: IcuSyncJobResult["windows"] = [];
  let lastError: string | null = null;

  for (let i = 0; i < maxSlices; i++) {
    const forward = i === 0;
    const sliceStart = forward ? futureCursor : cursor;
    const sliceLimit = forward ? forwardEnd : windowEnd;
    const remaining = daysBetween(sliceStart, sliceLimit);
    if (remaining < 0) {
      if (forward) futureCursor = today;
      else cursor = windowStart;
      continue;
    }
    const sliceEnd = addDays(sliceStart, Math.min(sliceDays - 1, remaining));
    const startedAt = Date.now();

    try {
      const result = await verifyIcuWindow({ startIso: sliceStart, endIso: sliceEnd });
      await supabaseAdmin.from("icu_sync_runs").insert({
        window_start: sliceStart,
        window_end: sliceEnd,
        source_count: result.sourceCount,
        audit_count: result.auditCount,
        traces_written: result.sourceCount,
        diverged: result.diverged,
        ok: true,
        duration_ms: Date.now() - startedAt,
      });
      windows.push({
        start: sliceStart,
        end: sliceEnd,
        sourceCount: result.sourceCount,
        auditCount: result.auditCount,
      });
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      await supabaseAdmin.from("icu_sync_runs").insert({
        window_start: sliceStart,
        window_end: sliceEnd,
        ok: false,
        error: lastError,
        duration_ms: Date.now() - startedAt,
      });
      break;
    }

    if (forward) {
      futureCursor = sliceEnd >= forwardEnd ? today : addDays(sliceEnd, 1);
    } else {
      cursor = sliceEnd >= windowEnd ? windowStart : addDays(sliceEnd, 1);
    }
  }

  await supabaseAdmin
    .from("icu_sync_state")
    .update({
      cursor_start: cursor,
      future_cursor_start: futureCursor,
      slice_days: sliceDays,
      last_run_at: new Date().toISOString(),
      last_error: lastError,
      consecutive_failures: lastError ? (state.consecutive_failures ?? 0) + 1 : 0,
      updated_at: new Date().toISOString(),
    })
    .eq("id", 1);


  if (lastError) {
    return {
      status: "failed",
      message:
        (state.consecutive_failures ?? 0) + 1 >= FAILURE_LIMIT
          ? `ICU sync has failed repeatedly: ${lastError}`
          : `ICU sync slice failed: ${lastError}`,
      slicesProcessed: windows.length,
      windows,
      cursor,
      futureCursor,
      windowStart,
      windowEnd,
    };
  }

  return {
    status: "ran",
    message: `Processed ${windows.length} ICU slice${windows.length === 1 ? "" : "s"}.`,
    slicesProcessed: windows.length,
    windows,
    cursor,
    futureCursor,
    windowStart,
    windowEnd,
  };
}
