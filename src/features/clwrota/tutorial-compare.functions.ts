import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export type TutorialCompareDelivery = {
  key: string;
  staffId: string;
  staffName: string;
  session_date: string;
  session: string;
  label: string | null;
};

export type TutorialCompareResult = {
  windowStart: string;
  windowEnd: string;
  sourceCount: number;
  auditCount: number;
  missingFromAudit: TutorialCompareDelivery[];
  extraInAudit: TutorialCompareDelivery[];
  diverged: boolean;
};

/**
 * Live side-by-side comparison of CLWRota tutorial deliveries against the
 * rows the tutorial audit holds, for an arbitrary date range. Read-only.
 */
export const compareTutorialDeliveries = createServerFn({ method: "POST" })
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
  .handler(async ({ data, context }): Promise<TutorialCompareResult> => {
    const { data: roles, error: roleError } = await context.supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", context.userId)
      .in("role", ["admin", "rota_coordinator"]);
    if (roleError) throw new Error(roleError.message);
    if (!roles || roles.length === 0) {
      throw new Error("Forbidden: tutorials audit requires admin or rota coordinator access.");
    }

    // Guard against very large windows: the CLWRota report is fetched live.
    const days =
      (Date.parse(`${data.endIso}T00:00:00Z`) - Date.parse(`${data.startIso}T00:00:00Z`)) /
      86_400_000;
    if (days > 120) {
      throw new Error("Please choose a range of 120 days or less for the live comparison.");
    }

    const { verifyTutorialWindow } = await import("./tutorial-verify.server");
    const result = await verifyTutorialWindow({ startIso: data.startIso, endIso: data.endIso });
    return {
      windowStart: result.windowStart,
      windowEnd: result.windowEnd,
      sourceCount: result.sourceCount,
      auditCount: result.auditCount,
      missingFromAudit: result.missingFromAudit,
      extraInAudit: result.extraInAudit,
      diverged: result.diverged,
    };
  });
