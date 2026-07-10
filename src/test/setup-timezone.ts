/**
 * Force the Node process timezone to UTC before any test module evaluates.
 *
 * Vitest workers inherit `TZ` from the host, so on a developer laptop set to
 * `Europe/London` or `Australia/Sydney` a test comparing calendar-day
 * ordering (e.g. `decided_at.slice(0, 10)` vs a window bound built from
 * `new Date(...)`) can pass locally and fail in CI, or vice versa.
 *
 * Setting `process.env.TZ` here and calling the V8 `Date` reset hook (via a
 * fresh `Date` construction that reads the updated env) pins the runner to
 * UTC for the whole suite. Do NOT read the current TZ and skip — some CI
 * images pre-set `TZ=UTC` but individual tests may override it; we always
 * force the value so ordering is deterministic.
 */
process.env.TZ = "UTC";
