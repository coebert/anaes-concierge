import {
  clampDateWindow,
  ensureRotaReportFields,
  explicitDateWindow,
  fetchReportRaw,
  looksLikeTutorialLabel,
  normaliseDate,
  normaliseSession,
  parseRows,
  pick,
} from "./parsing";
import { fetchAllPaged } from "@/lib/supabase-chunked";
import { isTutorialAuditCandidate } from "./tutorial-audit";

export type TutorialDeliveryKey = {
  key: string;
  staffId: string;
  staffName: string;
  session_date: string;
  session: string;
  label: string | null;
};

/** Traceability record: which CLWRota row produced a detected tutorial. */
export type TutorialSourceEvidence = {
  staffId: string;
  session_date: string;
  session: string;
  clwrotaExternalId: string | null;
  matchedField: string | null;
  matchedValue: string | null;
  placeName: string | null;
  slotTitles: string | null;
  roleLabel: string | null;
  personLabel: string | null;
  sourceRow: Record<string, unknown>;
};

export type TutorialVerifyResult = {
  windowStart: string;
  windowEnd: string;
  sourceCount: number;
  auditCount: number;
  missingFromAudit: TutorialDeliveryKey[];
  extraInAudit: TutorialDeliveryKey[];
  diverged: boolean;
};

const NOTE_KEYS = [
  "slot_notes",
  "slot_titles",
  "place.name",
  "place.additional_info",
  "notes",
  "note",
  "comment",
  "comments",
  "activity",
  "activity.name",
  "description",
  "details",
  "topic",
  "subject",
  "title",
  "role.name",
  "assignment_type.name",
  "place_category.name",
  "extra_type.name",
  "extra_type.description",
];

