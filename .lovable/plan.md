# Pivot to an audit-first app

The product reframes around three audit pillars sourced from synced CLWRota data. AI rota-writing stays available but moves out of the primary navigation. No data is destroyed.

## 1. Navigation & home page reshape

- New home page (`/`) becomes an **Audit dashboard**: three headline cards (Trainee experience, Leave pressure, Rota robustness) plus a freshness indicator for the last CLWRota sync.
- Top-level nav order: **Home · Trainees · Leave · Robustness · Rota · Coordinator tools**.
- A new collapsed "Coordinator tools" group holds the existing AI-assisted surfaces: `/coordinator/rota` candidate editor, chat assistant's rota-writing tools, and `/admin/rules` custom rules. They keep working; they just stop being the entry point.

## 2. Trainee experience audit (`/trainees` + `/trainees/$staffId`)

Four lenses, all derived from `rota_assignments` + `theatre_sessions` + `specialties` + `trainee_targets`:

1. **Specialty breadth vs target** — heatmap of sessions per specialty per trainee per rolling window (4w / 12w / since rotation start), red/amber/green vs `trainee_targets.required_sessions`. Surfaces both under- and over-exposure.
2. **Solo vs supervised mix** — stacked bar per trainee with the running ratio against `required_solo` / `required_supervised`, plus a trend line.
3. **Named supervisor exposure** — diversity index: distinct consultants the trainee has worked with in the window, list of who they've never been paired with, flag for "narrow exposure" when below a configurable threshold.
4. **Time-on-list / displacement** — counts of sessions where a trainee was reassigned off a training list (training role removed and replaced with `solo` duty), using `rota_change_log` + `locally_modified` flag to detect the displacement. Aggregates lost training hours per trainee.

Per-trainee page combines all four with date-range filter and CSV export.

## 3. Leave pressure forecast (`/leave/forecast`)

- Calendar heatmap (day cell darkens with concurrent approved + pending leave count), filterable by grade and specialty.
- Sidebar shows top-10 highest-pressure weeks in the next 6 months and recurring annual hot spots (school holidays, Christmas, August handover) derived from prior years' approved leave.
- "Surge prediction" panel ranks upcoming weeks by request density relative to capacity; flags weeks projected to exceed a configurable threshold (default: >25% of any grade off).
- Per-day drill-in lists the people off and links back to their leave request.

## 4. Rota robustness — default report + what-if

Default view (`/robustness`) is the **forward-looking risk report**:

- For each session in the next 12 weeks, compute baseline staffing headroom: required staff for the listed theatres (from `theatre_sessions`) minus available staff after subtracting confirmed leave, fixed commitments, post-on-call rest, and LTFT days off.
- Each session row gets a coverage score (green/amber/red) and a primary risk reason (e.g. "Only 1 consultant spare", "All trainees committed").
- Weekly summary cards highlight the worst days.

Drill-in opens the **what-if simulator** (`/robustness/simulate?date=…`):

- Select a date and add hypothetical absences by grade/specialty/named person.
- The engine re-runs the same coverage calculation and produces an outcome:
  - Lists that can still run as planned
  - Lists where a trainee would need to be moved to solo (and which trainee, based on grade + recent solo deficit)
  - Lists that would have to be cancelled
- Shows a one-line summary: *"2 cancellations, 3 trainees pulled from training, 1 SPA reallocated"* and an exportable PDF for the coordinator.

## 5. Coordinator tools section (kept, de-emphasised)

- `/coordinator/rota` (AI candidate suggestions), chat rota tools, `/admin/rules` (custom rota rules) all remain functional and reachable from the "Coordinator tools" nav group.
- The home page no longer surfaces them; the chat assistant's system prompt is updated so rota-writing is offered as an opt-in capability rather than the primary suggestion.
- No tables dropped, no server functions removed.

## Technical notes

- **New tables**: none required for pillars 2 and 3 (everything is derivable from existing tables). For pillar 4 we add a single `robustness_settings` row (default thresholds: minimum consultants per session by specialty, % off-sick warning level) — admin-editable.
- **New server functions** (all `createServerFn` + `requireSupabaseAuth`, in new `src/lib/audit/`):
  - `getTraineeAudit({ staffId?, from, to })`
  - `getLeavePressure({ from, to, grade? })`
  - `getRobustnessReport({ from, to })`
  - `simulateRobustness({ date, absences: [{ grade, count } | { staffId }] })`
- **New routes**: `/_authenticated/index.tsx` (rewrite), `/_authenticated/trainees.tsx` (rebuild around lenses), `/_authenticated/leave.forecast.tsx`, `/_authenticated/robustness.tsx`, `/_authenticated/robustness.simulate.tsx`.
- **Reused logic**: `solo-stats.ts`, `trainee-metrics.ts`, `rota-validation.ts`, leave allowance utilities — all stay; new audit functions compose them.
- Implementation order: (a) nav + home reshape and Coordinator-tools grouping → (b) trainee audit lenses → (c) leave forecast → (d) robustness report → (e) what-if simulator.

Build phase (a) plus the trainee lenses first to make the audit shift visible, then layer leave and robustness on top. Each phase is independently shippable.
