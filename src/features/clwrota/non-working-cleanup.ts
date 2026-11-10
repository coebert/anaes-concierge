/**
 * Decides which previously-imported rota rows the non-working clean-up may
 * delete.
 *
 * The configured CLWRota assignments feed has no row id, so an assignment's
 * key falls back to person|date|session. In unpublished ("Not setup") weeks
 * the feed often carries a working row (planned theatre list, on-call, ward,
 * admin) AND an "Available"/off row for the same person and half-day. Both
 * share one key. Deleting every key seen on a non-working row then removed
 * the working row straight after it was saved, on every import.
 *
 * Rule: a key that also belongs to a working row in the same import is never
 * deleted — the working row was just written under that key and is the
 * assignment. Only keys seen exclusively on non-working rows are stale.
 */
export function selectStaleNonWorkingExtIds(
  nonWorkingExtIds: Iterable<string>,
  workingExtIds: Iterable<string>,
): { stale: string[]; keptForWorkingRow: number } {
  const working = new Set(workingExtIds);
  const stale: string[] = [];
  let keptForWorkingRow = 0;
  for (const id of new Set(nonWorkingExtIds)) {
    if (working.has(id)) keptForWorkingRow++;
    else stale.push(id);
  }
  return { stale, keptForWorkingRow };
}
