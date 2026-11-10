import { describe, it, expect } from "vitest";
import {
  buildSessionReconciliation,
  type ReconListInput,
  type ReconUnlinkedInput,
} from "./session-reconciliation";
import { buildImportCoverageTimeline, type SyncCoverageRow } from "@/features/audit/rota-sync-coverage";
import { buildWeekStatusTimeline } from "@/features/audit/rota-week-status";

// Synthetic only — no real rota, staff or list data.
const NOW = new Date("2030-01-10T12:00:00Z");
const RANGE = { rangeStart: "2030-01-07", rangeEnd: "2030-01-20" };

const list = (id: string, date: string, half: "am" | "pm", theatreName = "Endo", active = true): ReconListInput => ({
  id,
  date,
  half,
  theatreName,
  theatreActive: active,
});
const row = (
  id: string,
  date: string,
  half: ReconUnlinkedInput["half"],
  dutyType = "theatre",
): ReconUnlinkedInput => ({ id, date, half, dutyType, role: "solo", staffId: `s-${id}` });

const cov = (week_start: string, ok: boolean, at = "2030-01-10T06:00:00Z"): SyncCoverageRow => ({
  week_start,
  days_total: 7,
  days_ok: ok ? 7 : 3,
  days_partial_only: 0,
  days_latest_not_ok: 0,
  last_full_ok_at: ok ? at : null,
  newest_ok_at: at,
  latest_attempt_at: at,
  latest_attempt_outcome: "ok",
  tracking_since: "2030-01-01T00:00:00Z",
});
const importTimeline = (rows: SyncCoverageRow[]) =>
  buildImportCoverageTimeline({ ...RANGE, rows, capture: "available", now: NOW });
const weekTimeline = buildWeekStatusTimeline({ ...RANGE, rows: [], capture: "available", now: NOW });

describe("buildSessionReconciliation", () => {
  it("a list with nobody linked and a theatre row unplaced on the same half is a candidate, not a match", () => {
    const r = buildSessionReconciliation({
      ...RANGE,
      lists: [list("L1", "2030-01-08", "am")],
      linked: [],
      unlinked: [row("r1", "2030-01-08", "am"), row("r2", "2030-01-08", "pm")],
      weekStatus: weekTimeline,
      importCoverage: importTimeline([cov("2030-01-07", true)]),
    });
    expect(r.emptyLists).toHaveLength(1);
    expect(r.emptyLists[0].verdict).toBe("candidate_rows");
    expect(r.emptyLists[0].sameHalfTheatreRows).toBe(1);
    expect(r.unlinkedRows.find((u) => u.id === "r1")?.emptyListsSameHalf).toBe(1);
    expect(r.unlinkedRows.find((u) => u.id === "r2")?.emptyListsSameHalf).toBe(0);
  });

  it("non-theatre unplaced rows (on-call, admin) never make a list a candidate", () => {
    const r = buildSessionReconciliation({
      ...RANGE,
      lists: [list("L1", "2030-01-08", "am")],
      linked: [],
      unlinked: [row("r1", "2030-01-08", "am", "registrar_oncall"), row("r2", "2030-01-08", "am", "admin")],
      weekStatus: weekTimeline,
      importCoverage: importTimeline([cov("2030-01-07", true)]),
    });
    expect(r.emptyLists[0].verdict).toBe("nobody_in_feed");
    expect(r.emptyLists[0].sameHalfOtherRows).toBe(2);
  });

  it("with no confirmed complete, fresh import the list is never settled as 'nobody in the feed'", () => {
    const base = { ...RANGE, lists: [list("L1", "2030-01-15", "pm")], linked: [], unlinked: [], weekStatus: weekTimeline };
    // Partial week import.
    expect(
      buildSessionReconciliation({ ...base, importCoverage: importTimeline([cov("2030-01-14", false)]) })
        .emptyLists[0].verdict,
    ).toBe("import_unconfirmed");
    // Week never tracked.
    expect(
      buildSessionReconciliation({ ...base, importCoverage: importTimeline([]) }).emptyLists[0].verdict,
    ).toBe("import_unconfirmed");
    // Complete but older than 48 hours.
    expect(
      buildSessionReconciliation({
        ...base,
        importCoverage: importTimeline([cov("2030-01-14", true, "2030-01-07T00:00:00Z")]),
      }).emptyLists[0].verdict,
    ).toBe("import_unconfirmed");
    // Coverage tracking unavailable.
    expect(buildSessionReconciliation({ ...base, importCoverage: null }).emptyLists[0].verdict).toBe(
      "import_unconfirmed",
    );
  });

  it("lists with CLWRota or manual rows are not empty; inactive theatres are skipped and counted", () => {
    const r = buildSessionReconciliation({
      ...RANGE,
      lists: [
        list("L1", "2030-01-08", "am"),
        list("L2", "2030-01-08", "pm"),
        list("L3", "2030-01-09", "am"),
        list("L4", "2030-01-09", "am", "Old room", false),
      ],
      linked: [
        { theatreSessionId: "L1", source: "clwrota" },
        { theatreSessionId: "L1", source: "clwrota" },
        { theatreSessionId: "L2", source: "manual" },
      ],
      unlinked: [],
      weekStatus: weekTimeline,
      importCoverage: importTimeline([cov("2030-01-07", true)]),
    });
    expect(r.emptyLists.map((e) => e.key.split("-").pop())).toEqual(["L3"]);
    expect(r.totals).toMatchObject({
      activeLists: 3,
      listsWithClwrotaRows: 1,
      listsWithManualRowsOnly: 1,
      emptyLists: 1,
      inactiveListsSkipped: 1,
    });
  });

  it("drops out-of-range and repeated rows, and counts unplaced rows by duty type", () => {
    const r = buildSessionReconciliation({
      ...RANGE,
      lists: [],
      linked: [],
      unlinked: [
        row("a", "2030-01-08", "am"),
        row("a", "2030-01-08", "am"),
        row("b", "2030-01-08", "night", "registrar_oncall"),
        row("c", "2030-01-09", "eve", "registrar_oncall"),
        row("d", "2030-02-01", "am"),
      ],
      weekStatus: null,
      importCoverage: null,
    });
    expect(r.totals.unlinkedRows).toBe(3);
    expect(r.totals.unlinkedTheatreRows).toBe(1);
    expect(r.unlinkedByDuty).toEqual([
      { dutyType: "registrar_oncall", count: 2 },
      { dutyType: "theatre", count: 1 },
    ]);
    expect(r.unlinkedRows[0].weekStatus).toBeNull();
  });
});
