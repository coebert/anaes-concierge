import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { IcuVerifyResult } from "./icu-verify.server";

export type { IcuVerifyResult, IcuSessionKey, IcuStaffCompareRow } from "./icu-verify.server";

/**
 * Live side-by-side comparison of the intensive-care sessions CLWRota
 * reports against the ICU audit's own rows, for an arbitrary date range.
 * Read-only; admin / rota coordinator only.
 */
export const compareIcuSessions = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data) =>
    z
      .object({
        startIso: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        endIso: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      })
      .refine((v) => v.startIso <= v.endIso, { message: "startIso must be before endIso" })
      .parse(data),
  )
  .handler(async ({ data, context }): Promise<IcuVerifyResult> => {
    const { data: roles, error: roleError } = await context.supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", context.userId)
      .in("role", ["admin", "rota_coordinator"]);
    if (roleError) throw new Error(roleError.message);
    if (!roles || roles.length === 0) {
      throw new Error("Forbidden: the ICU audit requires admin or rota coordinator access.");
    }

    const days =
      (Date.parse(`${data.endIso}T00:00:00Z`) - Date.parse(`${data.startIso}T00:00:00Z`)) /
      86_400_000;
    if (days > 120) {
      throw new Error("Please choose a range of 120 days or less for the live comparison.");
    }

    const { verifyIcuWindow } = await import("./icu-verify.server");
    return verifyIcuWindow({ startIso: data.startIso, endIso: data.endIso });
  });
