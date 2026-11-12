import { describe, expect, it } from "vitest";
import { selectRemovedAssignments, type StoredClwrotaRow } from "./removed-assignments";

const row = (id: string, ext: string | null, date: string, o: Partial<StoredClwrotaRow> = {}) => ({
  id,
  clwrota_external_id: ext,
  session_date: date,
  source: "clwrota",
  locally_modified: false,
  ...o,
});
const base = {
  window: { from: "2030-01-01", to: "2030-01-31" },
  observedDates: new Set(["2030-01-07", "2030-01-08"]),
  uncertainDates: new Set<string>(),
  runUncertain: false,
  minAllowed: 2,
  notBefore: "2030-01-01",
};
// 20 rows still in the feed so the share guard is not the thing under test.
const present = Array.from({ length: 20 }, (_, i) => row(`p${i}`, `k${i}`, "2030-01-07"));
const feedKeys = new Set(present.map((r) => r.clwrota_external_id!));

describe("selectRemovedAssignments", () => {
  it("removes a stored row whose key the feed no longer carries on an observed date", () => {
    const r = selectRemovedAssignments({
      ...base,
      feedKeys,
      stored: [...present, row("gone", "x|2030-01-07|am", "2030-01-07")],
    });
    expect(r.guard).toBe("ok");
    expect(r.remove).toEqual(["gone"]);
  });

  it("keeps a row whose key is still in the feed, even as a non-working row", () => {
    const keys = new Set([...feedKeys, "off|2030-01-07|pm"]);
    const r = selectRemovedAssignments({
      ...base,
      feedKeys: keys,
      stored: [...present, row("off", "off|2030-01-07|pm", "2030-01-07")],
    });
    expect(r.remove).toEqual([]);
  });

  it("never removes a locally edited row or a manual row", () => {
    const r = selectRemovedAssignments({
      ...base,
      feedKeys,
      stored: [
        ...present,
        row("edited", "e", "2030-01-07", { locally_modified: true }),
        row("manual", null, "2030-01-07", { source: "manual" }),
      ],
    });
    expect(r.remove).toEqual([]);
    expect(r.keptLocallyModified).toBe(1);
  });

  it("does not treat a date with no feed rows at all as a removal", () => {
    const r = selectRemovedAssignments({
      ...base,
      feedKeys,
      stored: [...present, row("d9", "z", "2030-01-09")],
    });
    expect(r.remove).toEqual([]);
  });

  it("does not remove outside the requested window", () => {
    const r = selectRemovedAssignments({
      ...base,
      observedDates: new Set([...base.observedDates, "2030-02-03"]),
      feedKeys,
      stored: [...present, row("late", "z", "2030-02-03")],
    });
    expect(r.remove).toEqual([]);
  });

  it("keeps rows on a date where a row was skipped (unmatched staff, bad session)", () => {
    const r = selectRemovedAssignments({
      ...base,
      uncertainDates: new Set(["2030-01-08"]),
      feedKeys,
      stored: [...present, row("u", "z", "2030-01-08")],
    });
    expect(r.remove).toEqual([]);
    expect(r.keptUncertainDate).toBe(1);
  });

  it("removes nothing when the run itself was uncertain or had no window", () => {
    const stored = [...present, row("gone", "z", "2030-01-07")];
    expect(selectRemovedAssignments({ ...base, runUncertain: true, feedKeys, stored }).guard).toBe(
      "run_uncertain",
    );
    expect(selectRemovedAssignments({ ...base, window: null, feedKeys, stored }).remove).toEqual(
      [],
    );
  });

  it("refuses the whole removal when an implausible share would go (truncated feed)", () => {
    const stored = [
      ...present,
      ...Array.from({ length: 5 }, (_, i) => row(`g${i}`, `gone${i}`, "2030-01-08")),
    ];
    const r = selectRemovedAssignments({ ...base, feedKeys, stored, maxFraction: 0.1 });
    expect(r.guard).toBe("too_many");
    expect(r.remove).toEqual([]);
  });

  it("keeps and counts rows before today instead of removing history", () => {
    const r = selectRemovedAssignments({
      ...base,
      notBefore: "2030-01-08",
      feedKeys,
      stored: [...present, row("past", "z", "2030-01-07")],
    });
    expect(r.remove).toEqual([]);
    expect(r.absentPast).toBe(1);
  });

  it("is idempotent: once removed, a re-run with the same feed removes nothing more", () => {
    const first = selectRemovedAssignments({
      ...base,
      feedKeys,
      stored: [...present, row("gone", "z", "2030-01-07")],
    });
    const after = [...present];
    const second = selectRemovedAssignments({ ...base, feedKeys, stored: after });
    expect(first.remove).toEqual(["gone"]);
    expect(second.remove).toEqual([]);
  });
});
