// Server-only: live comparison of intensive-care (ICU) sessions between the
// CLWRota source report and the rows the ICU audit reads from
// `rota_assignments`.
//
// The audit page counts ICU activity out of synced `rota_assignments` rows.
// This module re-fetches the CLWRota report for the same window, classifies
// each row with the same admin-configured duty-type mappings the sync uses,
// and diffs the two sets so an admin can see exactly which sessions are
// missing or extra. Read-only — it never writes rota data.
import {
  classifyDutyType,
  ensureRotaReportFields,
  explicitDateWindow,
  fetchReportRaw,
  normaliseDate,
  normaliseSession,
  parsePaCredit,
  parseRows,
  pick,
  splitPersonNames,
} from "@/features/clwrota/parsing";
import { loadDutyTypeMappings } from "@/features/clwrota/parsing.server";
import { fetchAllPaged } from "@/lib/supabase-chunked";
import { ICU_DUTY_TYPES } from "./icu-workload";

export type IcuSessionKey = {
  key: string;
  staffId: string;
  staffName: string;
  session_date: string;
  session: string;
  dutyType: string;
  label: string | null;
};

export type IcuStaffCompareRow = {
  staffId: string;
  staffName: string;
  sourceCount: number;
  auditCount: number;
  diff: number;
};

export type IcuVerifyResult = {
  windowStart: string;
  windowEnd: string;
  sourceCount: number;
  auditCount: number;
  missingFromAudit: IcuSessionKey[];
  extraInAudit: IcuSessionKey[];
  byStaff: IcuStaffCompareRow[];
  diverged: boolean;
};

const LABEL_KEYS = [
  "slot_titles",
  "slot_notes",
  "place.name",
  "role.name",
  "assignment_type.name",
  "specialty.name",
  "notes",
  "activity",
  "activity.name",
  "description",
];

