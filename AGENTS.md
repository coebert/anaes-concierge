# Project rules

- Page every multi-row database read through `src/lib/paged-fetch-core.ts` (directly or via its wrappers) with a stable order — the API caps responses at 1000 rows and truncation must surface as an error, never as a short list.
- All leave-day counting, leave-year windows and proration go through `src/features/leave/leave-count.ts` — screens previously disagreed on the same dates.
- The TCS module is an estimated screen: never emit a definitive "compliant" result from inferred shift times.
- A failed fetch must render an error with Retry (`QueryErrorNotice`), never an empty or zero state; editors that validate against loaded data stay blocked until it loads.
- Dependency scanning runs `bun audit` on the committed `bun.lock`, validates lock/report schemas and fails closed; there is no alternate lockfile.
- Database schema/RLS checks are proven in the disposable harnesses `tests/db-harness/run.sh` (SQL cases) and `tests/db-harness/postgrest.sh` (real PostgREST) for migrations 0000–0006, and `tests/db-harness/definer/run.sh` (non-superuser postgres owner in service_role, SQL + real PostgREST) for 0007+ — the earlier fixture's superuser owner cannot reproduce definer-identity bugs.
- SECURITY DEFINER bodies never use current_user/pg_has_role(current_user, …) to identify the caller (it is the owner); use `_request_is_service_role()` / `_request_is_authenticated_user()` / `_request_is_active_admin()` / `_request_is_verified_scheduler()` from migration 0007.
- The audit SQL role reads only columns in the reviewed `audit_ro.column_allowlist`; never switch back to a computed denylist.
- Auth identity changes are applied synchronously (reset + loading gate + cache purge) before the new session is published; only network loads are deferred.
- Non-registry dependencies must be listed with exact resolution+integrity in `scripts/supply-chain-unscanned.json` or the scanner fails.
- Wellbeing scores below the coverage gate (`MIN_ASSESSABLE_SESSIONS`) are `unknown`, never a good score; admin retention inputs go through `src/features/wellbeing/admin-inputs.ts` with an explicit as-of date — absent or future data must not read as good wellbeing.
- The retention "attrition" rubric is an unvalidated signal score shown as x/100 with the band picked from the displayed integer; never present it as a prediction or probability.
- Every handler that uses service-role data or privileged tools first passes the shared active-membership check (`src/lib/app-membership.ts` / `requireActiveMember`), failing closed — a valid token alone is not membership.
- Assistant streams hold a durable per-user lease (`chat_stream_leases` RPCs) released on finish/error/abort with TTL recovery; refuse the request if the lease store is unavailable.
- Theatre pressure forecast tags come only from explicit whole-word labels in `src/features/audit/theatre-pressure.ts` (never surgeon, theatre name or specialty), and raw label text/IDs are stripped before caching or display — the import keeps only one free-text field, so missing labels must read as unknown.
