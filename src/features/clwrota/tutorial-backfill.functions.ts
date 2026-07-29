import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
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
 * Re-apply the current tutorial-detection logic to rota_assignments that were
 * synced BEFORE the detection was widened. This is a one-click backfill: a
 * fresh CLWRota sync would eventually correct the same rows, but only when the
 * upstream row is re-fetched — the audit stays empty in the meantime.
 *
 * For every non-locally-modified assignment in the window whose staff is a
 * Consultant/SAS and whose free-text (notes/role_on_list/extra_type) matches
 * `looksLikeTutorialLabel`, we:
 *   - promote duty_type → 'teaching' and role_on_list → 'teaching'
 *   - ensure the notes column carries the "Tutorial: …" prefix the audit uses
 * Attendee rows ("Tutorial (attending): …") are left untouched.
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

    const { supabaseAdmin } = await import(
      "@/integrations/supabase/client.server"
    );

    let sourceRowsRefreshed = 0;
    let sourceAssignmentsInserted = 0;
    let sourceAssignmentsUpdated = 0;
    if (!data.dryRun) {
      const { performRotaSync } = await import("./sync.functions");
      const syncResult = await performRotaSync({
        from: data.startIso,
        to: data.endIso,
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
    const eligibleStaff = new Set(
      (profRes.data ?? []).map((p) => p.id as string),
    );

    // Candidate rows: SPA/admin/teaching only. We deliberately do NOT touch
    // theatre / on-call rows — the detection change is about tutorial-vs-SPA
    // classification, not about rewriting clinical duty types.
    const rowsRes = await supabaseAdmin
      .from("rota_assignments")
      .select(
        "id,staff_id,session_date,session,duty_type,role_on_list,notes,extra_type,locally_modified",
      )
      .in("duty_type", ["spa", "admin", "teaching"])
      .gte("session_date", data.startIso)
      .lte("session_date", data.endIso)
      .range(0, 19999);
    if (rowsRes.error) throw new Error(rowsRes.error.message);

    const result: TutorialBackfillResult = {
      windowStart: data.startIso,
      windowEnd: data.endIso,
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

      if (data.dryRun) continue;

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
  });
