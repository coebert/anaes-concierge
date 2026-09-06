import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  ICU_DUTY_TYPES,
  tallyIcuWorkload,
  type IcuPaRules,
  type IcuRow,
  type IcuStaffTally,
} from "./icu-workload";

/**
 * Per-consultant intensive-care evidence: every ICU session credited to one
 * doctor over a chosen window, the PAs behind it, and any place where the
 * rota and the CLWRota source record disagree.
 *
 * Access: a doctor may always read their own record; admins and rota
 * coordinators may read anyone's.
 */

export type IcuEvidenceSession = {
  id: string;
  sessionDate: string;
  session: string;
  dutyType: string;
  extraType: string | null;
  /** PA value CLWRota recorded on the row, when it has one. */
  paCredit: number | null;
  /** Whether the source CLWRota record has been stored for this session. */
  hasSourceRecord: boolean;
  clwrotaExternalId: string | null;
  matchedField: string | null;
  matchedValue: string | null;
  placeName: string | null;
  roleLabel: string | null;
  /** Other consultants credited on the same row. */
  sharedWith: string[];
};

export type IcuEvidenceDiscrepancy = {
  kind: "missing_source_record" | "source_only";
  sessionDate: string;
  session: string;
  detail: string;
};

export type IcuConsultantEvidence = {
  staffId: string;
  staffName: string;
  grade: string | null;
  windowStart: string;
  windowEnd: string;
  rules: IcuPaRules;
  tally: IcuStaffTally | null;
  sessions: IcuEvidenceSession[];
  discrepancies: IcuEvidenceDiscrepancy[];
};

export type IcuEvidenceStaffOption = {
  id: string;
  name: string;
  grade: string | null;
};

const DEFAULT_RULES: IcuPaRules = {
  sessions_per_pa: 1,
  oncall_pa_credit: 1,
  weekend_pa_credit: 1.5,
};

/** Consultants and SAS doctors an admin can pick from. */
export const listIcuEvidenceStaff = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<IcuEvidenceStaffOption[]> => {
    const { data, error } = await context.supabase
      .from("profiles")
      .select("id,full_name,grade")
      .in("grade", ["consultant", "sas"])
      .order("full_name");
    if (error) throw new Error(error.message);
    return (data ?? []).map((p) => ({
      id: p.id,
      name: p.full_name ?? "Unknown",
      grade: p.grade ?? null,
    }));
  });

