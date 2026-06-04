import { describe, it, expect } from "vitest";
import { evaluateHistoricalSafeguard } from "./clwrota-historical-safeguard";

describe("evaluateHistoricalSafeguard", () => {
  it("stays ok when nothing was pruned and counts match", () => {
    expect(
      evaluateHistoricalSafeguard({
        preSyncCount: 19952,
        postSyncCount: 19952,
        nonWorkingCleaned: 0,
      }),
    ).toEqual({ ok: true });
  });

  it("stays ok when pruning exactly accounts for the drop (the regression case)", () => {
    // Reproduces the false positive from sync run 2026-06-03 20:40:
    // 20113 → 19952 with 161 rows legitimately deleted by the
    // non-working cleanup pass. Must NOT flag as data loss.
    expect(
      evaluateHistoricalSafeguard({
        preSyncCount: 20113,
        postSyncCount: 19952,
        nonWorkingCleaned: 161,
      }),
    ).toEqual({ ok: true });
  });

  it("stays ok when new rows are upserted and count grows", () => {
    expect(
      evaluateHistoricalSafeguard({
        preSyncCount: 19952,
        postSyncCount: 20500,
        nonWorkingCleaned: 12,
      }),
    ).toEqual({ ok: true });
  });

  it("stays ok when pruning over-accounts for the drop (post above floor)", () => {
    // 100 rows pruned but only 30 net loss → other 70 were replaced by
    // upserts. Still above the floor.
    expect(
      evaluateHistoricalSafeguard({
        preSyncCount: 1000,
        postSyncCount: 970,
        nonWorkingCleaned: 100,
      }),
    ).toEqual({ ok: true });
  });

  it("flags genuine loss when post-count is below the cleanup-adjusted floor", () => {
    const result = evaluateHistoricalSafeguard({
      preSyncCount: 20000,
      postSyncCount: 19000,
      nonWorkingCleaned: 100,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.expectedFloor).toBe(19900);
    expect(result.error).toContain("Historical data loss detected");
    expect(result.error).toContain("pre-sync 20000");
    expect(result.error).toContain("post-sync 19000");
    expect(result.error).toContain("at least 19900");
    expect(result.error).toContain("100 row(s)");
  });

  it("flags loss even when nothing was supposed to be pruned", () => {
    const result = evaluateHistoricalSafeguard({
      preSyncCount: 500,
      postSyncCount: 400,
      nonWorkingCleaned: 0,
    });
    expect(result.ok).toBe(false);
  });

  it("treats post == floor as ok (boundary)", () => {
    expect(
      evaluateHistoricalSafeguard({
        preSyncCount: 100,
        postSyncCount: 90,
        nonWorkingCleaned: 10,
      }),
    ).toEqual({ ok: true });
  });

  it("flags loss when post is one below the floor (boundary)", () => {
    const result = evaluateHistoricalSafeguard({
      preSyncCount: 100,
      postSyncCount: 89,
      nonWorkingCleaned: 10,
    });
    expect(result.ok).toBe(false);
  });
});
