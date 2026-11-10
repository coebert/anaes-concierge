/**
 * Session reconciliation: CLWRota rows the import could not place on a
 * theatre list, side by side with theatre lists that have nobody linked.
 *
 * Built only from data the app already stores. What it can and can't say:
 *   - An unlinked CLWRota row of duty type "theatre" on the same date/half as
 *     an empty list is a CANDIDATE that may belong to that list — never an
 *     assumed match.
 *   - With a complete, fresh import and no candidate rows, the feed simply has
 *     nobody rostered for the list. The rota feed lists people, not sessions,
 *     so it cannot say whether the list was cancelled or ran uncovered.
 *   - If the week's import isn't confirmed complete and fresh, nothing is
 *     settled; re-import first.
 * Raw notes, titles and external IDs are never read here.
 */
import { pagedSelect } from "@/lib/paged-select";
import { isoWeekStart } from "@/features/clwrota/week-status-core";
import type { TimelineStatus, WeekStatusTimeline } from "@/features/audit/rota-week-status";
import type {
  ImportCoverageTimeline,
  ImportWeekState,
} from "@/features/audit/rota-sync-coverage";

export type RowHalf = "am" | "pm" | "eve" | "night";
export type ListHalf = "am" | "pm";

export interface ReconListInput {
  id: string;
  date: string;
  half: ListHalf;
  theatreName: string;
  theatreActive: boolean;
}

export interface ReconLinkedInput {
  theatreSessionId: string;
  source: "clwrota" | "manual";
}

export interface ReconUnlinkedInput {
  id: string;
  date: string;
  half: RowHalf;
  dutyType: string;
  role: string;
  staffId: string;
}

export type ListVerdict = "candidate_rows" | "import_unconfirmed" | "nobody_in_feed";

export interface EmptyListEntry {
  key: string;
  date: string;
  half: ListHalf;
  theatreName: string;
  weekStart: string;
  weekStatus: TimelineStatus | null;
  importState: ImportWeekState | null;
  /** Unlinked CLWRota rows classed as theatre work on the same date and half. */
  sameHalfTheatreRows: number;
  /** Unlinked CLWRota rows of any other duty type on the same date and half. */
  sameHalfOtherRows: number;
  verdict: ListVerdict;
}

export interface UnlinkedRowEntry extends ReconUnlinkedInput {
  weekStart: string;
  weekStatus: TimelineStatus | null;
  /** Number of active lists with nobody linked on the same date/half (am/pm only). */
  emptyListsSameHalf: number;
}

export interface SessionReconciliation {
  rangeStart: string;
  rangeEnd: string;
  emptyLists: EmptyListEntry[];
  unlinkedRows: UnlinkedRowEntry[];
  unlinkedByDuty: { dutyType: string; count: number }[];
  totals: {
    activeLists: number;
    listsWithClwrotaRows: number;
    listsWithManualRowsOnly: number;
    emptyLists: number;
    unlinkedRows: number;
    unlinkedTheatreRows: number;
    inactiveListsSkipped: number;
  };
}

/** Import states that confirm every day of the week was imported recently. */
const CONFIRMED_IMPORT: ReadonlySet<ImportWeekState> = new Set(["current"]);
const HALF_ORDER: Record<RowHalf, number> = { am: 0, pm: 1, eve: 2, night: 3 };

export const VERDICT_LABEL: Record<ListVerdict, string> = {
  candidate_rows: "Check unplaced rows",
  import_unconfirmed: "Import not confirmed",
  nobody_in_feed: "Nobody in the feed",
};

export function verdictHelp(e: EmptyListEntry): string {
  switch (e.verdict) {
    case "candidate_rows":
      return `${e.sameHalfTheatreRows} theatre row(s) this half weren't placed on any list. One may belong here — check them before deciding.`;
    case "import_unconfirmed":
      return "This week hasn't been fully imported in the last 48 hours, so the feed may have changed. Re-import, then check again.";
    case "nobody_in_feed":
      return "The latest complete import has nobody rostered for this list and no unplaced theatre rows this half. Only CLWRota can say whether the list was cancelled or is uncovered.";
  }
}

