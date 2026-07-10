/**
 * Side-effect import that asserts UTC timezone at module-load time. Import
 * once at the top of any date-heavy wellbeing test:
 *
 *   import "@/test/assert-utc-hook";
 *
 * If the shared `process.env.TZ = "UTC"` setup in
 * `src/test/setup-timezone.ts` is removed or overridden, loading this
 * module throws before any test runs — Vitest reports the whole file as
 * failed with a clear message instead of the tests drifting silently.
 */
import { assertUtcTimezone } from "./assert-utc";

assertUtcTimezone();
