import { describe, it, expect } from "vitest";
import {
  IMPORT_STALE_AFTER_HOURS,
  buildImportCoverageTimeline,
  classifyImportWeek,
  importWeekLabel,
  loadImportCoverage,
  type SyncCoverageRow,
} from "./rota-sync-coverage";

// Synthetic weeks only.
const NOW = new Date("2030-01-20T12:00:00Z");
const row = (o: Partial<SyncCoverageRow> = {}): SyncCoverageRow => ({
  week_start: "2030-01-14",
  days_total: 7,
  days_ok: 7,
  days_partial_only: 0,
  days_latest_not_ok: 0,
  last_full_ok_at: "2030-01-20T06:00:00Z",
  newest_ok_at: "2030-01-20T06:00:00Z",
  latest_attempt_at: "2030-01-20T06:00:00Z",
  latest_attempt_outcome: "ok",
  tracking_since: "2030-01-01T00:00:00Z",
  ...o,
});

describe("classifyImportWeek", () => {
  it("every day confirmed recently → current", () => {
    expect(classifyImportWeek(row(), NOW).state).toBe("current");
  });

  it(`last complete confirmation older than ${IMPORT_STALE_AFTER_HOURS}h → stale, keeps last known good`, () => {
    const c = classifyImportWeek(row({ last_full_ok_at: "2030-01-18T11:59:00Z" }), NOW);
    expect(c.state).toBe("stale");
    expect(c.lastKnownGoodAt).toBe("2030-01-18T11:59:00Z");
  });

  it("exactly at the stale boundary is still current", () => {
    expect(classifyImportWeek(row({ last_full_ok_at: "2030-01-18T12:00:00Z" }), NOW).state).toBe(
      "current",
    );
  });

  it("partial attempt after a clean one → attempt_problem with last known good kept", () => {
    const c = classifyImportWeek(
      row({ days_latest_not_ok: 7, latest_attempt_outcome: "partial", latest_attempt_at: "2030-01-20T09:00:00Z" }),
      NOW,
    );
    expect(c.state).toBe("attempt_problem");
    expect(c.lastKnownGoodAt).toBe("2030-01-20T06:00:00Z");
    expect(importWeekLabel({ ...c, weekStart: "2030-01-14", beforeTracking: false })).toBe(
      "Last import partial",
    );
  });

  it("only some days confirmed (chunked import stopped short) → incomplete, no last known good", () => {
    const c = classifyImportWeek(row({ days_ok: 6, last_full_ok_at: null }), NOW);
    expect(c.state).toBe("incomplete");
    expect(c.lastKnownGoodAt).toBeNull();
    expect(importWeekLabel({ ...c, weekStart: "2030-01-14", beforeTracking: false })).toBe(
      "6/7 days imported",
    );
  });

  it("a stray full-ok time with days missing is never treated as complete", () => {
    const c = classifyImportWeek(row({ days_ok: 3 }), NOW);
    expect(c.state).toBe("incomplete");
    expect(c.lastKnownGoodAt).toBeNull();
  });

  it("no runs ever → not tracked (never current)", () => {
    expect(
      classifyImportWeek(
        row({ days_ok: 0, last_full_ok_at: null, newest_ok_at: null, latest_attempt_at: null, latest_attempt_outcome: null }),
        NOW,
      ).state,
    ).toBe("not_tracked");
    expect(classifyImportWeek(undefined, NOW).state).toBe("not_tracked");
  });

  it("an unrecognised outcome is a problem, not ok", () => {
    const c = classifyImportWeek(row({ latest_attempt_outcome: "weird" }), NOW);
    expect(c.state).toBe("attempt_problem");
    expect(c.latestAttemptOutcome).toBe("failed");
  });

  it("only failed attempts → attempt_problem with no last known good", () => {
    const c = classifyImportWeek(
      row({ days_ok: 0, last_full_ok_at: null, newest_ok_at: null, days_latest_not_ok: 7, latest_attempt_outcome: "failed" }),
      NOW,
    );
    expect(c.state).toBe("attempt_problem");
    expect(c.lastKnownGoodAt).toBeNull();
  });
});

describe("buildImportCoverageTimeline", () => {
  it("has an entry for every week, marks weeks before tracking, and is empty-safe", () => {
    const tl = buildImportCoverageTimeline({
      rangeStart: "2029-12-25",
      rangeEnd: "2030-01-20",
      rows: [row()],
      capture: "available",
      now: NOW,
    });
    expect(tl.weeks.map((w) => w.weekStart)).toEqual([
      "2029-12-24",
      "2029-12-31",
      "2030-01-07",
      "2030-01-14",
    ]);
    expect(tl.byWeek.get("2029-12-24")?.beforeTracking).toBe(true);
    // Week containing the tracking start is not "before tracking".
    expect(tl.byWeek.get("2029-12-31")?.beforeTracking).toBe(false);
    expect(tl.byWeek.get("2030-01-07")?.state).toBe("not_tracked");
    expect(tl.byWeek.get("2030-01-14")?.state).toBe("current");
  });

  it("not installed → every week not tracked", () => {
    const tl = buildImportCoverageTimeline({
      rangeStart: "2030-01-14",
      rangeEnd: "2030-01-20",
      rows: [row()],
      capture: "not_installed",
      now: NOW,
    });
    expect(tl.weeks.every((w) => w.state === "not_tracked")).toBe(true);
  });
});

describe("loadImportCoverage", () => {
  const client = (res: { data: unknown; error: unknown }) => ({
    rpc: (fn: string, args: unknown) => {
      expect(fn).toBe("get_rota_sync_week_coverage");
      expect(args).toEqual({ p_from: "2030-01-14", p_to: "2030-01-27" });
      return Promise.resolve(res);
    },
  });
  it("missing function → not_installed", async () => {
    const r = await loadImportCoverage(
      "2030-01-14",
      "2030-01-27",
      client({ data: null, error: { code: "PGRST202", message: "Could not find the function" } }),
    );
    expect(r.capture).toBe("not_installed");
  });
  it("other errors throw (Retry), never empty", async () => {
    await expect(
      loadImportCoverage("2030-01-14", "2030-01-27", client({ data: null, error: { code: "42501", message: "not authorised" } })),
    ).rejects.toThrow(/couldn't be loaded/);
  });
  it("more rows than weeks requested fails instead of truncating", async () => {
    await expect(
      loadImportCoverage(
        "2030-01-14",
        "2030-01-27",
        client({ data: [row(), row(), row()], error: null }),
      ),
    ).rejects.toThrow(/3 weeks for a 2-week window/);
  });
});
