import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { isTutorialAuditCandidate } from "./tutorial-audit";

type AuditGrade = "consultant" | "sas";

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
    const [profilesRes, assignmentsRes] = await Promise.all([
      supabaseAdmin
        .from("profiles")
        .select("id,full_name,grade,active")
        .in("grade", ["consultant", "sas"])
        .range(0, 9999),
      supabaseAdmin
        .from("rota_assignments")
        .select(
          "id,staff_id,session_date,session,duty_type,notes,role_on_list,extra_type,clwrota_external_id,source,locally_modified",
        )
        .in("duty_type", ["spa", "admin", "teaching"])
        // Note: role_on_list is an enum (rota_role) — PostgREST rejects
        // `ilike` against enum columns with "operator does not exist", which
        // fails the ENTIRE .or() query and returns zero rows. Only apply
        // ilike to text columns (notes, extra_type). Enum-valued teaching
        // is covered by `duty_type.eq.teaching`.
        .or(
          [
            "duty_type.eq.teaching",
            "notes.ilike.%tutorial%",
            "extra_type.ilike.%tutorial%",
            "notes.ilike.%tutor%",
            "extra_type.ilike.%tutor%",
            "notes.ilike.%lecture%",
            "extra_type.ilike.%lecture%",
            "notes.ilike.%departmental teaching%",
            "extra_type.ilike.%departmental teaching%",
          ].join(","),
        )
        .gte("session_date", data.startIso)
        .lte("session_date", data.endIso)
        .order("session_date", { ascending: false })
        .range(0, 9999),
    ]);
    if (profilesRes.error) throw new Error(profilesRes.error.message);
    if (assignmentsRes.error) throw new Error(assignmentsRes.error.message);

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

    return ((assignmentsRes.data ?? []) as Array<{
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
    }>)
      .flatMap((row) => {
        const staff = staffMap.get(row.staff_id);
        if (!staff) return [];
        if (!isTutorialAuditCandidate(row)) return [];
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