function normaliseName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/^dr\.?\s+/, "")
    .replace(/[^a-z\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Compare the tutorial deliveries CLWRota reports for a window against the
 * rows the tutorial audit shows for the same window. Read-only: it never
 * writes rota data, so it is safe to run on a schedule after the backfill.
 */
export async function verifyTutorialWindow(opts: {
  startIso: string;
  endIso: string;
}): Promise<TutorialVerifyResult> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

  const { data: settings, error: settingsErr } = await supabaseAdmin
    .from("clwrota_sync_state")
    .select("rota_report_url")
    .eq("id", 1)
    .maybeSingle();
  if (settingsErr) throw new Error(settingsErr.message);
  const url = settings?.rota_report_url;
  if (!url) throw new Error("No rota report URL configured.");

  const apiKey = process.env["CLWROTA_API_KEY"] ?? "";
  if (!apiKey) throw new Error("CLWROTA_API_KEY is not configured.");

  const withFields = ensureRotaReportFields(url);
  const windowedUrl = explicitDateWindow(withFields, opts.startIso, opts.endIso);
  const text = await fetchReportRaw(
    windowedUrl || clampDateWindow(withFields, { daysBack: 0, daysAhead: 365 }),
    apiKey,
  );
  const { rows } = parseRows(text);

  // Consultant / SAS staff — the only grades whose tutorial delivery we audit.
  const profRes = await supabaseAdmin
    .from("profiles")
    .select("id,email,full_name,clwrota_external_id,grade")
    .in("grade", ["consultant", "sas"])
    .range(0, 9999);
  if (profRes.error) throw new Error(profRes.error.message);

  const byEmail = new Map<string, string>();
  const byExtId = new Map<string, string>();
  const byName = new Map<string, string>();
  const nameById = new Map<string, string>();
  for (const p of profRes.data ?? []) {
    if (p.email) byEmail.set(String(p.email).toLowerCase(), p.id);
    if (p.clwrota_external_id) byExtId.set(String(p.clwrota_external_id), p.id);
    if (p.full_name) byName.set(normaliseName(String(p.full_name)), p.id);
    nameById.set(p.id, String(p.full_name ?? p.email ?? p.id));
  }

  const source = new Map<string, TutorialDeliveryKey>();
  const evidence = new Map<string, TutorialSourceEvidence>();
  for (const row of rows) {
    const session_date = normaliseDate(
      pick(row, ["date", "session_date", "Date", "rota_date", "day"]) ?? null,
    );
    const session = normaliseSession(
      pick(row, [
        "session.rota_label",
        "shift.rota_label",
        "session.name",
        "shift.name",
        "session",
        "session_half",
        "half",
        "Session",
        "period",
        "shift",
        "time",
        "start_time",
      ]) ?? null,
    );
    if (!session_date || !session) continue;
    if (session_date < opts.startIso || session_date > opts.endIso) continue;

    const labels = NOTE_KEYS.map((k) => pick(row, [k]));
    if (!looksLikeTutorialLabel(labels)) continue;
    // Trainee attendee rows ("Tutorial (attending)") are not deliveries.
    if (labels.some((l) => l && /tutorial\s*\(attending\)/i.test(l))) continue;

    const email = pick(row, ["person.email", "email", "person_email", "Email"]);
    const extId = pick(row, [
      "person.local_id",
      "person.esr_employee_number",
      "person.assignment_number",
      "person_id",
      "local_id",
      "staff_id",
    ]);
    const nameRaw =
      pick(row, ["person.rota_name", "person", "person_name", "name", "staff", "Name", "full_name"]) ??
      [pick(row, ["person.first_name"]), pick(row, ["person.last_name"])]
        .filter(Boolean)
        .join(" ");

    const staffId =
      (email ? byEmail.get(email.toLowerCase()) : undefined) ??
      (extId ? byExtId.get(String(extId)) : undefined) ??
      (nameRaw ? byName.get(normaliseName(String(nameRaw))) : undefined);
    // Not a consultant/SAS profile we track — out of audit scope.
    if (!staffId) continue;

    const key = `${staffId}|${session_date}|${session}`;
    if (!source.has(key)) {
      source.set(key, {
        key,
        staffId,
        staffName: nameById.get(staffId) ?? String(nameRaw ?? staffId),
        session_date,
        session,
        label: labels.find((l) => l && looksLikeTutorialLabel([l])) ?? null,
      });
    }
  }

  // Audit side — the same rows the tutorials audit page shows.
  type AuditRow = {
    id: string;
    staff_id: string;
    session_date: string;
    session: string;
    duty_type: string;
    notes: string | null;
    role_on_list: string;
    extra_type: string | null;
    theatre_session_id: string | null;
  };
  const auditRows = await fetchAllPaged<AuditRow>(() =>
    supabaseAdmin
      .from("rota_assignments")
      .select(
        "id,staff_id,session_date,session,duty_type,notes,role_on_list,extra_type,theatre_session_id",
      )
      .in("duty_type", ["spa", "admin", "teaching"])
      .gte("session_date", opts.startIso)
      .lte("session_date", opts.endIso)
      .order("session_date", { ascending: true })
      .order("id", { ascending: true })
      .returns<AuditRow[]>(),
  );

  const theatreIds = Array.from(
    new Set(auditRows.map((r) => r.theatre_session_id).filter((v): v is string => Boolean(v))),
  );
  const theatreNames = new Map<string, string>();
  for (let i = 0; i < theatreIds.length; i += 500) {
    const res = await supabaseAdmin
      .from("theatre_sessions")
      .select("id,theatres(name)")
      .in("id", theatreIds.slice(i, i + 500));
    if (res.error) throw new Error(res.error.message);
    for (const s of res.data ?? []) {
      const joined = s.theatres as { name?: string | null } | null;
      if (joined?.name) theatreNames.set(s.id as string, joined.name);
    }
  }

  const audit = new Map<string, TutorialDeliveryKey>();
  for (const row of auditRows) {
    if (!nameById.has(row.staff_id)) continue;
    const theatreName = row.theatre_session_id
      ? theatreNames.get(row.theatre_session_id) ?? null
      : null;
    if (
      !isTutorialAuditCandidate({
        duty_type: row.duty_type,
        notes: row.notes,
        role_on_list: row.role_on_list,
        extra_type: row.extra_type,
        theatreName,
      })
    ) {
      continue;
    }
    const key = `${row.staff_id}|${row.session_date}|${row.session}`;
    if (!audit.has(key)) {
      audit.set(key, {
        key,
        staffId: row.staff_id,
        staffName: nameById.get(row.staff_id) ?? row.staff_id,
        session_date: row.session_date,
        session: row.session,
        label: row.notes ?? theatreName,
      });
    }
  }

  const missingFromAudit = Array.from(source.values()).filter((v) => !audit.has(v.key));
  const extraInAudit = Array.from(audit.values()).filter((v) => !source.has(v.key));

  return {
    windowStart: opts.startIso,
    windowEnd: opts.endIso,
    sourceCount: source.size,
    auditCount: audit.size,
    missingFromAudit: missingFromAudit.slice(0, 50),
    extraInAudit: extraInAudit.slice(0, 50),
    diverged: missingFromAudit.length > 0 || extraInAudit.length > 0,
  };
}