export function buildSessionReconciliation(input: {
  rangeStart: string;
  rangeEnd: string;
  lists: readonly ReconListInput[];
  linked: readonly ReconLinkedInput[];
  unlinked: readonly ReconUnlinkedInput[];
  weekStatus: WeekStatusTimeline | null;
  importCoverage: ImportCoverageTimeline | null;
}): SessionReconciliation {
  const { rangeStart, rangeEnd } = input;
  const inRange = (d: string) => d >= rangeStart && d <= rangeEnd;
  const statusFor = (w: string): TimelineStatus | null =>
    input.weekStatus ? (input.weekStatus.byWeek.get(w)?.status ?? "not_observed") : null;
  const importFor = (w: string): ImportWeekState | null =>
    input.importCoverage && input.importCoverage.capture === "available"
      ? (input.importCoverage.byWeek.get(w)?.state ?? "not_tracked")
      : null;

  const clwLinked = new Set<string>();
  const manualLinked = new Set<string>();
  for (const l of input.linked) {
    (l.source === "clwrota" ? clwLinked : manualLinked).add(l.theatreSessionId);
  }

  // Each row id once, in range only.
  const seenRow = new Set<string>();
  const unlinked = input.unlinked.filter((r) => {
    if (!inRange(r.date) || seenRow.has(r.id)) return false;
    seenRow.add(r.id);
    return true;
  });
  const theatreBySlot = new Map<string, number>();
  const otherBySlot = new Map<string, number>();
  for (const r of unlinked) {
    const k = `${r.date}|${r.half}`;
    const m = r.dutyType === "theatre" ? theatreBySlot : otherBySlot;
    m.set(k, (m.get(k) ?? 0) + 1);
  }

  const seenList = new Set<string>();
  let activeLists = 0;
  let inactive = 0;
  let withClw = 0;
  let manualOnly = 0;
  const emptyLists: EmptyListEntry[] = [];
  const emptyBySlot = new Map<string, number>();
  for (const l of input.lists) {
    if (!inRange(l.date) || seenList.has(l.id)) continue;
    seenList.add(l.id);
    if (!l.theatreActive) {
      inactive++;
      continue;
    }
    activeLists++;
    if (clwLinked.has(l.id)) {
      withClw++;
      continue;
    }
    if (manualLinked.has(l.id)) {
      manualOnly++;
      continue;
    }
    const slot = `${l.date}|${l.half}`;
    emptyBySlot.set(slot, (emptyBySlot.get(slot) ?? 0) + 1);
    const weekStart = isoWeekStart(l.date);
    const importState = importFor(weekStart);
    const sameHalfTheatreRows = theatreBySlot.get(slot) ?? 0;
    const verdict: ListVerdict =
      sameHalfTheatreRows > 0
        ? "candidate_rows"
        : importState && CONFIRMED_IMPORT.has(importState)
          ? "nobody_in_feed"
          : "import_unconfirmed";
    emptyLists.push({
      key: `${l.date}-${l.half}-${l.theatreName}-${l.id}`,
      date: l.date,
      half: l.half,
      theatreName: l.theatreName,
      weekStart,
      weekStatus: statusFor(weekStart),
      importState,
      sameHalfTheatreRows,
      sameHalfOtherRows: otherBySlot.get(slot) ?? 0,
      verdict,
    });
  }
  emptyLists.sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      HALF_ORDER[a.half] - HALF_ORDER[b.half] ||
      a.theatreName.localeCompare(b.theatreName) ||
      a.key.localeCompare(b.key),
  );

  const unlinkedRows: UnlinkedRowEntry[] = unlinked
    .map((r) => {
      const weekStart = isoWeekStart(r.date);
      return {
        ...r,
        weekStart,
        weekStatus: statusFor(weekStart),
        emptyListsSameHalf: emptyBySlot.get(`${r.date}|${r.half}`) ?? 0,
      };
    })
    .sort(
      (a, b) =>
        a.date.localeCompare(b.date) ||
        HALF_ORDER[a.half] - HALF_ORDER[b.half] ||
        a.dutyType.localeCompare(b.dutyType) ||
        a.id.localeCompare(b.id),
    );

  const dutyCounts = new Map<string, number>();
  for (const r of unlinked) dutyCounts.set(r.dutyType, (dutyCounts.get(r.dutyType) ?? 0) + 1);
  const unlinkedByDuty = [...dutyCounts.entries()]
    .map(([dutyType, count]) => ({ dutyType, count }))
    .sort((a, b) => b.count - a.count || a.dutyType.localeCompare(b.dutyType));

  return {
    rangeStart,
    rangeEnd,
    emptyLists,
    unlinkedRows,
    unlinkedByDuty,
    totals: {
      activeLists,
      listsWithClwrotaRows: withClw,
      listsWithManualRowsOnly: manualOnly,
      emptyLists: emptyLists.length,
      unlinkedRows: unlinked.length,
      unlinkedTheatreRows: unlinked.filter((r) => r.dutyType === "theatre").length,
      inactiveListsSkipped: inactive,
    },
  };
}

