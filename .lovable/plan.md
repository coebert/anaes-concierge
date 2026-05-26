
# Salisbury Anaesthetics Rota App — Build Plan

A clinically-aware rota coordination app for the anaesthetics department, with Lovable Cloud as the backend, Lovable AI for the assistant, Resend for inbound/outbound email, and a CLWRota-ready data model so sync can be plugged in later.

## 1. Roles & access (RBAC)

Three roles, stored in a dedicated `user_roles` table (never on `profiles`) with a `has_role()` SECURITY DEFINER function used by RLS.

- **Admin** — manage staff, job plans, theatres, specialties, training requirements, role assignments.
- **Rota Coordinator** — build/edit rota, approve or reject leave, run AI assistant for planning.
- **Staff** (consultants, SAS, trainees) — view global + personal rota, submit leave, chat with AI about own rota/leave. Trainees additionally see a competency dashboard.

Auth: email/password + Google, via Lovable Cloud. Profiles table linked to `auth.users`, auto-created via signup trigger. Protected routes under `_authenticated/`; coordinator/admin routes gated by a further `beforeLoad` role check.

## 2. Core data model (Lovable Cloud / Postgres)

- `profiles` — display name, grade (`consultant | sas | trainee`), email, GMC number, start date, etc.
- `user_roles` — `(user_id, role)` for Admin/Coordinator/Staff.
- `job_plans` — `staff_id`, total PAs/week, LTFT flag + percentage, contracted DCC vs SPA split, on-call commitment, fixed sessions (regular day/list patterns, e.g. "Mon AM Theatre 3", "Thu PM Day Surgery A"), valid_from/valid_to.
- `working_pattern_rules` — derived constraints (e.g. EWTD rest, max consecutive nights, "never works Wednesdays").
- `theatres` — 13 rows seeded: Main 1–10, Day Surgery A/B/F.
- `theatre_sessions` — `(date, theatre_id, session: 'am' | 'pm', specialty, surgical_consultant, notes)`, edited by admins.
- `rota_assignments` — `(date, session, staff_id, theatre_session_id nullable, role_on_list: 'solo' | 'supervised' | 'supervising' | 'on_call' | 'non_clinical', supervisor_id nullable, source: 'manual' | 'clwrota')`.
- `leave_requests` — `(staff_id, type: annual|study|compassionate|sick|parental, start, end, sessions[], status, reason, decided_by, decided_at, conflict_notes)`.
- `leave_allowances` — annual entitlements per staff per leave year (pro-rated by LTFT).
- `trainee_subspecialty_targets` — required sessions per subspecialty per training level (RCoA-style buckets: obstetrics, paeds, cardiac, neuro, regional, ICM, pain, etc.) + required solo/supervised counts.
- `trainee_progress` — materialized counts per trainee derived from `rota_assignments` + `theatre_sessions.specialty`.
- `ai_conversations` / `ai_messages` — per-user chat threads.
- `email_inbound_log` — raw inbound emails (webhook), matched user, assistant reply, status.
- `clwrota_sync_state` — last sync, cursor, mapping table between CLWRota staff IDs and our `profiles.id`. Empty for v1.

RLS: staff can read their own rows + global rota + theatre grid; coordinators/admins broader access via `has_role()`.

## 3. UI surfaces

Routes (TanStack Start, file-based under `src/routes/`):

- `/login`, `/signup`, `/reset-password` — public.
- `/_authenticated/` layout (auth gate).
  - `/` — dashboard: today + tomorrow, my next sessions, pending leave, alerts.
  - `/calendar` — **global calendar view**: month/week/day; toggle by theatre, by specialty, by staff group. Each day shows AM/PM columns × 13 theatres.
  - `/calendar/staff/$staffId` — **individual rota view** with leave, sessions, on-call.
  - `/me` — my rota, my leave balance, my job plan summary.
  - `/leave` — submit + track my requests.
  - `/chat` — AI assistant (threaded conversations, persisted, AI Elements UI).
  - `/trainees/$staffId` — competency dashboard (only own for trainees, all for coord/admin).
  - `/coordinator/leave` — approval queue with conflict checks.
  - `/coordinator/rota` — edit grid (drag-to-assign per session).
  - `/admin/staff`, `/admin/job-plans`, `/admin/theatres`, `/admin/training-requirements`, `/admin/clwrota` (placeholder settings page).
