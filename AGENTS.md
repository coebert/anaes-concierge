# Project rules

- Page every multi-row database read through `src/lib/paged-fetch-core.ts` (directly or via its wrappers) with a stable order — the API caps responses at 1000 rows and truncation must surface as an error, never as a short list.
- All leave-day counting, leave-year windows and proration go through `src/features/leave/leave-count.ts` — screens previously disagreed on the same dates.
- The TCS module is an estimated screen: never emit a definitive "compliant" result from inferred shift times.
- A failed fetch must render an error with Retry (`QueryErrorNotice`), never an empty or zero state; editors that validate against loaded data stay blocked until it loads.
- Dependency scanning runs `bun audit` on the committed `bun.lock` and fails closed; there is no alternate lockfile.
- Database schema/RLS checks are proven in the disposable harness `tests/db-harness/run.sh`, which applies the real repo migrations.
