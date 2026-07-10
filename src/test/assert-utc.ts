/**
 * Assert the test runner's timezone is UTC. Import and call from a
 * `beforeAll` in any date-heavy wellbeing test so accidental removal of the
 * shared `process.env.TZ = "UTC"` override in `src/test/setup-timezone.ts`
 * fails loudly at the top of every affected suite instead of producing
 * subtle off-by-one calendar-day drift.
 *
 * Two checks are needed:
 * - `process.env.TZ === "UTC"` proves the env var is set.
 * - `new Date().getTimezoneOffset() === 0` proves V8 actually picked it up
 *   (some runners cache the initial timezone; a late override does nothing).
 */
export function assertUtcTimezone(): void {
  const tz = process.env.TZ;
  const offset = new Date().getTimezoneOffset();
  if (tz !== "UTC" || offset !== 0) {
    throw new Error(
      `Test timezone drift detected: process.env.TZ=${JSON.stringify(tz)}, ` +
        `Date.getTimezoneOffset()=${offset}. Expected UTC (offset 0). ` +
        `Restore the setupFiles entry in vitest.config.ts pointing at ` +
        `src/test/setup-timezone.ts.`,
    );
  }
}
