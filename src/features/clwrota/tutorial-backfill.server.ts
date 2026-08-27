import { looksLikeTutorialLabel } from "./parsing";
import {
  getTutorialEvidenceLabel,
  isTutorialAttendeeAssignment,
} from "./tutorial-audit";
import { fetchAllPaged } from "@/lib/supabase-chunked";

type BackfillAssignmentRow = {
  id: string;
  staff_id: string;
  session_date: string;
  session: string;
  duty_type: string;
  role_on_list: string;
  notes: string | null;
  extra_type: string | null;
  locally_modified: boolean;
  theatre_session_id: string | null;
};

type SyncSummary = {
  total: number;
  assignmentsInserted: number;
  assignmentsUpdated: number;
  truncated: boolean;
};

const DAY_MS = 24 * 60 * 60 * 1000;

function parseIsoDate(value: string): Date {
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid date: ${value}`);
  }
  return date;
}

function formatIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Every slice re-downloads and re-parses the full CLWRota report (the
 * upstream endpoint ignores the date params), so the number of slices per
 * request must stay small — otherwise an admin-triggered backfill over a
 * 12-month window fires ~57 full syncs inside one request and hangs or
 * blows the Worker limits. Slices are wide (28d) and capped (`maxSlices`).
 */
const DEFAULT_REFRESH_SLICE_DAYS = 28;
const DEFAULT_MAX_REFRESH_SLICES = 3;

async function refreshSourceRowsInSlices(opts: {
  startIso: string;
  endIso: string;
  sliceDays?: number;
  maxSlices?: number;
}): Promise<SyncSummary> {
  const { performRotaSync } = await import("./sync.functions");
  const sliceDays = Math.max(1, opts.sliceDays ?? DEFAULT_REFRESH_SLICE_DAYS);
  const maxSlices = Math.max(1, opts.maxSlices ?? DEFAULT_MAX_REFRESH_SLICES);
  let slices = 0;
  const start = parseIsoDate(opts.startIso);
  const end = parseIsoDate(opts.endIso);
  const summary: SyncSummary = {
    total: 0,
    assignmentsInserted: 0,
    assignmentsUpdated: 0,
    truncated: false,
  };


  for (let cursorMs = start.getTime(); cursorMs <= end.getTime(); ) {
    if (slices >= maxSlices) {
      summary.truncated = true;
      break;
    }
    slices += 1;
    const sliceStart = new Date(cursorMs);
    const sliceEnd = new Date(
      Math.min(end.getTime(), cursorMs + (sliceDays - 1) * DAY_MS),
    );
    const from = formatIsoDate(sliceStart);
    const to = formatIsoDate(sliceEnd);
    const syncResult = await performRotaSync({ from, to });
    if (!syncResult.ok) {
      throw new Error(syncResult.message || `CLWRota refresh failed for ${from}..${to}`);
    }
    summary.total += syncResult.total;
    summary.assignmentsInserted += syncResult.assignmentsInserted;
    summary.assignmentsUpdated += syncResult.assignmentsUpdated;
    cursorMs = sliceEnd.getTime() + DAY_MS;
  }

  return summary;
}

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
    const syncResult = await refreshSourceRowsInSlices({
      startIso: opts.startIso,
      endIso: opts.endIso,
    });
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

  const assignmentSelect: string =
    "id,staff_id,session_date,session,duty_type,role_on_list,notes,extra_type,locally_modified,theatre_session_id";
  const rows = await fetchAllPaged<BackfillAssignmentRow>(() =>
    supabaseAdmin
      .from("rota_assignments")
      .select(assignmentSelect)
      .in("duty_type", ["spa", "admin", "teaching"])
      .gte("session_date", opts.startIso)
      .lte("session_date", opts.endIso)
      .order("session_date", { ascending: true })
      .order("id", { ascending: true })
      .returns<BackfillAssignmentRow[]>(),
  );

  const theatreSessionIds = Array.from(
    new Set(
      rows
        .map((row) => row.theatre_session_id as string | null)
        .filter((id): id is string => Boolean(id)),
    ),
  );
  const theatreNames = new Map<string, string>();
  for (let i = 0; i < theatreSessionIds.length; i += 500) {
    const ids = theatreSessionIds.slice(i, i + 500);
    const theatreRes = await supabaseAdmin
      .from("theatre_sessions")
      .select("id,theatres(name)")
      .in("id", ids);
    if (theatreRes.error) throw new Error(theatreRes.error.message);
    for (const session of theatreRes.data ?? []) {
      const joined = session.theatres as { name?: string | null } | null;
      if (joined?.name) theatreNames.set(session.id as string, joined.name);
    }
  }

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

  for (const row of rows) {
    if (!eligibleStaff.has(row.staff_id as string)) continue;
    result.scanned += 1;

    const theatreName = row.theatre_session_id
      ? theatreNames.get(row.theatre_session_id as string) ?? null
      : null;
    const tutorialEvidence = getTutorialEvidenceLabel({
      notes: row.notes,
      role_on_list: row.role_on_list,
      extra_type: row.extra_type,
      theatreName,
    });
    if (!looksLikeTutorialLabel([tutorialEvidence])) {
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
      tutorialEvidence ??
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
