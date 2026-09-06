import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { ICU_DUTY_TYPES, type IcuPaRules, type IcuRow } from "./icu-workload";
import { tallyPaByConsultant, type PaConsultantTally } from "./pa-by-consultant";

/**
 * PAs by consultant: every consultant/SAS doctor's ICU PAs over a chosen
 * window, split into PAs CLWRota recorded and PAs estimated from the rota
 * rules, with a flag where evidence gaps (no recorded PA) exist.
 *
 * Admin / rota coordinator only — this is a department oversight view.
 */

export type PaByConsultantRow = PaConsultantTally & {
  name: string;
  grade: string | null;
};

export type PaByConsultantResult = {
  windowStart: string;
  windowEnd: string;
  rules: IcuPaRules;
  rows: PaByConsultantRow[];
};

const DEFAULT_RULES: IcuPaRules = {
  sessions_per_pa: 1,
  oncall_pa_credit: 1.5,
  weekend_pa_credit: 3,
};

export const getPaByConsultant = createServerFn({ method: "POST" })
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
  .handler(async ({ data, context }): Promise<PaByConsultantResult> => {
    const { data: isCoordinator } = await context.supabase.rpc(
      "current_user_is_coordinator_or_admin",
    );
    if (!isCoordinator) throw new Error("Forbidden");

    const days =
      (Date.parse(`${data.endIso}T00:00:00Z`) - Date.parse(`${data.startIso}T00:00:00Z`)) /
      86_400_000;
    if (days > 800) {
      throw new Error("Please choose a period of two years or less.");
    }

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const [assignRes, profilesRes, rulesRes] = await Promise.all([
      supabaseAdmin
        .from("rota_assignments")
        .select(
          "staff_id,session_date,session,duty_type,extra_type,pa_credit,attending_consultant_ids",
        )
        .in("duty_type", [...ICU_DUTY_TYPES])
        .gte("session_date", data.startIso)
        .lte("session_date", data.endIso)
        .order("session_date", { ascending: true })
        .range(0, 9999),
      supabaseAdmin
        .from("profiles")
        .select("id,full_name,grade")
        .in("grade", ["consultant", "sas"]),
      supabaseAdmin
        .from("rota_rules")
        .select("sessions_per_pa,oncall_pa_credit,weekend_pa_credit")
        .limit(1)
        .maybeSingle(),
    ]);

    if (assignRes.error) throw new Error(assignRes.error.message);
    if (profilesRes.error) throw new Error(profilesRes.error.message);

    const rules: IcuPaRules = {
      sessions_per_pa: Number(rulesRes.data?.sessions_per_pa ?? DEFAULT_RULES.sessions_per_pa),
      oncall_pa_credit: Number(rulesRes.data?.oncall_pa_credit ?? DEFAULT_RULES.oncall_pa_credit),
      weekend_pa_credit: Number(
        rulesRes.data?.weekend_pa_credit ?? DEFAULT_RULES.weekend_pa_credit,
      ),
    };

    const nameById = new Map<string, { name: string; grade: string | null }>();
    for (const p of profilesRes.data ?? []) {
      nameById.set(p.id, { name: p.full_name ?? "Unknown", grade: p.grade ?? null });
    }

    const tallies = tallyPaByConsultant((assignRes.data ?? []) as IcuRow[], rules);
    const rows: PaByConsultantRow[] = tallies.map((t) => ({
      ...t,
      name: nameById.get(t.staffId)?.name ?? "Unknown",
      grade: nameById.get(t.staffId)?.grade ?? null,
    }));

    return { windowStart: data.startIso, windowEnd: data.endIso, rules, rows };
  });
