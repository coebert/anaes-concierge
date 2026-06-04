/**
 * Pure helper for the CLWRota rota-sync "historical data loss" safeguard.
 *
 * The sync intentionally deletes a known set of rows during the
 * non-working cleanup pass (rows whose upstream label has flipped to
 * annual leave, study, etc.). A naive `postCount < preCount` check
 * misreports that legitimate pruning as data loss and flips the sync to
 * ok=false on every run.
 *
 * The real invariant is:
 *   postCount >= preCount - nonWorkingCleaned
 *
 * Anything below that floor is unexplained loss and MUST be surfaced.
 * Anything at or above it is normal — including the equality case
 * (nothing pruned, nothing added) and the case where new rows were
 * upserted (postCount > preCount).
 */
export type HistoricalSafeguardInput = {
  preSyncCount: number;
  postSyncCount: number;
  nonWorkingCleaned: number;
};

export type HistoricalSafeguardResult =
  | { ok: true }
  | { ok: false; expectedFloor: number; error: string };

export function evaluateHistoricalSafeguard(
  input: HistoricalSafeguardInput,
): HistoricalSafeguardResult {
  const { preSyncCount, postSyncCount, nonWorkingCleaned } = input;
  const expectedFloor = preSyncCount - nonWorkingCleaned;
  if (postSyncCount < expectedFloor) {
    return {
      ok: false,
      expectedFloor,
      error: `Historical data loss detected: pre-sync ${preSyncCount}, post-sync ${postSyncCount}, expected at least ${expectedFloor} after non-working cleanup of ${nonWorkingCleaned} row(s).`,
    };
  }
  return { ok: true };
}
