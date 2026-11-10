# CLWRota / Central Reporting source inventory — 2026-11-10

Scope: compare the CLWRota and Central Reporting screens the owner observed
while signed in against what the app imports, stores and uses. Pull in only
missing operational fields that come from a configured, authorised machine
feed and whose meaning has been checked. No real row data appears in this
document.

## How availability was verified

* **Configured feeds** (from `clwrota_sync_state`, paths only): Central API
  `query/assignments`, `query/leave_events` and `query/people`, each
  scoped to the configured service. These use the existing `CLWROTA_API_KEY`;
  no new credentials, browser session or scraping were used.
* **Field lists:** each configured query target was asked once for a
  deliberately invalid field. The API answers `400 "'x' is not one of [...]"`,
  which lists the fields it accepts. No rows came back. Assignments accepts
  101 fields, leave_events 141 and people 26.
* **Value check:** one read-only request for `date,state,rota_status` over
  about 30 weeks. Only the distinct values and their counts were looked at;
  nothing was stored. Results:
  * `assignments.rota_status` takes exactly `Published`, `Setup` and
    `Not setup`. It is the same for every row in an ISO week (31 of 31 weeks),
    and in date order the weeks run Published, then Setup, then Not setup.
  * `assignments.state` takes `planned` or `actual`. `actual` rows also appear
    in future weeks (Setup, Published and some Not setup), so **`actual` does
    not mean delivered.** `planned` rows appear only in future Not setup weeks.
  * `leave_events.rota_status` uses a different set of values (`draft`,
    `setup`, `published`). Its meaning for leave was not checked, so it is
    not used.

## Inventory

| Observed source (UI) | Machine feed today | App today | Decision |
|---|---|---|---|
| Weekly All locations: Published / Draft / Not setup per week | `assignments.rota_status` (verified, but its words are Published / Setup / Not setup) | Not requested, not stored | **Added**: recorded per week, using the feed's own words |
| Uncovered sessions report (Date, Session, Location, Speciality, List Name; eligible locations only) | No uncovered field or query target in the configured feeds | No explicit uncovered status. The app can only see lists that have someone assigned | **Not added**: the report is UI-only. See next steps |
| Central Reporting Anaesthetics Status (week setup / published / completed dates) | Not in the configured feeds. `rota_status` gives the current status, not dates | — | Current status only (above). The app records when the import first *saw* each status and labels it as such, never as a publication date |
| Service reports: planned vs delivered, variability, heatmap, setup/published weeks | No delivered or outcome field. `state` is planned vs actual, not delivered | — | **Not added**: provenance and meaning aren't verified. `state` counts are kept per week only to show where rows came from |
| Capacity, Delivery, Skeleton, People, Time calculations | Not in the configured feeds | — | Not added |
| Role / location groups | `tier1..5_org_unit.*`, `role.*`, `place_category.*` (already requested) | Requested; partly used for matching | Already covered |
| List / slot metadata | `slot_titles`, `slot_notes`, `slot_speciality`, `place.additional_info` | Captured separately by 0008 (live 2026-11-10) | Covered (previous change) |
| Place job-planning categories | `place.job_planning_tier_1/2_category` (accepted, not requested) | — | Not added: meaning not verified, and no consumer needs it |

Not read, by design: clinician preferences, messages, `extra_submittal.*`
notes and actors, `leave_submittal.*` HR/OH fields, publication actors and
patient identifiers.

## Changes made (additive, synthetic-tested, not activated)

* The import now requests `rota_status` (`ensureRotaReportFields`). The API
  accepts it.
* `src/features/clwrota/week-status.ts` records, for each ISO week **the feed
  returned rows for**:
  * the status: published / setup / not_setup, or mixed / unknown / other
    when the rows disagree, have no status or use an unrecognised value;
  * the feed's own words for it (short plain words only);
  * row counts, including planned and actual;
  * when the import first saw the week, and when it first saw the current
    status.

  Weeks with no rows are never written.
* Migration `drizzle/migrations/0009_clwrota_week_status.sql` (applied live 2026-11-10):
  * active members can read it (same rule as theatre lists); only the
    import (service role) can write;
  * the database rejects non-Monday weeks, unknown codes, weeks with zero
    rows and state counts that don't add up.
* On the Robustness forecast:
  * a **Rota week status** strip shows each week's feed status and when the
    import checked it, flagged as possibly out of date after 3 days;
  * weeks the import hasn't seen show "Not checked";
  * the **Unverified slots** list gains a Week column.

  Before activation, the strip says the status isn't recorded yet and shows
  no week status.

## Checks

* Unit and UI tests: `week-status.test.ts`, `rota-week-status.test.ts`,
  `TheatrePressureCard.test.tsx` and `ensure-rota-report-fields.test.ts`.
* Throwaway database harness `tests/db-harness/source-labels/run.sh`: 69/69
  cases passed (0008 + 0009, in SQL and through real PostgREST).

## Open findings / next steps

1. **Activation:** apply 0008 and 0009 to the live database (needs approval).
   The next rota import then fills the new tables.
2. **Planned rows:** the import does not filter on `state`. Future Not setup
   weeks contain `planned` rows. If those rows are imported as assignments,
   cover and staffing for those weeks may come from planned entries rather
   than a rostered rota. Recommendation: decide whether planned rows should be
   kept apart, then gate on `state` with a test. Not changed here, because
   many screens depend on the import.
3. **Uncovered sessions / Status dates / Service reports:** these need either
   * an authorised Report Builder API report that returns those columns, with
     its documented URL and schema, configured like the other report URLs; or
   * a header-only or synthetic sample of the exact CSV export.

   With either, a narrow importer could be built and verified. Without one,
   any import would be guessed, so none was built.
