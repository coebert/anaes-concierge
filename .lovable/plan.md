## Phase 5 — Loading, empty, and residual token polish

Prior phases built primitives (`StatCard`, `EmptyState`, `StatusBadge`, `ThemeToggle`) and a semantic token palette. Phase 5 finishes the rollout so no page still shows bare "Loading…" text, hand-rolled empty panels, or leftover emerald/amber utility classes.

### Scope

**1. Loading primitives**
- Add `src/components/loading.tsx` exporting:
  - `PageLoading` — centered `Loader2` spinner + label, replaces the bare `<div>Loading…</div>` at 44 call-sites.
  - `StatGridSkeleton` — 4-tile skeleton matching `StatCard` layout, for dashboard first paint.
  - `RowsSkeleton` — 3–8 shimmering rows for table/list pages.
- Sweep `src/routes/**` + `src/features/**` to swap bare "Loading…" strings for `<PageLoading />`.

**2. Empty state adoption**
- Replace the ~11 hand-rolled `border-dashed` "no data" cards with `<EmptyState>` (icon, title, description, optional action) across `admin.audit-tool.tsx`, `admin-audit-tool/panels.tsx`, and the handful of remaining offenders.

**3. Residual token sweep**
- 76 occurrences of `bg-emerald-*` / `bg-amber-*` / `text-emerald-*` / `text-amber-*` remain (bespoke banners, mixed classes like `bg-amber-500/15 text-warning`). Map them onto the Phase 2 semantic tokens (`bg-success-muted text-success`, `bg-warning-muted text-warning`, `border-warning/40`, etc.) using a targeted Python sed pass followed by a visual spot-check of the dashboard sync banner and rota-gap components.

**4. Verify**
- `bunx tsgo --noEmit`
- Playwright screenshot of `/` (admin dashboard) at 1280 desktop + 440 mobile to confirm skeleton flash and banner colors under both light and dark themes.

### Out of scope

- Sidebar/mobile nav restructure (Phase 6 candidate).
- Command palette redesign.
- Any business-logic or data-fetching changes.

### Files created

- `src/components/loading.tsx`

### Files edited (estimated)

- ~15 route/feature files for "Loading…" → `<PageLoading />`
- ~5 files for `border-dashed` → `<EmptyState>`
- ~30 files touched by the token sweep (mechanical)
