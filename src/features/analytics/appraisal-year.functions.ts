/**
 * Server side of the appraisal-year page. The doctor is chosen on the server:
 * a caller may read their own year (consultant/SAS only), and only admins or
 * rota coordinators may read another doctor's. Reads run as the caller (RLS
 * applies), are fully paged, and only the built summary is returned — never
 * the raw rota rows, which also carry other doctors' ids.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { requireActiveMember } from "@/lib/require-admin";
import { fetchAllRowsPaged } from "@/features/audit/paginate";
import { appraisalYearOf, appraisalYearRange, buildAppraisalYear } from "./appraisal-year";
import type { AppraisalYearSummary } from "./appraisal-year";
import type { SpecialtyPaRules, SpecialtyRow } from "./specialty-workload";

type Db = SupabaseClient<Database>;

const ID_CHUNK = 200;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const APPRAISAL_GRADES = new Set(["consultant", "sas"]);
export const MIN_APPRAISAL_YEAR = 2015;

export function isCoordinatorRoles(roles: ReadonlySet<string>): boolean {
  return roles.has("admin") || roles.has("rota_coordinator");
}

export interface AppraisalYearResult {
  staffId: string;
  doctor: { name: string | null; grade: string | null };
  rules: SpecialtyPaRules;
  summary: AppraisalYearSummary;
}

type AssignmentRow = {
  id: string;
  staff_id: string | null;
  session_date: string | null;
  session: string | null;
  duty_type: string | null;
  extra_type: string | null;
  pa_credit: number | null;
  attending_consultant_ids: string[] | null;
  theatre_session_id: string | null;
};

export async function loadAppraisalYear(
  db: Db,
  caller: { userId: string; roles: ReadonlySet<string> },
  input: { year: number; staffId?: string | null },
  now: Date = new Date(),
): Promise<AppraisalYearResult> {
  const currentYear = appraisalYearOf(now.toISOString().slice(0, 10));
  if (
    !Number.isInteger(input.year) ||
    input.year < MIN_APPRAISAL_YEAR ||
    input.year > currentYear + 1
  )
    throw new Error("Choose an appraisal year from the list.");

  const coordinator = isCoordinatorRoles(caller.roles);
  const staffId = input.staffId || caller.userId;
  if (!UUID.test(staffId)) throw new Error("Forbidden");
  // Only admins and rota coordinators may look at another doctor's year.
  if (staffId !== caller.userId && !coordinator) throw new Error("Forbidden");

  const profRes = await db
    .from("profiles")
    .select("full_name,grade")
    .eq("id", staffId)
    .maybeSingle();
  if (profRes.error)
    throw new Error(`The doctor's profile could not be loaded: ${profRes.error.message}`);
  if (!profRes.data) throw new Error("That doctor could not be found.");
  // Without a coordinator role the page is for consultants and SAS doctors.
  if (!coordinator && !APPRAISAL_GRADES.has(profRes.data.grade ?? "")) throw new Error("Forbidden");

  const rulesRes = await db
    .from("rota_rules")
    .select("sessions_per_pa,oncall_pa_credit,weekend_pa_credit")
    .limit(1)
    .maybeSingle();
  // Never silently substitute default PA rates when the settings read fails.
  if (rulesRes.error) throw new Error(`PA settings could not be loaded: ${rulesRes.error.message}`);
  const rules: SpecialtyPaRules = {
    sessions_per_pa: Number(rulesRes.data?.sessions_per_pa ?? 1),
    oncall_pa_credit: Number(rulesRes.data?.oncall_pa_credit ?? 1.5),
    weekend_pa_credit: Number(rulesRes.data?.weekend_pa_credit ?? 3),
  };

  const { from, to } = appraisalYearRange(input.year);
  const raw = await fetchAllRowsPaged<AssignmentRow>(
    (a, b) =>
      db
        .from("rota_assignments")
        .select(
          "id,staff_id,session_date,session,duty_type,extra_type,pa_credit,attending_consultant_ids,theatre_session_id",
        )
        .gte("session_date", from)
        .lte("session_date", to)
        .or(`staff_id.eq.${staffId},attending_consultant_ids.cs.{${staffId}}`)
        .order("id", { ascending: true })
        .range(a, b) as unknown as PromiseLike<{ data: AssignmentRow[] | null; error: unknown }>,
    { rowKey: (r) => r.id, label: "appraisal-year.rota_assignments" },
  );

  const sessionIds = [
    ...new Set(raw.map((r) => r.theatre_session_id).filter((v): v is string => Boolean(v))),
  ].sort();
  const specialtyBySession = new Map<string, string>();
  type ListRow = { id: string; specialties: { name: string } | { name: string }[] | null };
  for (let i = 0; i < sessionIds.length; i += ID_CHUNK) {
    const ids = sessionIds.slice(i, i + ID_CHUNK);
    const page = await fetchAllRowsPaged<ListRow>(
      (a, b) =>
        db
          .from("theatre_sessions")
          .select("id,specialties(name)")
          .in("id", ids)
          .order("id", { ascending: true })
          .range(a, b) as unknown as PromiseLike<{ data: ListRow[] | null; error: unknown }>,
      { rowKey: (r) => r.id, label: "appraisal-year.theatre_sessions" },
    );
    for (const s of page) {
      const sp = Array.isArray(s.specialties) ? s.specialties[0] : s.specialties;
      if (sp?.name) specialtyBySession.set(s.id, sp.name);
    }
  }

  const rows: SpecialtyRow[] = raw.map((r) => ({
    staff_id: r.staff_id,
    session_date: r.session_date,
    session: r.session,
    duty_type: r.duty_type,
    extra_type: r.extra_type,
    pa_credit: r.pa_credit,
    attending_consultant_ids: r.attending_consultant_ids,
    specialty_name: r.theatre_session_id
      ? (specialtyBySession.get(r.theatre_session_id) ?? null)
      : null,
  }));

  return {
    staffId,
    doctor: { name: profRes.data.full_name ?? null, grade: profRes.data.grade ?? null },
    rules,
    summary: buildAppraisalYear(staffId, input.year, rows, rules),
  };
}

export async function loadAppraisalStaff(
  db: Db,
  roles: ReadonlySet<string>,
): Promise<Array<{ id: string; full_name: string | null }>> {
  if (!isCoordinatorRoles(roles)) throw new Error("Forbidden");
  type StaffRow = { id: string; full_name: string | null };
  return fetchAllRowsPaged<StaffRow>(
    (a, b) =>
      db
        .from("profiles")
        .select("id,full_name")
        .in("grade", ["consultant", "sas"])
        .order("full_name", { ascending: true })
        .order("id", { ascending: true })
        .range(a, b) as unknown as PromiseLike<{ data: StaffRow[] | null; error: unknown }>,
    { rowKey: (r) => r.id, label: "appraisal-year.staff" },
  );
}

const YearInput = z
  .object({
    year: z.number().int(),
    staffId: z.string().regex(UUID).nullable().optional(),
  })
  .strict();

export const getAppraisalYear = createServerFn({ method: "POST" })
  .middleware([requireActiveMember])
  .inputValidator((input: unknown) => YearInput.parse(input))
  .handler(async ({ data, context }) =>
    loadAppraisalYear(context.supabase, { userId: context.userId, roles: context.roles }, data),
  );

export const getAppraisalStaff = createServerFn({ method: "POST" })
  .middleware([requireActiveMember])
  .handler(async ({ context }) => loadAppraisalStaff(context.supabase, context.roles));
