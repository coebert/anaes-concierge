/**
 * Server side of "My practice summary". The caller is identified ONLY from
 * the verified session (requireActiveMember → context.userId); there is no
 * staff parameter, so nobody can ask for another clinician's summary. Reads
 * run as the caller (RLS applies) and only aggregates are returned.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { requireActiveMember } from "@/lib/require-admin";
import { fetchAllRowsPaged } from "@/features/audit/paginate";
import { buildWeekStatusTimeline, loadWeekStatus } from "@/features/audit/rota-week-status";
import {
  buildImportCoverageTimeline,
  loadImportCoverage,
} from "@/features/audit/rota-sync-coverage";
import {
  buildPracticeSummary,
  isValidRange,
  MAX_RANGE_DAYS,
  type ListInfo,
  type PracticeRow,
  type PracticeSummary,
  type WeekImport,
  type WeekPublication,
} from "./practice-summary";

const ID_CHUNK = 200;

type Db = SupabaseClient<Database>;

export interface PracticeSummaryResult {
  summary: PracticeSummary;
  clinician: { name: string | null; grade: string | null };
  rules: { sessions_per_pa: number; oncall_pa_credit: number; weekend_pa_credit: number };
  weekStatusInstalled: boolean;
  importTrackingInstalled: boolean;
  importTrackingSince: string | null;
  generatedAt: string;
}

export async function loadPracticeSummary(
  db: Db,
  userId: string,
  from: string,
  to: string,
  now: Date = new Date(),
): Promise<PracticeSummaryResult> {
  if (!isValidRange(from, to))
    throw new Error(
      `Choose a start date on or before the end date, at most ${MAX_RANGE_DAYS} days apart.`,
    );
  if (!/^[0-9a-f-]{36}$/i.test(userId)) throw new Error("Forbidden");

  const rulesRes = await db
    .from("rota_rules")
    .select("sessions_per_pa,oncall_pa_credit,weekend_pa_credit")
    .limit(1)
    .maybeSingle();
  // Never substitute default PA rates when the settings read fails.
  if (rulesRes.error) throw new Error(`PA settings could not be loaded: ${rulesRes.error.message}`);
  const rules = {
    sessions_per_pa: Number(rulesRes.data?.sessions_per_pa ?? 1),
    oncall_pa_credit: Number(rulesRes.data?.oncall_pa_credit ?? 1.5),
    weekend_pa_credit: Number(rulesRes.data?.weekend_pa_credit ?? 3),
  };

  const profRes = await db
    .from("profiles")
    .select("full_name,grade")
    .eq("id", userId)
    .maybeSingle();
  if (profRes.error) throw new Error(`Your profile could not be loaded: ${profRes.error.message}`);

  const rows = await fetchAllRowsPaged<PracticeRow>(
    (a, b) =>
      db
        .from("rota_assignments")
        .select(
          "id,staff_id,session_date,session,duty_type,extra_type,pa_credit,attending_consultant_ids,theatre_session_id,source,locally_modified,clwrota_external_id",
        )
        .gte("session_date", from)
        .lte("session_date", to)
        .or(`staff_id.eq.${userId},attending_consultant_ids.cs.{${userId}}`)
        .order("id", { ascending: true })
        .range(a, b) as unknown as PromiseLike<{ data: PracticeRow[] | null; error: unknown }>,
    { rowKey: (r) => r.id, label: "practice-summary.rota_assignments" },
  );

  const listIds = [
    ...new Set(rows.map((r) => r.theatre_session_id).filter((v): v is string => !!v)),
  ].sort();
  const lists = new Map<string, ListInfo>();
  for (let i = 0; i < listIds.length; i += ID_CHUNK) {
    const ids = listIds.slice(i, i + ID_CHUNK);
    type ListRow = {
      id: string;
      specialties: { name: string } | { name: string }[] | null;
      theatres: { name: string } | { name: string }[] | null;
    };
    const page = await fetchAllRowsPaged<ListRow>(
      (a, b) =>
        db
          .from("theatre_sessions")
          .select("id,specialties(name),theatres(name)")
          .in("id", ids)
          .order("id", { ascending: true })
          .range(a, b) as unknown as PromiseLike<{ data: ListRow[] | null; error: unknown }>,
      { rowKey: (r) => r.id, label: "practice-summary.theatre_sessions" },
    );
    for (const s of page) {
      const sp = Array.isArray(s.specialties) ? s.specialties[0] : s.specialties;
      const th = Array.isArray(s.theatres) ? s.theatres[0] : s.theatres;
      lists.set(s.id, { specialty: sp?.name ?? null, location: th?.name ?? null });
    }
  }

  const ws = await loadWeekStatus(from, to, db);
  const wsTimeline = buildWeekStatusTimeline({
    rangeStart: from,
    rangeEnd: to,
    rows: ws.rows,
    capture: ws.capture,
    now,
  });
  const weekPublication = new Map<string, WeekPublication>(
    wsTimeline.weeks.map((w) => [w.weekStart, w.status as WeekPublication]),
  );
  const ic = await loadImportCoverage(from, to, db);
  const icTimeline = buildImportCoverageTimeline({
    rangeStart: from,
    rangeEnd: to,
    rows: ic.rows,
    capture: ic.capture,
    now,
  });
  const weekImport = new Map<string, WeekImport>(
    icTimeline.weeks.map((w) => [
      w.weekStart,
      w.beforeTracking ? "before_tracking" : (w.state as WeekImport),
    ]),
  );

  const today = now.toISOString().slice(0, 10);
  return {
    summary: buildPracticeSummary({
      userId,
      from,
      to,
      today,
      rows,
      lists,
      rules,
      weekPublication,
      weekImport,
    }),
    clinician: { name: profRes.data?.full_name ?? null, grade: profRes.data?.grade ?? null },
    rules,
    weekStatusInstalled: ws.capture === "available",
    importTrackingInstalled: ic.capture === "available",
    importTrackingSince: icTimeline.trackingSince,
    generatedAt: now.toISOString(),
  };
}

const Input = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

export const getMyPracticeSummary = createServerFn({ method: "POST" })
  .middleware([requireActiveMember])
  .inputValidator((input: unknown) => Input.strict().parse(input))
  .handler(async ({ data, context }) =>
    loadPracticeSummary(context.supabase, context.userId, data.from, data.to),
  );
