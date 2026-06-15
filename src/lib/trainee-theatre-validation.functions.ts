import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { HIGH_UNMATCHED_RATIO } from "./trainee-metrics";
import { isIcuBlockOnly } from "./audit/trainee-audit";

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

export type MismatchLikelyCause =
  | "no_theatre_sessions_on_those_days"
  | "theatre_name_alias_missing"
  | "mixed"
  | "unknown";

export type TraineeTheatreMismatch = {
  staff_id: string;
  full_name: string | null;
  matched: number;
  unmatched: number;
  unmatchedRatio: number;
  reason: "no_matches" | "high_unmatched_ratio";
  /** Diagnostic: of the unmatched rows, how many fall on a date/session that
   *  already has at least one theatre_session row (so the theatre name on the
   *  rota row likely failed to resolve via the alias table) vs. days where no
   *  theatre_session exists at all (off-site / non-theatre work, or the
   *  upstream theatre feed didn't list anything for that slot). */
  unmatchedWithOtherTheatreSessions: number;
  unmatchedWithNoTheatreSession: number;
  likelyCause: MismatchLikelyCause;
  likelyCauseExplanation: string;
};

export type TraineeOnIcuBlock = {
  staff_id: string;
  full_name: string | null;
  /** Theatre rows in the window that didn't link to a theatre_session_id —
   *  surfaced for transparency, but NOT counted as a warning because the
   *  trainee's remaining rotation is ICU-only and no theatre lists are
   *  expected. */
  unmatchedTheatreRows: number;
};

export type ValidateTraineeTheatreMatchesResult = {
  ok: boolean;
  window: { from: string; to: string };
  traineesScanned: number;
  traineesWithTheatreRows: number;
  fullyMatched: number;
  mismatches: TraineeTheatreMismatch[];
  /** Trainees whose remaining rotation is ICU-only. They're excluded from
   *  the mismatch list because they're not expected to have theatre lists. */
  onIcuBlock: TraineeOnIcuBlock[];
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

  // Chunked fetch to stay within Postgrest .in() limits. We keep the full
  // unmatched-row list per trainee so we can diagnose root cause below.
  const matchedByStaff = new Map<string, number>();
  const unmatchedByStaff = new Map<string, number>();
  const unmatchedRowsByStaff = new Map<string, Array<{ session_date: string; session: string }>>();
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
      if (r.theatre_session_id) {
        matchedByStaff.set(r.staff_id, (matchedByStaff.get(r.staff_id) ?? 0) + 1);
      } else {
        unmatchedByStaff.set(r.staff_id, (unmatchedByStaff.get(r.staff_id) ?? 0) + 1);
        const list = unmatchedRowsByStaff.get(r.staff_id) ?? [];
        list.push({ session_date: r.session_date, session: r.session });
        unmatchedRowsByStaff.set(r.staff_id, list);
      }
    }
  }

  // Build the candidate mismatch list first; we only need theatre_session
  // lookups for those trainees' unmatched date/session pairs.
  type Pending = TraineeTheatreMismatch & { _rows: Array<{ session_date: string; session: string }> };
  const pending: Pending[] = [];
  let traineesWithTheatreRows = 0;
  let fullyMatched = 0;
  for (const t of trainees ?? []) {
    const matched = matchedByStaff.get(t.id) ?? 0;
    const unmatched = unmatchedByStaff.get(t.id) ?? 0;
    const total = matched + unmatched;
    if (total === 0) continue;
    traineesWithTheatreRows += 1;
    const ratio = unmatched / total;
    const reason: "no_matches" | "high_unmatched_ratio" | null =
      matched === 0 ? "no_matches" : ratio >= HIGH_UNMATCHED_RATIO ? "high_unmatched_ratio" : null;
    if (!reason) {
      fullyMatched += 1;
      continue;
    }
    pending.push({
      staff_id: t.id,
      full_name: t.full_name,
      matched,
      unmatched,
      unmatchedRatio: ratio,
      reason,
      unmatchedWithOtherTheatreSessions: 0,
      unmatchedWithNoTheatreSession: 0,
      likelyCause: "unknown",
      likelyCauseExplanation: "",
      _rows: unmatchedRowsByStaff.get(t.id) ?? [],
    });
  }

  // For every distinct (date, session) the mismatched trainees touch, check
  // if any theatre_session exists. If yes → the rota row's theatre label
  // couldn't be aliased to that theatre. If no → no theatre listing was
  // imported for that slot at all.
  const allKeys = new Set<string>();
  for (const p of pending) {
    for (const r of p._rows) allKeys.add(`${r.session_date}|${r.session}`);
  }
  const dateSessionHasTheatre = new Map<string, boolean>();
  if (allKeys.size > 0) {
    const distinctDates = Array.from(new Set(Array.from(allKeys).map((k) => k.split("|")[0])));
    const DCHUNK = 500;
    for (let i = 0; i < distinctDates.length; i += DCHUNK) {
      const slice = distinctDates.slice(i, i + DCHUNK);
      const { data: tsRows, error } = await supabaseAdmin
        .from("theatre_sessions")
        .select("session_date, session")
        .in("session_date", slice)
        .range(0, 49999);
      if (error) throw new Error(error.message);
      for (const r of tsRows ?? []) {
        dateSessionHasTheatre.set(`${r.session_date}|${r.session}`, true);
      }
    }
  }

  const mismatches: TraineeTheatreMismatch[] = pending.map((p) => {
    let withOther = 0;
    let withNone = 0;
    for (const r of p._rows) {
      if (dateSessionHasTheatre.get(`${r.session_date}|${r.session}`)) withOther += 1;
      else withNone += 1;
    }
    const total = withOther + withNone;
    let likelyCause: MismatchLikelyCause = "unknown";
    let explanation = "Unable to diagnose — no unmatched rows recorded.";
    if (total > 0) {
      const otherPct = withOther / total;
      if (otherPct >= 0.8) {
        likelyCause = "theatre_name_alias_missing";
        explanation =
          `Theatre sessions exist on ${withOther}/${total} of the unmatched slots — ` +
          `the rota row's theatre label likely isn't aliased to the imported theatre name.`;
      } else if (otherPct <= 0.2) {
        likelyCause = "no_theatre_sessions_on_those_days";
        explanation =
          `No theatre_session was imported for ${withNone}/${total} of the unmatched slots — ` +
          `the trainee is on off-site / non-theatre duty, or the upstream theatre feed has no listing for those days.`;
      } else {
        likelyCause = "mixed";
        explanation =
          `Mixed: ${withOther}/${total} slots have a theatre_session (label mismatch likely), ` +
          `${withNone}/${total} have none (off-site / missing feed entry).`;
      }
    }
    const { _rows, ...rest } = p;
    void _rows;
    return {
      ...rest,
      unmatchedWithOtherTheatreSessions: withOther,
      unmatchedWithNoTheatreSession: withNone,
      likelyCause,
      likelyCauseExplanation: explanation,
    };
  });

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