export const getIcuConsultantEvidence = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data) =>
    z
      .object({
        staffId: z.string().uuid().optional(),
        startIso: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        endIso: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      })
      .refine((v) => v.startIso <= v.endIso, { message: "startIso must be before endIso" })
      .parse(data),
  )
  .handler(async ({ data, context }): Promise<IcuConsultantEvidence> => {
    const staffId = data.staffId ?? context.userId;

    if (staffId !== context.userId) {
      const { data: roles, error: roleError } = await context.supabase
        .from("user_roles")
        .select("role")
        .eq("user_id", context.userId)
        .in("role", ["admin", "rota_coordinator"]);
      if (roleError) throw new Error(roleError.message);
      if (!roles || roles.length === 0) {
        throw new Error("Forbidden: you can only view your own intensive care record.");
      }
    }

    const days =
      (Date.parse(`${data.endIso}T00:00:00Z`) - Date.parse(`${data.startIso}T00:00:00Z`)) /
      86_400_000;
    if (days > 800) {
      throw new Error("Please choose a period of two years or less.");
    }

    // Caller verified above; the stored source records are coordinator-only at
    // the row level, so read them with the privileged client scoped to this
    // one doctor and window.
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const [profileRes, rulesRes, ownRes, attendedRes, traceRes, namesRes] = await Promise.all([
      supabaseAdmin.from("profiles").select("id,full_name,grade").eq("id", staffId).maybeSingle(),
      supabaseAdmin
        .from("rota_rules")
        .select("sessions_per_pa,oncall_pa_credit,weekend_pa_credit")
        .limit(1)
        .maybeSingle(),
      supabaseAdmin
        .from("rota_assignments")
        .select(
          "id,staff_id,session_date,session,duty_type,extra_type,pa_credit,attending_consultant_ids",
        )
        .eq("staff_id", staffId)
        .in("duty_type", [...ICU_DUTY_TYPES])
        .gte("session_date", data.startIso)
        .lte("session_date", data.endIso)
        .order("session_date", { ascending: true })
        .range(0, 4999),
      supabaseAdmin
        .from("rota_assignments")
        .select(
          "id,staff_id,session_date,session,duty_type,extra_type,pa_credit,attending_consultant_ids",
        )
        .contains("attending_consultant_ids", [staffId])
        .in("duty_type", [...ICU_DUTY_TYPES])
        .gte("session_date", data.startIso)
        .lte("session_date", data.endIso)
        .order("session_date", { ascending: true })
        .range(0, 4999),
      supabaseAdmin
        .from("icu_detection_matches")
        .select(
          "session_date,session,duty_type,clwrota_external_id,matched_field,matched_value,place_name,role_label,pa_credit",
        )
        .eq("staff_id", staffId)
        .gte("session_date", data.startIso)
        .lte("session_date", data.endIso)
        .order("session_date", { ascending: true })
        .range(0, 4999),
      supabaseAdmin.from("profiles").select("id,full_name").in("grade", ["consultant", "sas"]),
    ]);

    if (profileRes.error) throw new Error(profileRes.error.message);
    if (ownRes.error) throw new Error(ownRes.error.message);
    if (attendedRes.error) throw new Error(attendedRes.error.message);
    if (traceRes.error) throw new Error(traceRes.error.message);

    const rules: IcuPaRules = {
      sessions_per_pa: Number(rulesRes.data?.sessions_per_pa ?? DEFAULT_RULES.sessions_per_pa),
      oncall_pa_credit: Number(rulesRes.data?.oncall_pa_credit ?? DEFAULT_RULES.oncall_pa_credit),
      weekend_pa_credit: Number(
        rulesRes.data?.weekend_pa_credit ?? DEFAULT_RULES.weekend_pa_credit,
      ),
    };

    const nameById = new Map<string, string>();
    for (const p of namesRes.data ?? []) nameById.set(p.id, p.full_name ?? "Unknown");

    type Assignment = {
      id: string;
      staff_id: string;
      session_date: string;
      session: string;
      duty_type: string;
      extra_type: string | null;
      pa_credit: number | null;
      attending_consultant_ids: string[] | null;
    };
    const byId = new Map<string, Assignment>();
    for (const r of [
      ...((ownRes.data ?? []) as Assignment[]),
      ...((attendedRes.data ?? []) as Assignment[]),
    ]) {
      byId.set(r.id, r);
    }
    const assignments = [...byId.values()].sort(
      (a, b) => a.session_date.localeCompare(b.session_date) || a.session.localeCompare(b.session),
    );

    const traceByKey = new Map<string, (typeof traceRes.data extends (infer T)[] ? T : never)>();
    for (const t of traceRes.data ?? []) {
      traceByKey.set(`${t.session_date}|${t.session}`, t);
    }

    const sessions: IcuEvidenceSession[] = assignments.map((r) => {
      const trace = traceByKey.get(`${r.session_date}|${r.session}`);
      const shared = (r.attending_consultant_ids ?? [])
        .filter((id) => id !== staffId)
        .map((id) => nameById.get(id) ?? "Unknown");
      return {
        id: r.id,
        sessionDate: r.session_date,
        session: r.session,
        dutyType: r.duty_type,
        extraType: r.extra_type,
        paCredit: r.pa_credit ?? trace?.pa_credit ?? null,
        hasSourceRecord: Boolean(trace),
        clwrotaExternalId: trace?.clwrota_external_id ?? null,
        matchedField: trace?.matched_field ?? null,
        matchedValue: trace?.matched_value ?? null,
        placeName: trace?.place_name ?? null,
        roleLabel: trace?.role_label ?? null,
        sharedWith: shared,
      };
    });

    const assignmentKeys = new Set(assignments.map((r) => `${r.session_date}|${r.session}`));
    const discrepancies: IcuEvidenceDiscrepancy[] = [];
    for (const s of sessions) {
      if (s.hasSourceRecord) continue;
      discrepancies.push({
        kind: "missing_source_record",
        sessionDate: s.sessionDate,
        session: s.session,
        detail: "On the rota, but no CLWRota record has been stored for it yet.",
      });
    }
    for (const t of traceRes.data ?? []) {
      if (assignmentKeys.has(`${t.session_date}|${t.session}`)) continue;
      discrepancies.push({
        kind: "source_only",
        sessionDate: t.session_date,
        session: t.session,
        detail: `CLWRota records this session (${t.matched_value ?? t.place_name ?? "intensive care"}), but it is not on the rota.`,
      });
    }
    discrepancies.sort(
      (a, b) => a.sessionDate.localeCompare(b.sessionDate) || a.session.localeCompare(b.session),
    );

    const rows: IcuRow[] = assignments.map((r) => ({
      staff_id: r.staff_id,
      session_date: r.session_date,
      session: r.session,
      duty_type: r.duty_type,
      extra_type: r.extra_type,
      pa_credit: r.pa_credit,
      attending_consultant_ids: r.attending_consultant_ids,
    }));
    const tally = tallyIcuWorkload(rows, rules).find((t) => t.staff_id === staffId) ?? null;

    return {
      staffId,
      staffName: profileRes.data?.full_name ?? nameById.get(staffId) ?? "Unknown",
      grade: profileRes.data?.grade ?? null,
      windowStart: data.startIso,
      windowEnd: data.endIso,
      rules,
      tally,
      sessions,
      discrepancies,
    };
  });
