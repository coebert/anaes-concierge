import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/**
 * Coordinator/admin-elevated reads of the staff directory.
 *
 * Under the current RLS policy on `profiles`, plain authenticated staff can
 * only read their own row. These server functions use `supabaseAdmin` to
 * return a SAFE projection of colleague rows (no email, no GMC number) so
 * UI like the rota board and trainee list can still resolve names/grades
 * for everyone without exposing sensitive PII.
 */

type SafeStaff = {
  id: string;
  full_name: string | null;
  grade: "consultant" | "sas" | "trainee" | null;
  training_level: string | null;
  active: boolean;
  start_date: string | null;
};

const SAFE_COLS = "id,full_name,grade,training_level,active,start_date" as const;

/** Active staff with safe columns — visible to any authenticated user. */
export const listActiveStaffSafe = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async (): Promise<SafeStaff[]> => {
    const { data, error } = await supabaseAdmin
      .from("profiles_v")
      .select(SAFE_COLS)
      .eq("active", true)
      .order("full_name");
    if (error) throw new Error(error.message);
    return (data ?? []) as SafeStaff[];
  });

/** Lookup safe staff rows by ids — visible to any authenticated user. */
export const listStaffByIdsSafe = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z.object({ ids: z.array(z.string().uuid()).max(500) }).parse(d),
  )
  .handler(async ({ data }): Promise<SafeStaff[]> => {
    if (!data.ids.length) return [];
    const { data: rows, error } = await supabaseAdmin
      .from("profiles_v")
      .select(SAFE_COLS)
      .in("id", data.ids);
    if (error) throw new Error(error.message);
    return (rows ?? []) as SafeStaff[];
  });

async function getCallerAccess(
  supabase: any,
  userId: string,
): Promise<{ isAdmin: boolean; isCoordinator: boolean; isTrainee: boolean }> {
  const [{ data: roles }, { data: profile }] = await Promise.all([
    supabase.from("user_roles").select("role").eq("user_id", userId),
    supabase.from("profiles_v").select("grade").eq("id", userId).maybeSingle(),
  ]);
  const roleSet = new Set((roles ?? []).map((r: { role: string }) => r.role));
  return {
    isAdmin: roleSet.has("admin"),
    isCoordinator: roleSet.has("rota_coordinator"),
    isTrainee: profile?.grade === "trainee",
  };
}

async function assertAdminOrTrainee(supabase: any, userId: string) {
  const access = await getCallerAccess(supabase, userId);
  if (!access.isAdmin && !access.isCoordinator && !access.isTrainee) {
    throw new Error("Forbidden: trainee data is restricted.");
  }
  return access;
}

/** Trainee overview list. Email is included only for admins/coordinators. */
export const listTraineesForOverview = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const access = await assertAdminOrTrainee(context.supabase, context.userId);
    const canSeeEmail = access.isAdmin || access.isCoordinator;
    const { data, error } = await supabaseAdmin
      .from("profiles_v")
      .select("id,full_name,email,training_level,active,start_date,rotation_end_date,grade,left_at")
      .eq("grade", "trainee")
      // Include inactive trainees that the daily routine has flagged as
      // departed so the UI can still surface them with a 'no longer at
      // Salisbury' badge.
      .or("active.eq.true,left_at.not.is.null")
      .order("full_name");
    if (error) throw new Error(error.message);
    return (data ?? []).map((row) => ({ ...row, email: canSeeEmail ? row.email : null }));
  });

/** Single trainee profile + supervisor name lookups. Email visible to admins/coordinators or the trainee themselves. */
export const getTraineeProfileWithSupervisors = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        staffId: z.string().uuid(),
        supervisorIds: z.array(z.string().uuid()).max(500).default([]),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const access = await assertAdminOrTrainee(context.supabase, context.userId);
    const canSeeEmail =
      access.isAdmin || access.isCoordinator || context.userId === data.staffId;
    const [{ data: profile, error: e1 }, supRes] = await Promise.all([
      supabaseAdmin
        .from("profiles_v")
        .select("id,full_name,email,training_level,grade,start_date,rotation_end_date")
        .eq("id", data.staffId)
        .maybeSingle(),
      data.supervisorIds.length
        ? supabaseAdmin.from("profiles_v").select("id,full_name").in("id", data.supervisorIds)
        : Promise.resolve({ data: [] as Array<{ id: string; full_name: string | null }>, error: null }),
    ]);
    if (e1) throw new Error(e1.message);
    if ("error" in supRes && supRes.error) throw new Error(supRes.error.message);
    const safeProfile = profile ? { ...profile, email: canSeeEmail ? profile.email : null } : profile;
    return { profile: safeProfile, supervisors: supRes.data ?? [] };
  });

