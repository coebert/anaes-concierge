import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { fetchAllPaged } from "@/lib/supabase-chunked";
import { isTutorialAuditCandidate } from "./tutorial-audit";

type AuditGrade = "consultant" | "sas";

type AuditAssignmentRow = {
  id: string;
  staff_id: string;
  session_date: string;
  session: "am" | "pm" | "eve" | "night";
  duty_type: "spa" | "admin" | "teaching";
  notes: string | null;
  role_on_list: string;
  extra_type: string | null;
  clwrota_external_id: string | null;
  source: string;
  locally_modified: boolean;
  theatre_session_id: string | null;
};

export type TutorialAuditSession = {
  id: string;
  staff_id: string;
  staffName: string;
  staffGrade: AuditGrade;
  staffActive: boolean;
  session_date: string;
  session: "am" | "pm" | "eve" | "night";
  duty_type: "spa" | "admin" | "teaching";
  notes: string | null;
  role_on_list: string;
  extra_type: string | null;
  clwrota_external_id: string | null;
  source: string;
  locally_modified: boolean;
};

export const listTutorialAuditSessions = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data) =>
    z
      .object({
        startIso: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        endIso: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      })
      .refine((value) => value.startIso <= value.endIso, {
        message: "startIso must be before endIso",
      })
      .parse(data),
  )
  .handler(async ({ data, context }): Promise<TutorialAuditSession[]> => {
    const { data: roles, error: roleError } = await context.supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", context.userId)
      .in("role", ["admin", "rota_coordinator"]);
    if (roleError) throw new Error(roleError.message);
    if (!roles || roles.length === 0) {
      throw new Error("Forbidden: tutorials audit requires admin or rota coordinator access.");
    }

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const assignmentSelect: string =
      "id,staff_id,session_date,session,duty_type,notes,role_on_list,extra_type,clwrota_external_id,source,locally_modified,theatre_session_id";
    const [profilesRes, assignments] = await Promise.all([
      supabaseAdmin
        .from("profiles")
        .select("id,full_name,grade,active")
        .in("grade", ["consultant", "sas"])
        .range(0, 9999),
      fetchAllPaged<AuditAssignmentRow>(() =>
        supabaseAdmin
          .from("rota_assignments")
          .select(assignmentSelect)
          .in("duty_type", ["spa", "admin", "teaching"])
          .gte("session_date", data.startIso)
          .lte("session_date", data.endIso)
          .order("session_date", { ascending: false })
          .order("id", { ascending: true })
          .returns<AuditAssignmentRow[]>(),
      ),
    ]);
    if (profilesRes.error) throw new Error(profilesRes.error.message);

    const staffMap = new Map<
      string,
      { full_name: string | null; grade: AuditGrade; active: boolean }
    >();
    for (const profile of profilesRes.data ?? []) {
      if (profile.grade === "consultant" || profile.grade === "sas") {
        staffMap.set(profile.id, {
          full_name: profile.full_name,
          grade: profile.grade,
          active: profile.active,
        });
      }
    }

    const theatreSessionIds = Array.from(
      new Set(
        assignments
          .map((row) => row.theatre_session_id as string | null)
          .filter((id): id is string => Boolean(id)),
      ),
    );
    const theatreNames = new Map<string, string>();
    for (let i = 0; i < theatreSessionIds.length; i += 500) {
      const ids = theatreSessionIds.slice(i, i + 500);
      const theatreRes = await supabaseAdmin
        .from("theatre_sessions")
        .select("id,theatres(name)")
        .in("id", ids);
      if (theatreRes.error) throw new Error(theatreRes.error.message);
      for (const session of theatreRes.data ?? []) {
        const joined = session.theatres as { name?: string | null } | null;
        if (joined?.name) theatreNames.set(session.id as string, joined.name);
      }
    }

    return assignments
      .flatMap((row) => {
        const staff = staffMap.get(row.staff_id);
        if (!staff) return [];
        const theatreName = row.theatre_session_id
          ? theatreNames.get(row.theatre_session_id) ?? null
          : null;
        if (!isTutorialAuditCandidate({ ...row, theatreName })) return [];
        return [
          {
            ...row,
            staffName: staff.full_name?.trim() || "Unknown staff member",
            staffGrade: staff.grade,
            staffActive: staff.active,
          },
        ];
      })
      .sort(
        (a, b) =>
          b.session_date.localeCompare(a.session_date) ||
          a.staffName.localeCompare(b.staffName) ||
          a.session.localeCompare(b.session),
      );
  });