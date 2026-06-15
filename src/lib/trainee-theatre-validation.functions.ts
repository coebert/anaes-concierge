import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { HIGH_UNMATCHED_RATIO } from "./trainee-metrics";

/**
 * Post-sync audit validation
 * --------------------------
 *
 * After Sync Staff / Sync Rota / Sync Leave completes we re-check every
 * ACTIVE trainee to make sure their theatre rows (duty_type='theatre',
 * session in am/pm) actually link to a theatre_session_id. Any trainee with
 * theatre rows but zero matches, or with an unmatched ratio at/above
 * {@link HIGH_UNMATCHED_RATIO}, is reported back so the admin can see at a
 * glance whether the sync repaired the prior gaps or whether some theatre
 * locations are still falling through (e.g. a brand-new CLWRota label that
 * hasn't been mapped yet).
 *
 * The audit is bounded by the same rolling window the rota sync uses
 * (sync_days_back / sync_days_ahead), defaulting to 30 days back / 120 days
 * ahead — matching the trainee audit page.
 */

export type TraineeTheatreMismatch = {
  staff_id: string;
  full_name: string | null;
  matched: number;
  unmatched: number;
  unmatchedRatio: number;
  reason: "no_matches" | "high_unmatched_ratio";
};

export type ValidateTraineeTheatreMatchesResult = {
  ok: boolean;
  window: { from: string; to: string };
  traineesScanned: number;
  traineesWithTheatreRows: number;
  fullyMatched: number;
  mismatches: TraineeTheatreMismatch[];
};

function isoDateOffset(days: number): string {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export async function performTraineeTheatreValidation(
  opts: { from?: string; to?: string } = {},
): Promise<ValidateTraineeTheatreMatchesResult> {
  const { data: settings } = await supabaseAdmin
    .from("clwrota_sync_state")
    .select("sync_days_back, sync_days_ahead")
    .eq("id", 1)
    .maybeSingle();
  const daysBack = settings?.sync_days_back ?? 30;
  const daysAhead = settings?.sync_days_ahead ?? 120;
  const from = opts.from ?? isoDateOffset(-Math.abs(daysBack));
  const to = opts.to ?? isoDateOffset(Math.abs(daysAhead));

  const { data: trainees, error: tErr } = await supabaseAdmin
    .from("profiles")
    .select("id, full_name")
    .eq("grade", "trainee")
    .eq("active", true);
  if (tErr) throw new Error(tErr.message);

  const ids = (trainees ?? []).map((t) => t.id);
  if (ids.length === 0) {
    return {
      ok: true,
      window: { from, to },
      traineesScanned: 0,
      traineesWithTheatreRows: 0,
      fullyMatched: 0,
      mismatches: [],
    };
  }

  // Chunked fetch to stay within Postgrest .in() limits.
  const matchedByStaff = new Map<string, number>();
  const unmatchedByStaff = new Map<string, number>();
  const CHUNK = 200;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK);
    const { data: rows, error } = await supabaseAdmin
      .from("rota_assignments")
      .select("staff_id, theatre_session_id, session, duty_type, session_date")
      .in("staff_id", slice)
      .eq("duty_type", "theatre")
      .in("session", ["am", "pm"])
      .gte("session_date", from)
      .lte("session_date", to)
      .range(0, 49999);
    if (error) throw new Error(error.message);
    for (const r of rows ?? []) {
      const map = r.theatre_session_id ? matchedByStaff : unmatchedByStaff;
      map.set(r.staff_id, (map.get(r.staff_id) ?? 0) + 1);
    }
  }

  const mismatches: TraineeTheatreMismatch[] = [];
  let traineesWithTheatreRows = 0;
  let fullyMatched = 0;
  for (const t of trainees ?? []) {
    const matched = matchedByStaff.get(t.id) ?? 0;
    const unmatched = unmatchedByStaff.get(t.id) ?? 0;
    const total = matched + unmatched;
    if (total === 0) continue;
    traineesWithTheatreRows += 1;
    const ratio = unmatched / total;
    if (matched === 0) {
      mismatches.push({
        staff_id: t.id,
        full_name: t.full_name,
        matched,
        unmatched,
        unmatchedRatio: ratio,
        reason: "no_matches",
      });
    } else if (ratio >= HIGH_UNMATCHED_RATIO) {
      mismatches.push({
        staff_id: t.id,
        full_name: t.full_name,
        matched,
        unmatched,
        unmatchedRatio: ratio,
        reason: "high_unmatched_ratio",
      });
    } else {
      fullyMatched += 1;
    }
  }

  // Sort: worst (no_matches, then highest unmatched count) first.
  mismatches.sort((a, b) => {
    if (a.reason !== b.reason) return a.reason === "no_matches" ? -1 : 1;
    return b.unmatched - a.unmatched;
  });

  return {
    ok: mismatches.length === 0,
    window: { from, to },
    traineesScanned: trainees?.length ?? 0,
    traineesWithTheatreRows,
    fullyMatched,
    mismatches,
  };
}

export const validateTraineeTheatreMatches = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { from?: string; to?: string } | undefined) =>
    z
      .object({
        from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      })
      .parse(input ?? {}),
  )
  .handler(async ({ data }) => performTraineeTheatreValidation(data));
