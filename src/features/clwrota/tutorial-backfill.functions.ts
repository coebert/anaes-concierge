import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { TutorialBackfillResult } from "./tutorial-backfill.server";

export type { TutorialBackfillResult };

/**
 * Re-apply the current tutorial-detection logic to rota_assignments in a
 * window. The heavy lifting lives in `tutorial-backfill.server.ts` so the
 * scheduled cron hook can reuse exactly the same rules.
 */
export const backfillTutorialDetection = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data) =>
    z
      .object({
        startIso: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        endIso: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        dryRun: z.boolean().default(false),
      })
      .refine((v) => v.startIso <= v.endIso, {
        message: "startIso must be before endIso",
      })
      .parse(data),
  )
  .handler(async ({ data, context }): Promise<TutorialBackfillResult> => {
    const { data: roles, error: roleError } = await context.supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", context.userId)
      .in("role", ["admin", "rota_coordinator"]);
    if (roleError) throw new Error(roleError.message);
    if (!roles || roles.length === 0) {
      throw new Error(
        "Forbidden: tutorial backfill requires admin or rota coordinator access.",
      );
    }

    const { runTutorialBackfill } = await import("./tutorial-backfill.server");
    return runTutorialBackfill(data);
  });
