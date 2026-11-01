# Wellbeing accuracy pass and release check — 2026-11-01

Scope: the wellbeing defects that were independently reproduced, followed by a
full re-run of every check. All tests use **synthetic data only**. Nothing was
published, no email/push was sent, no CLWRota sync ran, and no real staff, rota
or leave records were changed. This pass made **no database migrations**.

## 1. Weights, caps and bands

Unchanged. The wellbeing driver weights (0.22 / 0.18 / 0.12 / 0.18 / 0.10 / 0.10 / 0.10)
and caps (4 nights/mo, 3 weekends/mo, 50 % unsocial, 6 changes, 3 leave, 4 exceptions,
Bradford 300) are unchanged. So are the wellbeing bands (80 / 65 / 45) and the
retention-signal weights, caps and bands (25 / 45 / 65). Both band functions
are exported (`wellbeingBandFor`, `attritionBandFor`) and tested at every boundary.

**One new rule (a coverage gate, not a weight change):**
`MIN_ASSESSABLE_SESSIONS = 10`. If a person has fewer than 10 of their own rota
rows in the window, the result is `scoreKnown: false`,
`coverage: "insufficient"` and `band: "unknown"`, shown as "Not enough data".
This is needed because an empty input previously produced "Thriving 100". The
value 10 (fewer than one session a week across 90 days) is a judgement call
and is open to review. The arithmetic score is still computed and is still
returned internally.

The retention signal's fixed 0.30 placeholder for a missing pulse trend is
**kept** unchanged. It is now labelled "not assessed" rather than hidden.

## 2. Code changes

| File | Change |
|---|---|
| `src/features/wellbeing/wellbeing-score.ts` | **Unsocial share** now counts the union of qualifying rows (night OR eve OR weekend), so a weekend night counts once and the share can never exceed 100 %. **Window** is now explicit: `wellbeingWindow(now, 90)` returns the 90 inclusive calendar days `[asOf−89, asOf]`, compared by day key, so midnight, noon and 23:59 give identical boundaries. The new fields are `scoreKnown`, `coverage`, `sessionsInWindow` and band `unknown`. |
| `src/features/wellbeing/admin-inputs.ts` (new) | `selectAdminSignalInputs({staffId, asOf, leave, changes, rtws})` is pure and testable. **Denial rate** uses only approved/rejected decisions whose decision day falls within the 365 inclusive days ending on `asOf`. The fallback order (documented) is `decided_at` → `created_at` → `start_date`. **Short-notice changes** exclude session dates after `asOf`. **Days since annual leave** uses only approved annual leave that has already started; ongoing leave gives 0, future bookings are ignored, and no leave taken gives `null`. **Overdue return-to-work interview** counts as done only when `conducted_at` is non-null. **Pulse trend** is always `null` (not measured). |
| `src/lib/attrition-risk.ts` | Now an operational signal score `score` (integer 0–100), with the band selected **from the displayed rounded integer**. Previously the band used the unrounded value, so a displayed 25 could be "Low". New: `notAssessed[]` and band `not_assessed` when wellbeing is unknown. `risk` is now unrounded (internal only). The header comment states the score has no validation evidence and is not a probability. |
| `src/routes/_authenticated/admin.wellbeing.tsx` | Uses the shared selector with one explicit `asOf`. Shows "—" for unknown scores, "Not assessed" or `Band (x/100)` instead of `%`, a "Not enough data" count, a caveat about unvalidated signals and support-only use, and a "Not assessed: …" list per row. Unknown rows sort first. Column renamed "Retention signal". |
| `src/routes/_authenticated/wellbeing.tsx` | Shows "—" plus an explanation when coverage is insufficient. |
| `src/routes/api/chat.ts` | The wellbeing tool returns `score: null`, `score_known`, `coverage` and `sessions_in_window` when coverage is insufficient. The system prompt tells the assistant not to describe missing data as good wellbeing. |
| `src/components/wellbeing/MetricsGuide.tsx` | Removed "single strongest predictor", "likely to leave over the coming months", "strong retention risk" and the research-linkage claims. The title is now "Retention signal score (0 – 100)", stated as not a prediction or probability and not validated. Bands are shown as integers. The guide documents the rounding/band rule, the coverage gate, the union rule, the decision-date fallback, future exclusions and RTW completion, and marks the pulse trend NOT CURRENTLY MEASURED. The support-only caveat is kept and extended (no HR, performance or employment decisions). |
| `src/features/wellbeing/coverage-fixture.ts` (new) | Test helper that adds weekday AM rows; these add no harm to any driver. |

