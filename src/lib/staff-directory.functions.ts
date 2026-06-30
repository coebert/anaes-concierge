import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/**
 * Coordinator/admin-elevated reads of the staff directory.
 *
 * Sensitive columns (email, GMC) live encrypted at rest. We read through the
 * `get_profiles_decrypted` SECURITY DEFINER RPC so the returned rows are
 * strictly typed (non-nullable) and decryption is centralised in SQL.
 */

type SafeStaff = {
  id: string;
  full_name: string | null;
  grade: "consultant" | "sas" | "trainee" | null;
  training_level: string | null;
  active: boolean;
  start_date: string | null;
};

function toSafe(p: {
  id: string;
  full_name: string;
  grade: "consultant" | "sas" | "trainee";
  training_level: string;
  active: boolean;
  start_date: string;
}): SafeStaff {
  return {
    id: p.id,
    full_name: p.full_name,
    grade: p.grade,
    training_level: p.training_level,
    active: p.active,
    start_date: p.start_date,
  };
}

/** Active staff with safe columns — visible to any authenticated user. */
export const listActiveStaffSafe = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async (): Promise<SafeStaff[]> => {
    const { data, error } = await supabaseAdmin.rpc("get_profiles_decrypted");
    if (error) throw new Error(error.message);
    const rows = (data ?? [])
      .filter((p) => p.active === true)
      .map(toSafe);
    rows.sort((a, b) => (a.full_name ?? "").localeCompare(b.full_name ?? ""));
    return rows;
  });

/** Lookup safe staff rows by ids — visible to any authenticated user. */
export const listStaffByIdsSafe = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z.object({ ids: z.array(z.string().uuid()).max(500) }).parse(d),
  )
  .handler(async ({ data }): Promise<SafeStaff[]> => {
    if (!data.ids.length) return [];
    const { data: rows, error } = await supabaseAdmin.rpc("get_profiles_decrypted");
    if (error) throw new Error(error.message);
    const wanted = new Set(data.ids);
    return (rows ?? []).filter((p) => wanted.has(p.id)).map(toSafe);
  });

async function getCallerAccess(
  supabase: any,
  userId: string,
): Promise<{ isAdmin: boolean; isCoordinator: boolean; isTrainee: boolean }> {
  const [{ data: roles }, { data: profile }] = await Promise.all([
    supabase.from("user_roles").select("role").eq("user_id", userId),
    supabase.from("profiles").select("grade").eq("id", userId).maybeSingle(),
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
    const { data, error } = await supabaseAdmin.rpc("get_profiles_decrypted");
    if (error) throw new Error(error.message);
    const rows = (data ?? [])
      .filter(
        (p) => p.grade === "trainee" && (p.active === true || p.left_at !== null),
      )
      .map((p) => ({
        id: p.id,
        full_name: p.full_name,
        email: canSeeEmail ? p.email : null,
        training_level: p.training_level,
        active: p.active,
        start_date: p.start_date,
        rotation_end_date: p.rotation_end_date,
        grade: p.grade,
        left_at: p.left_at,
      }));
    rows.sort((a, b) => (a.full_name ?? "").localeCompare(b.full_name ?? ""));
    return rows;
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

    const [profileRes, allRes] = await Promise.all([
      supabaseAdmin.rpc("get_profile_decrypted", { p_id: data.staffId }),
      data.supervisorIds.length
        ? supabaseAdmin.rpc("get_profiles_decrypted")
        : Promise.resolve({ data: [] as Array<{ id: string; full_name: string }>, error: null }),
    ]);
    if (profileRes.error) throw new Error(profileRes.error.message);
    if ("error" in allRes && allRes.error) throw new Error(allRes.error.message);

    const p = (profileRes.data ?? [])[0];
    const profile = p
      ? {
          id: p.id,
          full_name: p.full_name,
          email: canSeeEmail ? p.email : null,
          training_level: p.training_level,
          grade: p.grade,
          start_date: p.start_date,
          rotation_end_date: p.rotation_end_date,
        }
      : null;

    const wanted = new Set(data.supervisorIds);
    const supervisors = (allRes.data ?? [])
      .filter((row) => wanted.has(row.id))
      .map((row) => ({ id: row.id, full_name: row.full_name }));

    return { profile, supervisors };
  });
