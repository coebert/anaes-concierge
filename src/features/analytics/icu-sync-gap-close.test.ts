import { describe, expect, it } from "vitest";
import { pickGapSliceStart } from "./icu-sync-job.server";

const base = {
  windowStart: "2026-01-01",
  windowEnd: "2026-01-21",
  today: "2026-01-21",
  sliceDays: 7,
  cursor: null,
  now: Date.parse("2026-01-21T00:00:00Z"),
};

describe("pickGapSliceStart", () => {
  it("picks the first window that has never been checked", () => {
    expect(pickGapSliceStart({ ...base, runs: new Map() })).toBe("2026-01-01");
  });

  it("skips windows that already match CLWRota", () => {
    const runs = new Map([
      ["2026-01-01", { diverged: false, ranAt: base.now }],
    ]);
    expect(pickGapSliceStart({ ...base, runs })).toBe("2026-01-08");
  });

  it("re-opens a window whose counts diverged", () => {
    const runs = new Map([
      ["2026-01-01", { diverged: true, ranAt: base.now }],
      ["2026-01-08", { diverged: false, ranAt: base.now }],
      ["2026-01-15", { diverged: false, ranAt: base.now }],
    ]);
    expect(pickGapSliceStart({ ...base, runs })).toBe("2026-01-01");
  });

  it("returns null when every window is closed", () => {
    const runs = new Map([
      ["2026-01-01", { diverged: false, ranAt: base.now }],
      ["2026-01-08", { diverged: false, ranAt: base.now }],
      ["2026-01-15", { diverged: false, ranAt: base.now }],
    ]);
    expect(pickGapSliceStart({ ...base, runs })).toBeNull();
  });

  it("re-checks recent windows whose last check has gone stale", () => {
    const stale = base.now - 10 * 86_400_000;
    const runs = new Map([
      ["2026-01-01", { diverged: false, ranAt: base.now }],
      ["2026-01-08", { diverged: false, ranAt: base.now }],
      ["2026-01-15", { diverged: false, ranAt: stale }],
    ]);
    expect(pickGapSliceStart({ ...base, runs })).toBe("2026-01-15");
  });

  it("leaves settled historical windows alone once they match", () => {
    const long = { ...base, windowStart: "2025-01-01", windowEnd: "2025-01-21" };
    const runs = new Map([
      ["2025-01-01", { diverged: false, ranAt: Date.parse("2025-02-01T00:00:00Z") }],
      ["2025-01-08", { diverged: false, ranAt: Date.parse("2025-02-01T00:00:00Z") }],
      ["2025-01-15", { diverged: false, ranAt: Date.parse("2025-02-01T00:00:00Z") }],
    ]);
    expect(pickGapSliceStart({ ...long, runs })).toBeNull();
  });
});