- `/api/chat` — streaming chat server route (Lovable AI Gateway, `google/gemini-3-flash-preview`, tools for read-only rota/leave queries).
- `/api/public/inbound-email` — Resend inbound webhook (signature-verified).

Design system: clinical, calm, dense-but-legible. Tokens in `src/styles.css` (semantic only). Calendar uses a custom grid (not a generic library) so AM/PM × theatre fits naturally.

## 4. Leave workflow

- Staff submits → system computes affected sessions, flags conflicts (gaps in cover, breaches of working-time rules, trainee curriculum impact).
- Coordinator queue shows requests with auto-generated impact summary (powered by a server function, optionally narrated by the AI).
- Approve → write `rota_assignments` deletions/markers and decrement allowance.
- Email notifications via Resend to requester on decision.

## 5. AI chat assistant (in-app + inbound email)

- **In-app**: AI Elements (`conversation`, `message`, `prompt-input`, `shimmer`, `tool`). Threads persisted in Lovable Cloud per user, with dedicated route `/chat/$threadId`.
- Server: `streamText` via Lovable AI Gateway with **read-only tools** (`getMyRota`, `getStaffRota`, `getLeaveBalance`, `findCoverGaps`, `getTraineeProgress`, `searchTheatreSessions`). All tools enforce the caller's role/identity server-side — staff can only query their own data unless coordinator/admin.
- **Inbound email**: Resend inbound route → verify signature → match `from` to a `profiles.email` → run the same agent loop with that user's identity → reply via Resend. Log everything in `email_inbound_log`.

## 6. Trainee competency tracking

- Admin defines per-level requirements (e.g. ST4 cardiac: 20 sessions, of which ≥10 solo).
- Nightly (or on-demand) job recomputes `trainee_progress` from `rota_assignments` joined with `theatre_sessions.specialty` and `role_on_list`.
- Trainee dashboard shows per-bucket progress bars, gaps, and a "what the current rota will give you over the next N weeks" projection.
- Coordinator view flags trainees falling behind so future allocations can compensate.

## 7. CLWRota integration (deferred but designed in)

- Build manual entry now. Add `source` column and external-ID columns on all relevant tables so a future sync writer can upsert without schema churn.
- Add a settings page where an admin can paste a CLWRota API key (stored as a secret via the secrets tool — never in the DB).
- Stub server function `syncClwRota()` that returns "not configured" until the integration is wired. When you have the API key + docs, we add the actual fetch + mapping there; UI already exists.

## 8. Build order

1. Enable Lovable Cloud; auth (email + Google) + profiles + user_roles + `has_role()` + protected layout.
2. Admin staff + job plan CRUD; theatres seed; theatre sessions admin grid.
3. Rota assignments + global calendar + individual staff view.
4. Leave requests end-to-end (submit, approve, allowance, conflict checks, email notifications via Resend).
5. Trainee training-requirement model + progress dashboard.
6. AI chat (in-app, threads, tools, streaming).
7. Inbound email route (Resend webhook + signature verification).
8. CLWRota settings page + stub sync.
9. Polish: dashboard, alerts, exports (ICS feed per staff member).

## Technical notes

- Stack: TanStack Start, Lovable Cloud (Supabase under the hood), Lovable AI Gateway, AI SDK + AI Elements, Resend connector for outbound + inbound email.
- All AI/model calls and Resend calls happen server-side (`createServerFn` or server routes). `LOVABLE_API_KEY` and `RESEND_API_KEY` stay on the server.
- All inputs validated with Zod. RLS on every table. Role checks via `has_role()` SECURITY DEFINER, never client-side.
- Inbound email endpoint lives at `/api/public/inbound-email` and verifies the webhook signature before doing anything.
- CLWRota API key, once provided, will be added via the secrets tool — not requested in chat.

## Open items I'll need from you during the build

- Job plan template (do you want exact PA breakdown by activity, or just totals + fixed sessions?).
- The full list of subspecialty buckets and per-level training targets you want to track (or I'll seed sensible RCoA-aligned defaults you can edit).
- Resend sending domain (otherwise we use `onboarding@resend.dev` while testing) and the inbound address you want to publish.
- A list of current staff to seed, or we start with an empty admin and you add them.
