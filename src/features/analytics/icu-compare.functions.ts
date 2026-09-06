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

export type IcuTraceRow = {
  id: string;
  staffId: string;
  staffName: string;
  sessionDate: string;
  session: string;
  dutyType: string | null;
  clwrotaExternalId: string | null;
  matchedField: string | null;
  matchedValue: string | null;
  placeName: string | null;
  slotTitles: string | null;
  roleLabel: string | null;
  personLabel: string | null;
  paCredit: number | null;
  detectedAt: string;
  sourceRow: string;
};

/**
 * Stored traceability: the original CLWRota record behind each detected
 * intensive-care session. Written by the live comparison; read-only here.
 */
export const listIcuTraces = createServerFn({ method: "POST" })
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
  .handler(async ({ data, context }): Promise<IcuTraceRow[]> => {
    const { data: rows, error } = await context.supabase
      .from("icu_detection_matches")
      .select(
        "id,staff_id,session_date,session,duty_type,clwrota_external_id,matched_field,matched_value,place_name,slot_titles,role_label,person_label,pa_credit,detected_at,source_row",
      )
      .gte("session_date", data.startIso)
      .lte("session_date", data.endIso)
      .order("session_date", { ascending: true })
      .limit(1000);
    if (error) throw new Error(error.message);

    const ids = [...new Set((rows ?? []).map((r) => r.staff_id))];
    const nameById = new Map<string, string>();
    if (ids.length > 0) {
      const { data: profiles } = await context.supabase
        .from("profiles")
        .select("id,full_name")
        .in("id", ids);
      for (const p of profiles ?? []) nameById.set(p.id, p.full_name);
    }

    return (rows ?? []).map((r) => ({
      id: r.id,
      staffId: r.staff_id,
      staffName: nameById.get(r.staff_id) ?? r.person_label ?? r.staff_id,
      sessionDate: r.session_date,
      session: r.session,
      dutyType: r.duty_type,
      clwrotaExternalId: r.clwrota_external_id,
      matchedField: r.matched_field,
      matchedValue: r.matched_value,
      placeName: r.place_name,
      slotTitles: r.slot_titles,
      roleLabel: r.role_label,
      personLabel: r.person_label,
      paCredit: r.pa_credit,
      detectedAt: r.detected_at,
      sourceRow: JSON.stringify(r.source_row, null, 2),
    }));
  });

