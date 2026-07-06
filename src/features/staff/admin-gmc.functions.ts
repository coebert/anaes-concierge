import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { requireAdmin } from "@/lib/require-admin";


export const getProfileGmcNumber = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((d) => z.object({ staffId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: row, error } = await supabaseAdmin
      .from("profiles")
      .select("gmc_number")
      .eq("id", data.staffId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return { gmc_number: row?.gmc_number ?? null };
  });

export const updateProfileGmcNumber = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
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
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const value = data.gmc_number && data.gmc_number.length ? data.gmc_number : null;
    const { error } = await supabaseAdmin
      .from("profiles")
      .update({ gmc_number: value })
      .eq("id", data.staffId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });
