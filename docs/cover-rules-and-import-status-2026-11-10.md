# Cover rules consistency and weekly import status — 2026-11-10

Scope: priority gaps after the CLWRota title/note capture (0008), the
Unverified-slots list and the week rota status (0009). Synthetic data
only; nothing published, synced, notified or changed in live records. No
migration was applied to the live database.

## 1. What was already in place (inspected, not duplicated)

- **Titles/notes (0008, live):** `src/features/clwrota/source-labels.ts`
  writes original list titles / notes / place notes per session to the
  service-only `theatre_session_source_labels`; browsers read only derived
  signals (`get_theatre_session_label_signals`). The forecast falls back to
  legacy fields while 0008 is absent.
- **Unverified slots:** built in `theatre-pressure.ts` from those signals;
  reasons distinguish blank-in-source, partial evidence, not captured, no linked
  rows and no imported lists. Each row links to the day page.
- **Week rota status (0009, live):** the feed's `rota_status` per observed
  week (`week-status.ts` → `clwrota_week_status`). Unobserved weeks = "Not
  checked"; times are observation times, not publication times.
- Both work together: the Unverified slots table shows the Week status column
  when 0009 is present, and both degrade to "not recorded yet" when absent.

## 2. Weekly import status — four separate concepts

| Concept | Source | Shown as |
|---|---|---|
| Publication state | feed `rota_status` (0009) | "Status: Published / Setup / Not setup / Not checked" |
| Date/week coverage | per-run date windows (new, 0010) | "Imported" / "k/7 days imported" |
| Freshness / last known good | newest time every day of the week was confirmed by a clean run | "Good as of dd/mm/yyyy", "Import out of date" after 48 h |
| Partial / failed attempt | outcome of the newest run touching each day | "Last import partial / empty / failed" — last known good kept |

There was **no per-date import record** before this change (only one global
`last_successful_rota_sync_at` and per-run counts without dates), so tracking is
instrumented going forward; nothing historical is inferred. Weeks before the
first tracked run show "Import not tracked".

**Instrumentation** (`src/features/clwrota/sync-windows.ts`, wired as a wrapper
around `performRotaSync`): every run — each slice of a chunked or incremental
import, and runs that throw — records requested from/to, covered from/to (the
requested window ∩ first..last returned row date), outcome and counts.
- `failed`: the run threw (fetch/parse/import error). `empty`: no rows with a
  date inside the request. `partial`: any write error — the whole window is
  suspect. `ok`: no write error (rule-based skips are counted, not hidden).
- Chunked imports are treated conservatively: a week counts as imported only
  when **every** day was inside a clean run's covered range; its "good as of"
  is the oldest of those days' latest clean confirmations.
- Days asked for but outside the returned rows are not counted as imported.
- No error text is stored (import errors can contain names). A missing table is
  tolerated; the import result is never changed by the record.
- The import's own staff/theatre/specialty lookups are now read completely and
  fail the run on error, and a failed theatre-alias read now fails the run,
  instead of silently skipping every row as "unmatched" while reporting success.

**Access:** `clwrota_sync_windows` is service-role only (no policies).
Browsers call `get_rota_sync_week_coverage(p_from, p_to)` (SECURITY DEFINER,
caller identity via the 0007 request helpers; active members and service role
only; ≤ 400-day window; whole ISO weeks). It returns one row per week (≤ 58),
far below the API cap; the client fails if more rows than weeks come back.

**UI:** Robustness → Theatre pressure forecast → "Rota weeks — status and
import" shows Status and Import per week; Unverified slots gain an Import
column; the day page shows the week's Status + Import with a link back to the
forecast for rechecking. Load failures show Retry; absence shows "isn't switched
on yet".

## 3. Cover rules — one definition

`src/features/audit/cover-rules.ts` now holds the solo-capable rule, SPA
contingency, risk thresholds, worst-half ordering, simulator verdicts and the
shared wording, used by the Robustness overview, day detail, simulator, home
summary and staff breakdown.

- **Solo-capable (verified against code and defaults):** free consultants and
  trainees whose level is exactly ST6, ST7 or ST8 (trimmed, case-insensitive).
  SAS, other trainees and unrecorded grades never count. The computation
  already included ST8; the overview and day-page text said "ST6/7" and is fixed.
- **SPA contingency** is unchanged and explicit: never in headroom; only decides
  "SPA needed" vs "Shortfall". Thresholds unchanged (tight = headroom 0–1).
- **Discrepancies fixed**
  - Day breakdown listed people with no rota entry (or only an emergency list)
    as "free" although the numbers excluded them → now "Not rostered today".
  - Unknown grade was filed under "Free consultants" → "grade not recorded".
  - Day breakdown ignored clinical-list duties without a linked session and
    counted emergency-list assignments → same rules as the numbers; emergency
    lists are badged and excluded from the unfilled count.
  - Day-page tooltip compared solo-capable staff with all lists → unfilled lists.
  - Simulator ignored days newly needing SPA and showed "no new shortfall" when
    cover failed to load → reports new SPA-needed days; error + Retry instead.
  - Home "worst half" ordering now uses the shared severity.
- **Workflow preserved:** numbers, thresholds, roster-evidence gate, emergency
  handling and the admin duty-category editor are unchanged.

### Not changed (needs an owner decision)
- A list counts as "filled" by any assignment, even if only SAS/junior staff
  are on it, while the per-list coverage view calls that "supervised". Changing
  headroom to require a solo-capable person on every list would change every
  number, so it was left as is.
- The seeded duty categories omit `medical_examiner`, which the built-in
  defaults exclude; live configuration was not inspected or changed.
- `custom_rota_rules` read errors in the rule checker still return "no
  violations" (outside the cover calculations).

## 4. Silent fallbacks fixed

- `duty_type_pool_rules`: a failed read now throws ("Duty categories couldn't
  be loaded…") and every cover screen shows an error with Retry, not numbers.
  A **successful empty** read still uses the built-in categories and the
  overview says so. The read is paged with a stable order.
- Same calculations: inactive-theatre reads (overview and per-list coverage) and
  every day-page read (sessions, profiles, leave, assignments, trainee targets,
  theatres, specialties) now check errors and are paged; the day page used to
  stay on "Loading…" forever on error.

## 5. Evidence (synthetic)

- New unit tests: `cover-rules.test.ts` (ST8, thresholds, SPA, verdicts),
  `robustness.cover-consistency.test.ts` (breakdown rolls up to the same
  solo-capable count AM/PM, ST8, not-rostered, emergency, pool-rule failure vs
  empty config, other read failures), `rota-sync-coverage.test.ts` (current,
  stale boundary, partial after ok, incomplete chunked, untracked, unknown
  outcome, not installed, overflow), `sync-windows.test.ts` and
  `sync-windows.wrapper.test.ts` (failed chunk recorded for its slice, early
  failure without a window records nothing, no feed → nothing),
  `TheatrePressureCard.test.tsx` (Import separate from Status, Retry,
  not installed) — plus all existing forecast/robustness tests.
- Disposable DB harness `tests/db-harness/source-labels/run.sh` (0007 + 0008 +
  0009 + 0010, non-superuser owner in service_role, real PostgREST): exact
  per-week coverage for ok / partial / failed / chunked / untracked weeks, last
  known good, tracking start, access denials (roleless, inactive, departed,
  missing profile, anon, no-claims, forged claims, postgres without claims),
  window limits, constraint rejections and metadata.
- Browser smoke `tests/e2e/robustness-cover-import.spec.py` (mocked sign-in and
  data): overview wording, Status vs Import strip, day context, failure Retry on
  overview / day / simulator, home renders.

## 6. Live activation (done 2026-11-10, approved by Rob Coe)

1. Applied to live, in order: `drizzle/migrations/0008_theatre_session_source_labels.sql`,
   `0009_clwrota_week_status.sql`, `0010_clwrota_sync_windows.sql` (SQL identical to the
   reviewed pending files apart from the header line; `drizzle/pending/` copies removed).
   Live metadata check: all three tables have RLS on; anon has no access; signed-in users
   can read only week status (policy: active members); the two derived functions are
   SECURITY DEFINER, executable by authenticated/service_role, not anon; validation
   triggers are not executable by anon/authenticated. The source-labels harness was re-run
   against the applied files: 100 cases, 0 failures.
2. One real rota-only import was run on request through the preview's code (window
   2026-10-11 to 2027-03-10, the default 30 days back / 120 ahead): ok, no write errors.
   It recorded one `ok` import window covering the whole range, week status for 23 weeks
   (published / setup / not setup), and source labels for every session it imported.
   Like earlier full imports, it removed assignments the feed now marks as non-working.
   No staff or leave step, publish or notification.
3. Still needed: the scheduled hourly import runs the **published** app's code, which
   does not yet write source labels, week status or import windows. Until the app is
   published, only manual preview imports update them, and weeks go "out of date" 48 h
   after the last such import.
4. Owner decisions listed in §3 "Not changed".