function normaliseName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/^(dr|mr|mrs|ms|miss|prof)\.?\s+/, "")
    .replace(/[^a-z\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Surname-only match against normalised profile names, used only when the
 * surname belongs to exactly one consultant/SAS doctor. */
function bySurnameUnique(norm: string, byName: Map<string, string>): string | undefined {
  const parts = norm.split(" ").filter(Boolean);
  const surname = parts[parts.length - 1];
  if (!surname) return undefined;
  const initial = parts.length > 1 ? parts[0][0] : null;
  const matches: string[] = [];
  for (const [name, id] of byName) {
    const np = name.split(" ").filter(Boolean);
    if (np[np.length - 1] !== surname) continue;
    if (initial && !(np[0] ?? "").startsWith(initial)) continue;
    matches.push(id);
  }
  return matches.length === 1 ? matches[0] : undefined;
}

export async function verifyIcuWindow(opts: {
  startIso: string;
  endIso: string;
}): Promise<IcuVerifyResult> {
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

  // Consultant / SAS staff only — the grades whose ICU PAs the audit tracks.
  const profRes = await supabaseAdmin
    .from("profiles")
    .select("id,email,full_name,clwrota_external_id,grade,training_level")
    .in("grade", ["consultant", "sas"])
    .range(0, 9999);
  if (profRes.error) throw new Error(profRes.error.message);
  const profiles = profRes.data ?? [];

  const byEmail = new Map<string, string>();
  const byExtId = new Map<string, string>();
  const byName = new Map<string, string>();
  const nameById = new Map<string, string>();
  const profById = new Map<string, { grade: string | null; training_level: string | null }>();
  for (const p of profiles) {
    if (p.email) byEmail.set(String(p.email).toLowerCase(), p.id);
    if (p.clwrota_external_id) byExtId.set(String(p.clwrota_external_id), p.id);
    if (p.full_name) byName.set(normaliseName(String(p.full_name)), p.id);
    nameById.set(p.id, String(p.full_name ?? p.email ?? p.id));
    profById.set(p.id, { grade: p.grade ?? null, training_level: p.training_level ?? null });
  }

  const dutyMappings = await loadDutyTypeMappings();

  const windowedUrl = explicitDateWindow(
    ensureRotaReportFields(url),
    opts.startIso,
    opts.endIso,
  );
  const text = await fetchReportRaw(windowedUrl, apiKey);
  const { rows } = parseRows(text);

  const icuTypes = new Set<string>(ICU_DUTY_TYPES);
  const source = new Map<string, IcuSessionKey>();

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
      pick(row, [
        "person.rota_name",
        "person",
        "person_name",
        "name",
        "staff",
        "Name",
        "full_name",
      ]) ??
      [pick(row, ["person.first_name"]), pick(row, ["person.last_name"])]
        .filter(Boolean)
        .join(" ");

    const staffId =
      (email ? byEmail.get(email.toLowerCase()) : undefined) ??
      (extId ? byExtId.get(String(extId)) : undefined) ??
      (nameRaw ? byName.get(normaliseName(String(nameRaw))) : undefined);
    if (!staffId) continue;

    const labels = LABEL_KEYS.map((k) => pick(row, [k]));
    const prof = profById.get(staffId);
    const dutyType = classifyDutyType(
      labels,
      prof?.grade,
      prof?.training_level,
      dutyMappings,
    );
    if (!icuTypes.has(dutyType)) continue;

    // ICU rows can name several consultants in the slot text ("Dr Hogan &
    // Dr Coe"); the audit credits each of them, so the comparison keys must
    // expand the same way. Mirror the sync's attendee extraction.
    const slotText = pick(row, ["slot_titles", "consultant", "Consultant"]);
    const attendees = new Set<string>([staffId]);
    for (const fragment of splitPersonNames(slotText)) {
      const norm = normaliseName(fragment);
      if (!norm) continue;
      const match =
        byName.get(norm) ??
        byName.get(`dr ${norm}`.replace(/\s+/g, " ").trim()) ??
        bySurnameUnique(norm, byName);
      if (match) attendees.add(match);
    }

    const pa = parsePaCredit(row);
    const baseLabel = labels.find((l) => l && l.trim() !== "") ?? null;
    const label = pa != null ? `${baseLabel ?? "ICU"} (${pa} PA)` : baseLabel;
    for (const id of attendees) {
      const key = `${id}|${session_date}|${session}`;
      if (source.has(key)) continue;
      source.set(key, {
        key,
        staffId: id,
        staffName: nameById.get(id) ?? String(nameRaw ?? id),
        session_date,
        session,
        dutyType,
        label,
      });
    }
  }

  // Audit side: what the ICU audit page counts for the same window.
  const auditRows = await fetchAllPaged<{
    staff_id: string;
    session_date: string;
    session: string;
    duty_type: string;
    attending_consultant_ids: string[] | null;
  }>(() =>
    supabaseAdmin
      .from("rota_assignments")
      .select("staff_id,session_date,session,duty_type,attending_consultant_ids")
      .gte("session_date", opts.startIso)
      .lte("session_date", opts.endIso)
      .in("duty_type", [...ICU_DUTY_TYPES])
      .order("session_date", { ascending: true })
      .order("staff_id", { ascending: true }),
  );

  const audit = new Map<string, IcuSessionKey>();
  for (const r of auditRows) {
    if (!nameById.has(r.staff_id)) continue; // non consultant/SAS — out of scope
    // Credit every attending consultant stored on the row, exactly as the
    // ICU audit tally does, so the comparison is apples-to-apples.
    const credited =
      r.attending_consultant_ids && r.attending_consultant_ids.length > 0
        ? r.attending_consultant_ids
        : [r.staff_id];
    for (const id of credited) {
      if (!nameById.has(id)) continue;
      const key = `${id}|${r.session_date}|${r.session}`;
      if (audit.has(key)) continue;
      audit.set(key, {
        key,
        staffId: id,
        staffName: nameById.get(id) ?? id,
        session_date: r.session_date,
        session: r.session,
        dutyType: r.duty_type,
        label: null,
      });
    }
  }

  const missingFromAudit = [...source.values()]
    .filter((s) => !audit.has(s.key))
    .sort((a, b) => a.session_date.localeCompare(b.session_date));
  const extraInAudit = [...audit.values()]
    .filter((a) => !source.has(a.key))
    .sort((a, b) => a.session_date.localeCompare(b.session_date));

  const staffTally = new Map<string, IcuStaffCompareRow>();
  const bump = (id: string, field: "sourceCount" | "auditCount") => {
    let row = staffTally.get(id);
    if (!row) {
      row = {
        staffId: id,
        staffName: nameById.get(id) ?? id,
        sourceCount: 0,
        auditCount: 0,
        diff: 0,
      };
      staffTally.set(id, row);
    }
    row[field] += 1;
  };
  for (const s of source.values()) bump(s.staffId, "sourceCount");
  for (const a of audit.values()) bump(a.staffId, "auditCount");
  const byStaff = [...staffTally.values()]
    .map((r) => ({ ...r, diff: r.sourceCount - r.auditCount }))
    .sort(
      (a, b) =>
        Math.abs(b.diff) - Math.abs(a.diff) ||
        b.sourceCount - a.sourceCount ||
        a.staffName.localeCompare(b.staffName),
    );

  return {
    windowStart: opts.startIso,
    windowEnd: opts.endIso,
    sourceCount: source.size,
    auditCount: audit.size,
    missingFromAudit,
    extraInAudit,
    byStaff,
    diverged: missingFromAudit.length > 0 || extraInAudit.length > 0,
  };
}