### Existing tests changed (contract changes, not weakened)

- `src/lib/wellbeing-multi-staff-recent-leave.test.ts`: the boundary case now
  asserts the requested 90-calendar-day window (89 days ago IN, 90 days ago OUT).
  It used to assert a 91-day window (90 IN, 91 OUT). The assertions keep the
  same strength; only the boundary moved.
- `admin-wellbeing.integration.test.tsx`, `wellbeing-enum-consistency.integration.test.tsx`
  and both `-chat.wellbeing-response-changes-*.e2e.test.ts` files: their
  fixtures had **zero** rota rows, so they now fall under the coverage gate.
  Each gained 12 harmless weekday AM rows; the leave and exception assertions
  are unchanged.

### New regression tests — `src/features/wellbeing/wellbeing-accuracy.test.ts` (19 tests)

| Case | Before | After |
|---|---|---|
| All weekend nights | unsocial 200 % | 100 % |
| Mixed overlap (2 wknd nights, 2 wkday eves, 2 wknd AM, 4 wkday AM) | 120 % | 60 % |
| Window at 00:00, 12:00 and 23:59:59 | start depended on time | always 2026-08-04..2026-11-01 |
| Empty input | Thriving 100 | unknown / insufficient |
| 9 vs 10 sessions | — | unknown vs assessed |
| Wellbeing unknown → retention | Low | not_assessed (+ pulse listed) |
| 2023 denial + recent approval | 50 % | 0 % |
| Decision-date fallback to created_at | — | counted |
| Future annual booking with last taken leave 295 days ago | 0 days | 295 days |
| Ongoing annual leave | — | 0 days |
| Only future annual leave | 0 days | null (none taken) |
| RTW row with `conducted_at: null` | 0 overdue | 1 overdue |
| Future rota change | counted | excluded |
| Raw 0.2496 → display 25 | "Low (25%)" | "Watch (25/100)" |
| Band boundaries 24/25/44/45/64/65 and 80/79/65/64/45/44 | unchanged | unchanged |

## 3. Commands and results (after the final change)

| Check | Command | Exit | Result |
|---|---|---|---|
| Full suite | `bunx vitest run` | 0 | 185 files; **1,872 passed, 4 skipped**, 0 failed |
| Wellbeing/chat focused | `bunx vitest run src/features/wellbeing src/lib/wellbeing* src/lib/admin-wellbeing* src/lib/clwrota-leave-status-wellbeing* src/routes/api/-chat*` | 0 | 263 passed |
| Timezone/stress files | `bunx vitest run <5 files matching timezone/stress/tz>` | 0 | 39 passed |
| Other machine TZs | `TZ=America/Los_Angeles …` and `TZ=Pacific/Kiritimati …` on wellbeing tests | 0 | 35 and 19 passed |
| Type check | `bunx tsgo --noEmit -p .` | 0 | clean |
| Lint | `bunx eslint . --quiet` | **1** | **191 errors**: 154 no-explicit-any, 16 no-use-before-define, 12 no-restricted-syntax, 9 no-useless-escape. Same count as the previous report. Files changed in this pass were autoformatted; their only remaining errors are pre-existing `any` in mock code in the two chat e2e tests. No rules disabled. |
| Production build | `bun run build` | 0 | built |
| DB harness | `PG=<nix pg16> bash tests/db-harness/run.sh` | 0 | 129 cases, 0 failures |
| PostgREST harness | `PG=… PGRST=… bash tests/db-harness/postgrest.sh` | 0 (×3) | 12 cases, 0 failures. The first run **failed 1 case** (PGRST002 schema cache not ready, a start-up race). The readiness wait now requires HTTP 200; three consecutive re-runs passed. |
| Actual-lock audit | `node scripts/check-supply-chain.mjs` | **1** | 1,153 packages; 2 moderate, 1 low; xlsx CDN tarball UNSCANNED |