export interface ReconciliationInputs {
  lists: ReconListInput[];
  linked: ReconLinkedInput[];
  unlinked: ReconUnlinkedInput[];
  staff: Map<string, { name: string; grade: string | null }>;
}

/**
 * Complete paged reads for the window. Any page error or overflow throws,
 * so the screen shows Retry instead of a short list.
 */
export async function loadReconciliationInputs(
  rangeStart: string,
  rangeEnd: string,
): Promise<ReconciliationInputs> {
  const [theatres, sessions, linkedRows, unlinkedRows] = await Promise.all([
    pagedSelect<{ id: string; name: string; active: boolean }>("theatres", "id,name,active", {
      order: ["id"],
      source: "theatres",
    }),
    pagedSelect<{ id: string; session_date: string; session: string; theatre_id: string }>(
      "theatre_sessions",
      "id,session_date,session,theatre_id",
      {
        filter: (q) =>
          q.gte("session_date", rangeStart).lte("session_date", rangeEnd).in("session", ["am", "pm"]),
        order: ["session_date", "id"],
        source: "theatre_sessions",
      },
    ),
    pagedSelect<{ id: string; theatre_session_id: string; source: "clwrota" | "manual" }>(
      "rota_assignments",
      "id,theatre_session_id,source",
      {
        filter: (q) =>
          q
            .gte("session_date", rangeStart)
            .lte("session_date", rangeEnd)
            .not("theatre_session_id", "is", null),
        order: ["session_date", "id"],
        source: "rota_assignments (linked)",
      },
    ),
    pagedSelect<{
      id: string;
      session_date: string;
      session: RowHalf;
      duty_type: string;
      role_on_list: string;
      staff_id: string;
    }>("rota_assignments", "id,session_date,session,duty_type,role_on_list,staff_id", {
      filter: (q) =>
        q
          .gte("session_date", rangeStart)
          .lte("session_date", rangeEnd)
          .eq("source", "clwrota")
          .is("theatre_session_id", null),
      order: ["session_date", "id"],
      source: "rota_assignments (unlinked)",
    }),
  ]);

  const staffIds = [...new Set(unlinkedRows.map((r) => r.staff_id))];
  const staff = new Map<string, { name: string; grade: string | null }>();
  for (let i = 0; i < staffIds.length; i += 100) {
    const chunk = staffIds.slice(i, i + 100);
    const rows = await pagedSelect<{ id: string; full_name: string; grade: string | null }>(
      "profiles",
      "id,full_name,grade",
      { filter: (q) => q.in("id", chunk), order: ["id"], source: "profiles" },
    );
    for (const p of rows) staff.set(p.id, { name: p.full_name, grade: p.grade });
  }

  const theatreById = new Map(theatres.map((t) => [t.id, t]));
  return {
    lists: sessions
      .filter((s) => s.session === "am" || s.session === "pm")
      .map((s) => {
        const t = theatreById.get(s.theatre_id);
        return {
          id: s.id,
          date: s.session_date,
          half: s.session as ListHalf,
          theatreName: t?.name ?? "Unknown theatre",
          theatreActive: t?.active ?? false,
        };
      }),
    linked: linkedRows.map((r) => ({ theatreSessionId: r.theatre_session_id, source: r.source })),
    unlinked: unlinkedRows.map((r) => ({
      id: r.id,
      date: r.session_date,
      half: r.session,
      dutyType: r.duty_type,
      role: r.role_on_list,
      staffId: r.staff_id,
    })),
    staff,
  };
}
