import { describe, it, expect } from "vitest";
import {
  buildSyncWindowRecord,
  classifySyncOutcome,
  persistSyncWindow,
  resolveRequestedWindow,
  type SyncWindowRecord,
} from "./sync-windows";

// Synthetic rows only.
const rows = (dates: string[]) => dates.map((d) => ({ date: d, session: "AM" }));
const req = { from: "2030-01-07", to: "2030-01-20", explicit: true };
const t0 = new Date("2030-01-01T10:00:00Z");
const t1 = new Date("2030-01-01T10:05:00Z");

describe("resolveRequestedWindow", () => {
  it("explicit slice is kept as-is", () => {
    expect(
      resolveRequestedWindow({ from: "2030-01-07", to: "2030-01-13", daysBack: 30, daysAhead: 120, now: t0 }),
    ).toEqual({ from: "2030-01-07", to: "2030-01-13", explicit: true });
  });
  it("default window is today−back … today+ahead in UTC", () => {
    expect(
      resolveRequestedWindow({ daysBack: 30, daysAhead: 120, now: new Date("2030-01-31T23:30:00Z") }),
    ).toEqual({ from: "2030-01-01", to: "2030-05-31", explicit: false });
  });
});

describe("classifySyncOutcome / buildSyncWindowRecord", () => {
  it("clean run → ok, covered = first..last row date inside the request", () => {
    const r = buildSyncWindowRecord({
      startedAt: t0,
      finishedAt: t1,
      requested: req,
      threw: false,
      rows: rows(["2030-01-09", "2030-01-07", "2030-01-15", "2031-06-01"]),
      skipped: 2,
      writeErrors: 0,
    });
    expect(r).toMatchObject({
      outcome: "ok",
      requested_from: "2030-01-07",
      requested_to: "2030-01-20",
      covered_from: "2030-01-07",
      covered_to: "2030-01-15",
      rows_in_window: 3,
      rows_skipped: 2,
      write_errors: 0,
      explicit_window: true,
    });
  });
  it("any write error makes the whole window partial", () => {
    const r = buildSyncWindowRecord({
      startedAt: t0, finishedAt: t1, requested: req, threw: false,
      rows: rows(["2030-01-08"]), skipped: 0, writeErrors: 4,
    });
    expect(r.outcome).toBe("partial");
    expect(r.write_errors).toBe(4);
    expect(r.covered_from).toBe("2030-01-08");
  });
  it("no rows inside the request → empty with no coverage claimed", () => {
    const r = buildSyncWindowRecord({
      startedAt: t0, finishedAt: t1, requested: req, threw: false,
      rows: rows(["2031-01-01"]), skipped: 0, writeErrors: 0,
    });
    expect(r).toMatchObject({ outcome: "empty", covered_from: null, covered_to: null, rows_in_window: 0 });
  });
  it("a run that threw → failed, never coverage", () => {
    const r = buildSyncWindowRecord({
      startedAt: t0, finishedAt: t1, requested: req, threw: true,
      rows: rows(["2030-01-08"]), skipped: 0, writeErrors: 0,
    });
    expect(r).toMatchObject({ outcome: "failed", covered_from: null, rows_in_window: 0, write_errors: 0 });
  });
  it("threw wins over everything", () => {
    expect(classifySyncOutcome({ threw: true, rowsInWindow: 5, writeErrors: 0, covered: { from: "a", to: "b" } })).toBe("failed");
  });
  it("records hold no free text beyond dates and the outcome code", () => {
    const r = buildSyncWindowRecord({
      startedAt: t0, finishedAt: t1, requested: req, threw: false,
      rows: [{ date: "2030-01-08", "person.name": "SYNTH Person", note: "secret" }], skipped: 0, writeErrors: 0,
    });
    expect(JSON.stringify(r)).not.toMatch(/SYNTH|secret/);
  });
});

describe("persistSyncWindow", () => {
  const rec = buildSyncWindowRecord({
    startedAt: t0, finishedAt: t1, requested: req, threw: false,
    rows: rows(["2030-01-08"]), skipped: 0, writeErrors: 0,
  });
  const client = (error: unknown, seen: SyncWindowRecord[] = []) => ({
    from: (t: string) => {
      expect(t).toBe("clwrota_sync_windows");
      return {
        insert: (row: SyncWindowRecord) => {
          seen.push(row);
          return Promise.resolve({ error: error as null });
        },
      };
    },
  });
  it("writes the record", async () => {
    const seen: SyncWindowRecord[] = [];
    expect(await persistSyncWindow(client(null, seen), rec)).toEqual({ status: "ok" });
    expect(seen).toEqual([rec]);
  });
  it("missing table → not_installed (import continues)", async () => {
    expect(await persistSyncWindow(client({ code: "PGRST205", message: "x" }), rec)).toEqual({
      status: "not_installed",
    });
  });
  it("other errors are reported, never thrown", async () => {
    expect(await persistSyncWindow(client({ code: "23514", message: "check" }), rec)).toEqual({
      status: "error",
      message: "check",
    });
  });
});
