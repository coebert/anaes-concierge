# Streamlining the app's information architecture

The sidebar currently shows ~25 flat links across three sections (Main, Coordinator tools, Administration with 13 entries). Names overlap ("Audit dashboard" vs "Rota audit data" vs "AI audit tool" vs "TCS 2016 audit"), related tools are scattered, and there is no search. The plan groups related views, collapses rarely-used ones, and adds a global command palette so power users never have to scroll the sidebar.

## 1. Regrouped, collapsible sidebar

Replace the three flat lists with **task-oriented groups** built on the shadcn `Sidebar` (collapsible to icon-rail). Proposed grouping:

```text
Home                       /                (audit dashboard)

Rota
 ├─ Theatre rota           /coordinator/rota
 ├─ Theatre grid           /admin/theatre-grid       (admin)
 ├─ Duties & on-call       /coordinator/duties
 ├─ Rota gaps              /admin/rota-gaps          (admin)
 └─ My rota                /me

Leave
 ├─ My leave               /leave
 ├─ Approve leave          /coordinator/leave        (coord)
 ├─ Leave forecast         /leave/forecast           (coord)
 └─ Global calendar        /calendar

Audits & robustness
 ├─ Robustness overview    /robustness
 ├─ List feasibility       /robustness/list-feasibility
 ├─ Consultant feasibility /robustness/consultant-feasibility
 ├─ Simulator              /robustness/simulate
 ├─ Trainee audit          /trainees                (trainee/admin)
 ├─ TCS 2016 audit         /admin/tcs-audit         (admin)
 ├─ Rota audit data        /admin/dashboard         (admin)
 └─ AI audit tool          /admin/audit-tool        (admin)

Assistant
 └─ AI assistant           /chat

Setup                                                (admin, collapsed by default)
 ├─ Staff
 ├─ Job plans
 ├─ Theatres
 ├─ Duty mappings
 ├─ Duty categories
 ├─ Working rules
 ├─ Access requests
 ├─ CLWRota metrics
 └─ Settings

Account
 └─ My account             /account
```

Each group renders as a `SidebarGroup` with a label; "Setup" starts collapsed via `defaultOpen={false}`. The active branch auto-expands using `useRouterState`. Icon-rail mode keeps the sidebar usable when collapsed.

## 2. Global command palette (Cmd/Ctrl + K)

Add a `CommandDialog` (shadcn `cmdk`) wired to the same grouped catalogue. It opens from anywhere with a keyboard shortcut or a search-shaped button in the top bar, and lets users jump straight to any tool by typing 2–3 letters. This is the single biggest agility win: 25 items become irrelevant when search is one keypress away.

## 3. Renames for clarity

A few labels overload the word "audit". Proposed renames (no route changes):

- "Audit dashboard" (home) → **"Home"**
- "Rota audit data" → **"Rota source data"**
- "AI audit tool" → **"AI audit assistant"** (or fold into the Assistant group)
- "Rota editor" → **"Theatre rota"** (it is the theatre weekly editor)

## 4. Home page becomes a launcher

The current `/` is a dense audit dashboard. Add a compact **"Jump to…"** strip at the top with the 6 most-used tools for the user's role (e.g. Theatre rota, Approve leave, Robustness, Theatre grid, My rota, AI assistant). Existing dashboard content stays below. This shortens the path for the common journeys users described as hard to find.

## 5. Top-bar polish

- Desktop: add a slim top bar (currently mobile-only) containing the sidebar toggle, the Cmd+K search button, and the user menu. Removes the always-visible "Back" button on every page and replaces it with breadcrumbs derived from `useRouterState` matches.
- Mobile: same Sheet drawer, now grouped, plus a Cmd+K button.

## Technical notes

- Centralise the nav catalogue in `src/lib/navigation.ts` as `{ id, label, to, icon, roles?, group }[]` so the sidebar, command palette, and home launcher all read from one source. Eliminates the current drift between `NAV` / `COORDINATOR_NAV` / `ADMIN_NAV`.
- Replace the hand-rolled `<aside>` in `src/components/app-shell.tsx` with shadcn `Sidebar` + `SidebarProvider`. Keep the existing `useAuth` role filtering — apply it once when computing visible items from the catalogue.
- Command palette: new `src/components/command-palette.tsx` using `Command*` from `@/components/ui/command` inside `CommandDialog`. Register a global `useEffect` keydown listener for Cmd/Ctrl+K.
- Breadcrumbs: small helper that turns the active route's `staticData.title` (added per route) or pathname segments into `Breadcrumb` items. Falls back to the route label from the nav catalogue.
- No backend or business-logic changes; this is presentation/IA only.

## Out of scope

- Renaming URL paths (would break bookmarks).
- Removing any tool — every existing view stays reachable.
- Visual redesign / theming.
