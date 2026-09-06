# ICU sessions & PAs audit

A new audit tab that shows, for each consultant and SAS doctor doing intensive care work, how many ICU days, on-calls and PAs they worked over a period you choose — so it can be pasted straight into appraisal/revalidation evidence.

## What the page shows

Date range picker at the top: quick presets (last 3/6/12 months, this appraisal year) plus custom "from" and "to" boxes. The chosen range lives in the page address, so it can be bookmarked or shared.

Summary tiles: total ICU days, total ICU on-calls, total ICU PAs, and number of doctors with ICU activity in the window.

One row per doctor with any ICU work in the window, showing:

- ICU days worked (distinct dates with a daytime ICU session, so a morning + afternoon on the same day counts once)
- Daytime ICU sessions (AM + PM counts)
- ICU on-calls (evening and overnight duties, counted as distinct on-call dates)
- ICU weekend days (Saturday/Sunday, shown separately)
- Extra / locum / WLI ICU work, in its own column so job-planned work stays clean
- PAs: job-planned PAs, extra PAs, and a total

Rows sort by total PAs, with a per-doctor expandable list of the individual ICU dates behind the numbers so any figure can be traced.

## How PAs are worked out

Using the department's existing rota rules (the Rota rules page), not new hard-coded numbers:

- Daytime sessions: sessions divided by the sessions-per-PA setting
- On-calls: the existing on-call PA credit per on-call
- Weekend ICU days: the existing weekend PA credit
- The rule values used are printed under the table so the calculation is auditable

## Technical notes

- New route `src/routes/_authenticated/admin.icu-workload.tsx`, admin + rota coordinator, with its own head metadata.
- Pure calculation module `src/features/analytics/icu-workload.ts` (counting, de-duplication, PA maths) plus `icu-workload.test.ts` unit tests covering: same-day AM+PM collapsing to one day, evening/night rows collapsing to one on-call, weekend split, extra/locum/WLI exclusion from job-planned totals, and PA arithmetic against sample rule values.
- Data: paged `rota_assignments` query filtered to `duty_type in (icu_consultant_oncall, icu_ct2_plus, icu_trainee)` joined to `profiles` where grade is consultant or SAS and the date is in range; `extra_type` drives the extras columns. Rules read from `rota_rules`.
- Navigation: new item `icu-workload` ("ICU sessions & PAs") added to the analytics/audits group in `src/lib/navigation.ts`; update the audits menu snapshot and navigation reference tests accordingly.
- No schema changes.
