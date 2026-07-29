import { looksLikeTutorialLabel } from "./parsing";
import { isTutorialAttendeeAssignment } from "./tutorial-audit";

export type TutorialBackfillResult = {
  windowStart: string;
  windowEnd: string;
  sourceRowsRefreshed: number;
  sourceAssignmentsInserted: number;
  sourceAssignmentsUpdated: number;
  scanned: number;
  promotedToTeaching: number;
  notesUpdated: number;
  skippedLocallyModified: number;
  skippedAttendee: number;
  sample: Array<{
    id: string;
    session_date: string;
    session: string;
    staff_id: string;
    fromDutyType: string;
    toDutyType: string;
    noteBefore: string | null;
    noteAfter: string | null;
  }>;
};

/**
 * Core tutorial backfill. Shared by the admin-triggered server function and
 * the scheduled `/api/public/hooks/tutorial-backfill` cron hook, so both paths
 * apply exactly the same detection and write rules.
 */
export async function runTutorialBackfill(opts: {
  startIso: string;
  endIso: string;
  dryRun?: boolean;
}): Promise<TutorialBackfillResult> {
  const dryRun = opts.dryRun ?? false;
  const { supabaseAdmin } = await import(
    "@/integrations/supabase/client.server"
  );

  let sourceRowsRefreshed = 0;
  let sourceAssignmentsInserted = 0;
  let sourceAssignmentsUpdated = 0;
  if (!dryRun) {
    const { performRotaSync } = await import("./sync.functions");
    const syncResult = await performRotaSync({
      from: opts.startIso,
      to: opts.endIso,
    });
    if (!syncResult.ok) {
      throw new Error(syncResult.message || "CLWRota refresh failed");
    }
    sourceRowsRefreshed = syncResult.total;
    sourceAssignmentsInserted = syncResult.assignmentsInserted;
    sourceAssignmentsUpdated = syncResult.assignmentsUpdated;
  }

  // Consultant/SAS profiles we're prepared to promote.
  const profRes = await supabaseAdmin
    .from("profiles")
    .select("id,grade")
    .in("grade", ["consultant", "sas"])
    .range(0, 9999);
  if (profRes.error) throw new Error(profRes.error.message);
  const eligibleStaff = new Set((profRes.data ?? []).map((p) => p.id as string));

  const rowsRes = await supabaseAdmin
    .from("rota_assignments")
    .select(
      "id,staff_id,session_date,session,duty_type,role_on_list,notes,extra_type,locally_modified",
    )
    .in("duty_type", ["spa", "admin", "teaching"])
    .gte("session_date", opts.startIso)
    .lte("session_date", opts.endIso)
    .range(0, 19999);
  if (rowsRes.error) throw new Error(rowsRes.error.message);

  const result: TutorialBackfillResult = {
    windowStart: opts.startIso,
    windowEnd: opts.endIso,
    sourceRowsRefreshed,
    sourceAssignmentsInserted,
    sourceAssignmentsUpdated,
    scanned: 0,
    promotedToTeaching: 0,
    notesUpdated: 0,
    skippedLocallyModified: 0,
    skippedAttendee: 0,
    sample: [],
  };

  for (const row of rowsRes.data ?? []) {
    if (!eligibleStaff.has(row.staff_id as string)) continue;
    result.scanned += 1;

    if (!looksLikeTutorialLabel([row.notes, row.role_on_list, row.extra_type])) {
      continue;
    }
    if (isTutorialAttendeeAssignment({ notes: row.notes })) {
      result.skippedAttendee += 1;
      continue;
    }
    if (row.locally_modified) {
      result.skippedLocallyModified += 1;
      continue;
    }

    const needsDutyChange = row.duty_type !== "teaching";
    const currentNote = (row.notes ?? "").trim();
    const hasTutorialPrefix = /^tutorial\s*:/i.test(currentNote);
    const labelSource =
      (row.notes && !hasTutorialPrefix ? row.notes : null) ??
      row.extra_type ??
      row.role_on_list ??
      "session";
    const newNote = hasTutorialPrefix
      ? currentNote
      : `Tutorial: ${labelSource.trim()}`;
    const needsNoteChange = newNote !== (row.notes ?? "");

    if (!needsDutyChange && !needsNoteChange) continue;

    if (result.sample.length < 20) {
      result.sample.push({
        id: row.id as string,
        session_date: row.session_date as string,
        session: row.session as string,
        staff_id: row.staff_id as string,
        fromDutyType: row.duty_type as string,
        toDutyType: needsDutyChange ? "teaching" : (row.duty_type as string),
        noteBefore: row.notes as string | null,
        noteAfter: needsNoteChange ? newNote : (row.notes as string | null),
      });
    }

    if (needsDutyChange) result.promotedToTeaching += 1;
    if (needsNoteChange) result.notesUpdated += 1;

    if (dryRun) continue;

    const patch: {
      duty_type?: "teaching";
      role_on_list?: "teaching";
      notes?: string;
    } = {};
    if (needsDutyChange) {
      patch.duty_type = "teaching";
      patch.role_on_list = "teaching";
    }
    if (needsNoteChange) patch.notes = newNote;

    const upd = await supabaseAdmin
      .from("rota_assignments")
      .update(patch)
      .eq("id", row.id as string);
    if (upd.error) throw new Error(upd.error.message);
  }

  return result;
}
