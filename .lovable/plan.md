# Point 13 — Analyses HR would ask for tomorrow

Deliver the 8 analyses called out in the HR review as a coherent **Analytics pack** under `Audits & robustness`, plus per-trainee/per-consultant surfacing where it drops naturally into existing cards. All computation is pure-TS over data the app already holds; no new user-entered data streams are needed (leave-denial reasons re-use the existing `leave_requests.decision_reason`, curriculum targets re-use `trainee_targets`).

## What gets built

### 1. Allocation fairness index — `/admin/analytics/allocation-fairness`
Per-doctor Gini coefficient across: list types (from `theatre_sessions.list_type` via `rota_assignments`), weekend sessions, on-call sessions, over rolling 12 months. Table sorted by Gini descending; each row drills into a per-doctor breakdown chart. Reuses `lib/leave-fairness.ts` Gini helper.

### 2. Short-notice change league table — `/admin/analytics/short-notice`
From `rota_change_log` filtered to `hours_before_session <= 48`: count changes *received* per doctor over 12 months, split by direction (added to / removed from). Highlights top decile as "disproportionately absorbing last-minute swaps".

### 3. Leave denial reasons — `/admin/analytics/leave-denials`
Taxonomy inferred from `leave_requests` where `status = 'denied'`: bucket free-text `decision_reason` into fixed categories (staffing, notice, quota, conflict, other) via keyword rules; show category share + 12-month trend line. Cross-tab by grade and by month.

### 4. Trainee educational exposure — `/admin/analytics/trainee-exposure`
Per trainee: sessions of each `list_type` delivered vs `trainee_targets` target, over the training year. Traffic-light: green ≥100%, amber 70–99%, red <70%. Under-exposure alert list for ARCP prep. Also embed a compact version on the trainee detail card.

### 5. On-call frequency inequality — `/admin/analytics/oncall-inequality`
Consultants only, banded by LTFT fraction: on-calls per WTE over 12 months, per-band histogram + Gini. Flags outliers >1.5× band median.

### 6. Sickness seasonality — `/admin/analytics/sickness-seasonality`
From `leave_requests` where `leave_type = 'sick'`: month-by-month absence-days heatmap over ≥24 months; overlay rota density (sessions/day) to expose correlation. Pearson r reported.

### 7. Handover-adjacency risk — `/admin/analytics/handover-risk`
Detect consultants running two consecutive high-acuity lists without a break: from `rota_assignments` joined to `theatre_sessions.list_type`, find same-day back-to-back sessions where both are in a configurable high-acuity set (emergency, trauma, vascular, cardiac). Rolling 12-week count per consultant.

### 8. New-starter early-warning — `/admin/analytics/new-starters`
Doctors with `profiles.start_date` within last 90 days: first-90-days sickness days, exception reports raised, unfilled mandatory competencies (from existing credentials data), short-notice changes received. Composite early-warning score with drill-in.

### Shared infrastructure

- New index route `/admin/analytics/index.tsx` — pack landing page with 8 cards linking out.
- `src/lib/analytics-gini.ts` — extract the Gini helper into a shared util (currently duplicated in `leave-fairness.ts`); both callers switch to the shared one.
- `src/features/analytics/*.ts` — one pure-TS module per analysis, each with a `compute*(input): result` shape and unit tests over fixtures.
- Server functions per analysis under `src/features/analytics/*.functions.ts` returning already-aggregated shapes so the UI stays thin.
- Nav: single **"HR analytics pack"** entry under `Audits & robustness` opening the index; individual reports reachable from there.

### Non-goals (kept out of this point)

- No new user-entered data (denial-reason taxonomy is inferred, not a form).
- No PDF export — deferred; tables are copy-pasteable and CSV-downloadable via existing table helpers.
- No scheduled email digests — deferred to a later iteration.

## Sequencing

1. Extract shared Gini util + tests.
2. Build the 8 pure-TS analysis modules with fixtures (parallel).
3. Server functions per analysis (`requireSupabaseAuth` + admin role check via `has_role`).
4. Index route + 8 detail routes (shared table/chart primitives).
5. Trainee-card embed for #4.
6. Nav entry.

## Technical notes

- All aggregation server-side in the server function to keep payloads small; UI receives arrays of ~hundreds of rows max.
- Reuse `recharts` (already a dep) for heatmaps and histograms; Gini rendered as a single number + a Lorenz-curve mini-chart.
- No schema migration required — all inputs are existing tables. If curriculum targets are sparse we surface "no target set" instead of red.
- Admin-gated: every server function checks `has_role(userId, 'admin')` and throws 403 otherwise; routes live under `_authenticated/admin.analytics.*`.

## Open question

Happy to build all 8, but if you want a faster first cut, tell me which 3–4 to prioritise (my pick would be #1, #2, #4, #8 — highest HR value, cleanest data). Otherwise I'll ship the full pack.
