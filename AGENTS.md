# Project rules

- Page every multi-row database read through `src/lib/paged-fetch-core.ts` (directly or via its wrappers) with a stable order — the API caps responses at 1000 rows and truncation must surface as an error, never as a short list.
- All leave-day counting, leave-year windows and proration go through `src/features/leave/leave-count.ts` — screens previously disagreed on the same dates.
- The TCS module is an estimated screen: never emit a definitive "compliant" result from inferred shift times.
- A failed fetch must render an error with Retry (`QueryErrorNotice`), never an empty or zero state; editors that validate against loaded data stay blocked until it loads.
- Dependency scanning runs `bun audit` on the committed `bun.lock`, validates lock/report schemas and fails closed; there is no alternate lockfile.
- Database schema/RLS checks are proven in the disposable harnesses `tests/db-harness/run.sh` (SQL cases) and `tests/db-harness/postgrest.sh` (real PostgREST), which apply the real repo migrations to a synthetic fixture mirroring live triggers/views.
- The audit SQL role reads only columns in the reviewed `audit_ro.column_allowlist`; never switch back to a computed denylist.
- Auth identity changes are applied synchronously (reset + loading gate + cache purge) before the new session is published; only network loads are deferred.
- Non-registry dependencies must be listed with exact resolution+integrity in `scripts/supply-chain-unscanned.json` or the scanner fails.