## 4. Platform scans (fresh, this pass)

| Scanner | Status |
|---|---|
| Basic security scan (`run_security_scan`) | Ran: "No security issues found by the completed basic checks". It states that it does **not** run deep code analysis. |
| Deep code/SAST scan (`agent_security_v2`, `app_mcp_deep`) | **Blocked/stale.** Last completed 2026-09-25 and flagged `up_to_date: false`; it cannot be triggered from here. Zero findings in that old run is **not** a current result. |
| Database scan (`lov_pgscan`) | Last result 2026-11-01 13:34, before this pass, `up_to_date: false`, 0 findings. No schema changed since then. |
| Connector scan | **Incomplete** (2026-08-22). |
| Database linter | Ran: 18 issues. 16× WARN "signed-in users can execute SECURITY DEFINER function" and 2× INFO "RLS enabled, no policy" (the intentionally locked tables, e.g. `passkey_challenges`, `request_quota_buckets`). The 16 functions were **not re-reviewed one by one in this pass**; earlier passes treated the `get_*_decrypted` / `has_role` family as designed with internal role checks. This is still an open review item. |
| Platform dependency scan (production deps) | Ran: "No known vulnerabilities in 75 production dependencies"; xlsx "Not checked". |
| Supply-chain scanner | Complete, 0 findings, up to date (14:31). |

## 5. Current advisories (`bun audit` on the committed `bun.lock`)

| Package | Severity | Path | Scope |
|---|---|---|---|
| esbuild 0.18.20 (≤0.24.2), GHSA-67mh-4wv8-2f99 | moderate | drizzle-kit → @esbuild-kit | **tooling** (migrations CLI; dev server issue, not shipped) |
| minimatch 3.1.5 / 10.2.5 (<11.0.1), GHSA-g3hv-75wg-m249 | moderate | eslint tooling | **tooling** |
| katex 0.16.47 (<0.18.2), GHSA-238p-pmpm-9mq7 | low | direct dep, rehype-katex in chat maths rendering | **runtime, shipped**. The platform production scan did not report it, which disagrees with `bun audit`; I treated it as present. rehype-katex 7 depends on katex ^0.16, so the upgrade was not attempted in this pass. |
| xlsx 0.20.3 (SheetJS CDN tarball) | n/a | runtime | **UNSCANNED**: no advisory database covers the CDN build; pinned by exact URL and integrity |

Nothing is suppressed. The CI audit job stays red.

## 6. Remaining issues / not done

- The coverage gate value (10 sessions) needs department sign-off.
- The pulse-survey trend is still not measured per person; the rubric still adds a fixed 0.30 × 0.13 placeholder (original behaviour, now labelled).
- Bradford inputs on the admin page still pass every approved sick spell to `computeBradfordFactor`. This pass did not change or audit its own 12-month windowing.
- The personal page and the chat tool use `new Date()` as as-of. They are consistent with the admin page, but there is no separate as-of selector.
- Not checked with a real login: the admin and personal wellbeing pages in a real browser (no session).
- Deep code scan stale/blocked; connector scan incomplete; 16 linter SECURITY DEFINER warnings not re-reviewed.
- Lint: 191 pre-existing errors. Dependency audit: 2 moderate (tooling) and 1 low (runtime katex), plus xlsx unscanned.
- Items carried over from `docs/audit-2026-11-01-final-verification.md` remain open: no cap on simultaneous assistant requests; other analytics pages with fixed wide ranges; study-cost allocation across leave years; access-request IP trust and idempotency.
