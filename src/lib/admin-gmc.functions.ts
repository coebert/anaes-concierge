import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

async function assertAdmin(userId: string) {
  const { data } = await supabaseAdmin
    .from("user_roles")
    .select("role")
    .eq("user_id", userId)
    .eq("role", "admin")
    .maybeSingle();
  if (!data) throw new Error("Admins only");
}

export const getProfileGmcNumber = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ staffId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    await assertAdmin(context.userId);
    const { data: row, error } = await supabaseAdmin
      .from("profiles")
      .select("gmc_number")
      .eq("id", data.staffId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return { gmc_number: row?.gmc_number ?? null };
  });

export const updateProfileGmcNumber = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        staffId: z.string().uuid(),
        gmc_number: z
          .string()
          .trim()
          .max(20)
          .regex(/^[A-Za-z0-9-]*$/)
          .nullable(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertAdmin(context.userId);
    const value = data.gmc_number && data.gmc_number.length ? data.gmc_number : null;
    const { error } = await supabaseAdmin
      .from("profiles")
      .update({ gmc_number: value })
      .eq("id", data.staffId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });
