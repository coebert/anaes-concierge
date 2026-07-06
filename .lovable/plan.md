## Files (top-3 giants)

1. `-list-feasibility-page.tsx` — 1575 lines, 15 top-level components
2. `admin.settings.tsx` — 1440 lines, 4 major cards + `SettingsPage` (~1140 lines)
3. `admin.dashboard.tsx` — 1388 lines, `AdminDashboardPage` (~1262 lines) + 2 stat components

The `SettingsPage` and `AdminDashboardPage` inner functions are enormous single-component blobs (~1140 and ~1262 lines respectively) — most of the win is breaking those up, not just extracting the co-located components that already sit at module scope.

## Approach

Follow the same pattern already used for CLWRota pages (`-clwrota-*-page.tsx` files alongside the route entry). For each of the three files:

- Keep the route file (`admin.settings.tsx`, `admin.dashboard.tsx`) tiny: `head()`, `errorComponent`, `notFoundComponent`, and `component: XxxPage` re-exported from a sibling `-xxx-page.tsx`.
- Extract self-contained UI blocks into sibling `-xxx-<block>.tsx` files (prefixed with `-` so the router treats them as private, non-route modules).
- Extract pure helpers (bucket/grade/type helpers, formatters, small hooks) into `src/features/<domain>/*.ts` files.
- Preserve behaviour exactly — no logic changes, only file boundaries.

## Concrete split

### 1. `-list-feasibility-page.tsx` (1575 → ~180)

New files, all under `src/routes/_authenticated/`:

- `-list-feasibility/page.tsx` — the outer `ListFeasibilityPage` + wiring
- `-list-feasibility/threshold-controls.tsx` — `ThresholdControls`
- `-list-feasibility/summary.tsx` — `DepartmentSummaryCard`, `SummaryPill`, `Stat`, `VerdictBadge`
- `-list-feasibility/slots-table.tsx` — `SlotsTable`
- `-list-feasibility/working-patterns-card.tsx` — `WorkingPatternsCard`
- `-list-feasibility/validation-card.tsx` — `ValidationCard`, `ValidationResults`, `ValidationConsultantRow`, `ValidationCellTable`, `RemediationActions` interface
- `-list-feasibility/diagnosis.tsx` — `DiagnosisList`, `ClassificationBadge`
- `-list-feasibility/assumptions-card.tsx` — `AssumptionsCard`

Re-export `ListFeasibilityPage` from `-list-feasibility-page.tsx` for one turn (backwards-compat) then repoint the route consumer.

### 2. `admin.settings.tsx` (1440 → ~120)

- `-admin-settings-page.tsx` — thin: assembles the cards
- `-admin-settings/clwrota-settings-card.tsx` — the huge CLWRota settings form (bulk of `SettingsPage`)
- `-admin-settings/investigate-solo-card.tsx` — `InvestigateSoloCard` (already exported; import site preserved)
- `-admin-settings/reclassification-undo-card.tsx` — `ReclassificationUndoCard`
- `-admin-settings/name-sort-preference-card.tsx` — `NameSortPreferenceCard`
- Route file becomes ~50 lines: `head`, `component: AdminSettingsPage` from sibling.
- The existing test `-admin.settings.investigate-solo.test.tsx` keeps working (imports the mocked server-fn module, not the page).

### 3. `admin.dashboard.tsx` (1388 → ~120)

`AdminDashboardPage` is one 1262-line function. Split it by tab / section (I'll confirm sections from a quick read before extracting):

- `-admin-dashboard-page.tsx` — orchestrator: layout, loaders, tab selection
- `-admin-dashboard/staff-section.tsx`, `-leave-section.tsx`, `-rota-section.tsx`, etc. (exact set determined from the section markers inside the function)
- `src/features/admin/dashboard-helpers.ts` — `traineeBucket`, `TraineeBucket`, `Grade`, `LEAVE_TYPES`, `LeaveType`, `DualStat`, `Stat`

The route file itself stays ~40 lines.

## Non-goals

- No behaviour changes; no styling changes; no tests added or removed.
- No changes to server functions or data-fetching hooks.
- Consumers/imports elsewhere are updated only where a symbol they import moves.

## Rollout

Do the three files sequentially in that order (biggest first), typechecking after each. This is roughly 15–20 new small files and edits to ~5 consumer imports. I'll stop after each of the three splits so you can eyeball the result before I move to the next.
