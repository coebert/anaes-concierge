import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const CreateStaffSchema = z.object({
  email: z.string().email().max(255),
  full_name: z.string().trim().min(1).max(200),
  grade: z.enum(["consultant", "sas", "trainee"]).nullable().optional(),
  training_level: z
    .enum(["CT1", "CT2", "CT3", "ACCS1", "ACCS2", "ACCS3", "ST4", "ST5", "ST6", "ST7", "ST8", "ST8+"])
    .nullable()
    .optional(),
  role: z.enum(["admin", "rota_coordinator", "staff"]).default("staff"),
  send_invite: z.boolean().default(true),
  password: z.string().min(8).max(72).optional(),
});

export const createStaffMember = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => CreateStaffSchema.parse(d))
  .handler(async ({ data, context }) => {
    // Verify caller is admin
    const { data: roleRow } = await context.supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", context.userId)
      .eq("role", "admin")
      .maybeSingle();
    if (!roleRow) {
      return { error: "Only admins can add staff members." };
    }

    // Create the auth user. handle_new_user() trigger creates profile + 'staff' role.
    let userId: string | null = null;

    if (data.send_invite && !data.password) {
      const { data: invited, error } = await supabaseAdmin.auth.admin.inviteUserByEmail(
        data.email,
        { data: { full_name: data.full_name } },
      );
      if (error) return { error: error.message };
      userId = invited.user?.id ?? null;
    } else {
      const { data: created, error } = await supabaseAdmin.auth.admin.createUser({
        email: data.email,
        password: data.password,
        email_confirm: true,
        user_metadata: { full_name: data.full_name },
      });
      if (error) return { error: error.message };
      userId = created.user?.id ?? null;
    }

    if (!userId) return { error: "User was created but no id was returned." };

    // Ensure profile exists (the trigger only auto-creates profiles for pre-approved
    // access requests; admin-invited users bypass that gate so we upsert here).
    const profilePatch: {
      id: string;
      email: string;
      full_name: string;
      grade?: "consultant" | "sas" | "trainee" | null;
      training_level?: string | null;
    } = { id: userId, email: data.email, full_name: data.full_name };
    if (data.grade !== undefined) profilePatch.grade = data.grade;
    if (data.training_level !== undefined) profilePatch.training_level = data.training_level;

    const { error: profErr } = await supabaseAdmin
      .from("profiles")
      .upsert(profilePatch, { onConflict: "id" });
    if (profErr) return { error: `User created, but profile update failed: ${profErr.message}` };

    // Ensure the requested role exists (trigger may not have inserted it for admin invites).
    const { error: roleErr } = await supabaseAdmin
      .from("user_roles")
      .upsert({ user_id: userId, role: data.role }, { onConflict: "user_id,role" });
    if (roleErr) return { error: `User created, but role assignment failed: ${roleErr.message}` };

    return { ok: true, id: userId };
  });

/** Admin-only: list staff including sensitive fields (email). */
export const listStaffForAdmin = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data: roleRow } = await context.supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", context.userId)
      .eq("role", "admin")
      .maybeSingle();
    if (!roleRow) {
      throw new Error("Only admins can list staff with emails.");
    }
    const { data, error } = await supabaseAdmin
      .from("profiles_v")
      .select("id,email,full_name,grade,training_level,active,start_date")
      .order("full_name");
    if (error) throw new Error(error.message);
    return data ?? [];
  });
