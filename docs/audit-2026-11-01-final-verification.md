# Final verification — 2026-11-01

## Consolidated closeout (sections 1–5) — final run on tree `c51ab01e` (+ this pass's saved edits)

Synthetic data only. Nothing published; no email/push/LLM/CLWRota calls; no real
rows changed; database guards and migrations unchanged in this pass.

### Changes
1. **Workflow/auth** (previous turn): cancel sends only `{status:"cancelled"}`;
   decisions take actor/time from the DB and reconcile the returned row; 0-row
   updates roll back. Auth null-identity load checks the generation token
   before clearing `loading`.
2. **Aggregate reads:** last-minute changes already paged; admin dashboard
   annual-leave read paged and now picks each staff member's allowance **for
   the leave year covering each month** (was: an arbitrary year's row); audit
   tool snapshot theatres/specialties now paged (duty categories, staff groups,
   profiles were already paged; snapshot failure omits the block entirely).
3. **Study cost (owner: "leave the cost allocation for manual review"):**
   cross-year course costs are charged to **neither** year; `unallocatedCosts`
   / `unallocatedGbp` are listed and `balanceProvisional=true`; the budget card
   and coordinator line say the £ balance is provisional. No manual-allocation
   field exists, so none is used or invented. Days still split by date.
4. **Frontend reliability:** every retained summary-dashboard tile shows a
   "Couldn't refresh — showing last loaded version" warning with Retry;
   absence summary cards show "…" while loading, "—" when failed, and a stale
   warning with Retry when a refresh fails. Rota cell dialog: Assign is
   disabled while any of list / assignments / competencies / requirements /
   sign-offs / practice prefs / specialty prefs / custom-rule check is pending
   or failed (each with Retry); list Save is disabled and an error shown when
   the list read fails. Only a successful empty read counts as "no config".
5. **Chat/inbox/lint:** hard 240 s stream deadline (< 600 s lease TTL) that
   aborts upstream work, errors the outgoing stream, then releases the lease
   once (`src/lib/chat-stream-deadline.ts`). Last-minute changes: no more
   `emptyAudit()` on failure — errors reach the page's Retry and totals show
   "—"; profile/theatre lookups in ≤200-id chunks; missing required staff /
   list joins and malformed rows throw. Inbox dismissals ordered by `item_id`,
   inbox gated on the dismissal read with Retry, mutations disabled while
   unknown. `pagedRows` order keys are now typed to real table columns
   (incl. `-col`); a `@ts-expect-error` test proves `inbox_dismissals.id` is
   rejected, and the full typecheck found no other wrong column.
   `paged-select.test.ts` lint suppression removed.
6. **Login:** a dropped connection returned as an error result (not a throw)
   showed raw "Failed to fetch"; now shows the friendly connection message.

### KaTeX (GHSA-238p-pmpm-9mq7, low)
KaTeX now receives **own, frozen** options with `trust:false` (plus
`maxExpand`/`maxSize`, `throwOnError:false`); `rehype-katex@7.0.1` declared
directly at the already-locked version. Render tests confirm KaTeX actually
renders and `\href{javascript:…}`, `\htmlId`, `\htmlData` produce no link/
attributes; Streamdown strips `<script>`, `on*` handlers and `javascript:` links.
Mermaid runs at `securityLevel:"strict"`. **Not claimed fixed**: katex 0.16.47
is still in the lock and the audit still reports it; no global prototype
workaround added.

### Simulated vs real checks
- **Simulated browser (Playwright, localhost, all external network faked):**
  login at 1280 px and 375 px — connection failure → friendly message, button
  re-enabled; invalid credentials → message; no horizontal overflow (0 px).
- **Component-level (jsdom, mocked services):** rota dialog delayed/failed per
  source (14 cases), inbox dismissal column + failure/recovery, chat rendering
  safety, chat stream deadline with fake clock (hung, slow, cancel, error),
  last-minute-changes consumer (2,500 rows, page-2 failure, missing join,
  malformed row), study cost two-year cases.
- **Not done / blocked:** signed-in browser flows (admin/coordinator/trainee
  routing, leave submit/cancel totals, year switching, assistant init Retry,
  375 px conversation drawer, stale dashboard) need a real account, which is
  out of scope; they are covered only at component level where listed above.
  The custom-rule-check failure gate is enforced in code but not driven in a
  test (selecting staff in the dialog's dropdown is not reliable in jsdom).
  A "WB DIAG" label seen on the preview login page is not in the app's code
  (injected by preview tooling).

### Final results (single run, same tree)
| Check | Result |
|---|---|
| Tests | 195 files; **1,964 passed, 4 skipped** (live-RLS probes needing credentials), 0 failed |
| Typecheck | clean |
| Lint | **0 errors, 44 warnings** |
| Production build | passes (`NODE_OPTIONS=--max-old-space-size=6144`) |
| DB harness SQL | 159 cases, 0 failures |
| DB harness PostgREST | 12 cases, 0 failures |
| Definer harness | 152 cases, 0 failures |
| Dependency check | **fails (by design)**: moderate esbuild ≤0.24.2, moderate minimatch <11.0.1, low katex; xlsx reported unscanned |
| Platform security scan | not re-run in this pass |

Note: the rota-dialog and absence/dashboard fixes run against the existing
1000-row-capped reads for competencies/preferences in the dialog; those reads
were not converted to paging in this pass.


Follows `audit-2026-11-01-accuracy-remediation.md`. Covers the six remaining
defects that were reproduced independently. **Synthetic data only.** Nothing was
published; no notifications, emails or CLWRota syncs; no staff, rota or leave
rows were changed. The one live database change was grants/functions (DDL)
only. The dangerous audit-SQL examples were run **only** on disposable local
clusters, never on the live database.

## DEFINER CALLER-IDENTITY FIX + WELLBEING CLOSEOUT (supersedes the sections below)

**Synthetic data only.** Not published. No live privileged function was invoked,
no sync/HTTP was sent, no business rows were read or changed. Live reads were
catalog metadata only (function definitions, ACLs, role membership,
`cron.job` username/booleans — no command text, no secrets).

### Defect (reproduced)
Live metadata: functions owned by `postgres`; `postgres` is NOT superuser, is
BYPASSRLS and a member of `anon`, `authenticated`, `service_role`; all 15
`cron.job` rows have `username = postgres`. Inside SECURITY DEFINER,
`current_user` is the owner, so `current_user = 'service_role' OR
pg_has_role(current_user,'service_role','MEMBER')` was always true. Phase 1 of
`tests/db-harness/definer/run.sh` loads the verbatim live bodies and proves it:
staff A read staff B's decrypted AI chat; staff A read all 3 RTW interviews;
staff A and a postgres session switched to `authenticated` enqueued sync calls;
staff A and a no-claims authenticated session passed the cron-listing and
competency guards; `rpc_access_audit.db_role` recorded `postgres`.

Also found: `get_competency_eligibility` and `list_clwrota_cron_runs` failed
with 42702 (ambiguous OUT column) on every call past the guard, because live
`plpgsql.variable_conflict = error`. Fixed with `#variable_conflict use_column`
(no logic change).

### Fix — migration `0007_definer_caller_identity` (applied live after proof)
New INVOKER helpers (service_role-only EXECUTE):
`_request_is_service_role()` = JWT role claim `service_role` AND switched role
GUC `service_role` (a forged claim under `authenticated` fails);
`_request_is_authenticated_user()` = uid present AND claim `authenticated` AND
role GUC `authenticated`; `_request_is_active_admin()`;
`_request_is_verified_scheduler()` = `session_user = postgres`, role GUC
`none`/`postgres`, no request claims; `_request_caller_kind()` for audit.

| Function | Live access now |
|---|---|
| get_ai_messages_decrypted | service; conversation owner who is an active member; active coordinator/admin |
| get_rtw_interviews_decrypted | service; own rows (active member); active coordinator/admin |
| get_competency_eligibility | service; any active member (roleless/inactive/missing profile → 42501) |
| list_clwrota_cron_runs, detect_rpc_access_anomalies | service; active admin |
| decrypt_ai_message_parts, decrypt_owner_or_coord, decrypt_coord_only, admin_decrypt_text/jsonb | service_role EXECUTE only; bodies use the new helpers |
| log_rpc_access | `db_role` = real caller kind (`authenticated`, `service_role`, `scheduler:postgres`, `unverified:…`) |
| trigger_clwrota_sync, _with_query, _rate_limited, _all_rate_limited | **closed by grant**: EXECUTE only service_role + owner postgres |

**Deviation, stated plainly:** the four sync bodies read the webhook secret, and
the migration tool refuses any SQL that touches secret storage ("Agent access
to secrets is not allowed"), so their bodies could not be rewritten. Instead
`authenticated`, `anon` and PUBLIC lost EXECUTE. The stale `current_user` test
is still in those four bodies but no request role can reach it. Consequences:
(a) admins can no longer call them directly over the API — the app never did;
it triggers through server functions that check admin then use the service
role; (b) the scheduler is the owner `postgres` (cron username verified), not
an in-body scheduler check; (c) any `postgres` session (operator access) can
still run them. Rewriting the bodies to use `_request_is_verified_scheduler()`
needs someone with secret-storage permission to apply them.

### Proof — `tests/db-harness/definer/run.sh`: 152 cases, 0 failures
PostgreSQL 16.13 + PostgREST 14.1; non-superuser `postgres` owner in
`service_role`; stub `net.http_post` queue; dummy secret; synthetic staff A/B
(separate encrypted chats and RTW), coordinator, admin, inactive admin,
departed staff, roleless, role-without-profile. Exact SQLSTATE / row content /
queue delta per case: 7 trap reproductions on live bodies; after 0007 — chat
and RTW cross-read denied (0 rows), own and coordinator/admin reads correct,
anon/authenticator-without-role 42501, no-claims authenticated, forged service
claim, forged admin sub under anon, postgres switched to authenticated all
denied; direct helper calls 42501; every forbidden sync call enqueues 0;
service and scheduler enqueue exactly 1 (all-steps: 3); all queued rows carry
only the expected URL and dummy secret; audit rows read
`A/authenticated, null/service_role, null/scheduler:postgres`. Real PostgREST:
25 GET/POST cases incl. bad-signature and `alg=none` JWTs (401).
Live metadata after apply: all 15 functions have the expected ACLs; no
authenticated-executable definer function still tests `current_user`.

### Database linter: 16 warnings → 12 (+3 info unchanged)
Resolved (4): the four sync triggers (no longer authenticated-executable).
Remaining 12, reviewed, intended for signed-in users, no suppressions:
`get_ai_messages_decrypted`, `get_rtw_interviews_decrypted`,
`get_competency_eligibility`, `list_clwrota_cron_runs`,
`detect_rpc_access_anomalies` (fixed bodies above); `has_role`,
`current_user_is_coordinator_or_admin` (RLS helpers, require active profile);
`admin_run_readonly_sql` (admin + read-only + column allowlist, harnessed);
`get_leave_ledger_decrypted` (own rows or coordinator/admin; nested decrypt
fixed); `get_pulse_aggregate` (coordinator/admin only);
`get_pulse_responses_decrypted` (own or admin); `get_recognition_decrypted`
(public entries, own, sender, or admin — **follow-up:** public entries are not
membership-gated, so a signed-in but inactive account can read them).
Info (3): RLS on, no policies — `passkey_challenges`, `request_quota_buckets`,
`chat_stream_leases`: service-only by design.

### Wellbeing closeout
- Admin page: "Staff listed" (all rows) and "Staff assessed" (score known) are
  separate cards; "Not enough data" unchanged. Caveat now says scores use only
  the records in the app and the 10-session minimum is a conservative display
  threshold, not validated data sufficiency.
- Retention factor reads "Wellbeing not assessed" when the score is unknown
  (was e.g. "Wellbeing 100/100").
- RTW counts as completed only if `conducted_at <= asOf`.
- Weights, caps and bands unchanged. Bradford untouched (concern dismissed).
- New tests fail on the old code (checked by temporarily reverting) and pass now.

### Checks
Tests 1,923 passed, 4 skipped, 0 failed (190 files). Typecheck clean. Lint
0 errors, 44 warnings. Production build passes (needed
`NODE_OPTIONS=--max-old-space-size=6144`; default heap ran out). DB harnesses:
149/149 SQL, 12/12 PostgREST, 152/152 definer.

### Not verified
Live behaviour of the new guards was not invoked (by instruction). Expected
signals to watch: the next `clwrota-sync-*` cron runs, and the 5-minute
anomaly hook (service path). The real-browser checks listed below are still
open.

## FINAL STATE (after the membership / pagination / leases / lint pass)

This section supersedes the release status and results table further down,
which describe the earlier pass. Synthetic data only; nothing published; no
emails, pushes or CLWRota syncs; no staff, rota or leave rows changed. One
additive migration was applied to the live database (functions, grants and a
new service-only table — no business rows touched).

### Release status

**Still not release-clean, for one reason only:** the dependency check exits 1
on three upstream advisories that have no compatible fix (table below). Lint,
typecheck, the full suite, both DB harnesses and the production build pass.

### Commands and exact results (final saved code)

| Check | Command | Exit | Result |
|---|---|---|---|
| Unit/integration suite | `bunx vitest run` | 0 | 190 files; **1,920 passed, 4 skipped** (live-RLS probes needing credentials), 0 failed |
| Typecheck | `bunx tsgo --noEmit -p .` | 0 | 0 errors |
| Lint | `bunx eslint .` | **0** | **0 errors**, 44 warnings (33 `react-refresh/only-export-components`, 11 `react-hooks/exhaustive-deps`). No rule disabled, no ignore added. |
| Production build | `NODE_OPTIONS=--max-old-space-size=6144 bunx vite build` | 0 | built |
| SQL harness | `PG=… bash tests/db-harness/run.sh` | 0 | **149 cases, 0 failures** (incl. 8-way concurrent lease race: exactly 2 granted at cap 2) |
| PostgREST harness | `PG=… PGRST=… bash tests/db-harness/postgrest.sh` | 0 | **12 cases, 0 failures** (PostgREST 14.1) |
| Dependency audit (real `bun.lock`) | `node scripts/check-supply-chain.mjs` | **1** | 1,153 packages; 2 moderate, 1 low; xlsx listed UNSCANNED (reviewed pin) |

Platform scans were not re-run: the previous pass ran them the same day; the
deep code scan remains **blocked** (cannot be started from here), not zero.

### Remaining advisories (no suppression)

| Package@version | Severity | Scope | Pulled in by | Why not fixed |
|---|---|---|---|---|
| esbuild@0.18.20 (≤0.24.2) | moderate | build tooling only (migration CLI) | drizzle-kit → @esbuild-kit/esm-loader → @esbuild-kit/core-utils (`~0.18.20`) | Latest drizzle-kit (0.31.11) still depends on it; core-utils is deprecated upstream. Overriding a `~0.18` pin to ≥0.25 is an incompatible API jump. |
| minimatch@3.1.5 and @10.2.5 (<11.0.1) | moderate | lint tooling only | eslint, @eslint/eslintrc, @eslint/config-array (`^3.1.5`); typescript-estree (`^10.2.2`) | Fix is a new major; eslint requires the v3 API. Not overridden. |
| katex@0.16.47 (<0.18.2) | low | **runtime** (maths rendering in assistant chat) | @streamdown/math, rehype-katex, mermaid (all `^0.16`) | Every dependent pins `^0.16`; 0.18 is a breaking line under 0.x semver. Not overridden blindly. |

### What changed in this pass

1. **Active membership gate (fail closed).** `src/lib/app-membership.ts`
   requires ≥1 role **and** a profile with `active = true` and `left_at IS
   NULL`; lookup errors → 503, every other denial → the same generic 403 (no
   account-existence signal). Applied before: `/api/chat` (before quotas,
   conversation reads or any service-role tool; roles come from the
   membership snapshot), `/api/audit-tool` (membership, then admin), passkey
   session mint (`src/features/passkeys/passkey-session.ts`), and every
   protected server function via `requireActiveMember` / `requireAdmin`.
   Public access-request and passkey-login start remain public by design.
   DB side (migration `0006_active_membership_gate_and_chat_stream_leases`):
   `has_role`, `current_user_is_coordinator_or_admin`, `is_app_member` now
   also require an active, not-departed profile.
   Tests: inactive admin, roleless, missing profile, departed, query error,
   active success — `src/routes/api/-chat.membership-and-concurrency.test.ts`,
   `src/routes/api/-audit-tool.membership.test.ts`,
   `src/features/passkeys/__tests__/passkey-session.test.ts`,
   `src/lib/__security__/app-membership.test.ts`, plus SQL harness cases.
2. **Chat concurrency leases.** Service-only table `chat_stream_leases` with
   atomic `acquire_chat_stream_lease` (per-user advisory lock, cap 2, TTL 600 s,
   expired leases reaped) and idempotent release. `/api/chat` acquires before
   streaming and releases on finish, error, abort and synchronous failure; a
   store error refuses the request (503). TTL is the crash recovery.
   Tests: `src/lib/__security__/chat-stream-lease.test.ts`, the handler test
   above, and the SQL harness race.
3. **Pagination.** New `src/lib/paged-select.ts` (`pagedSelect`/`pagedRows`)
   over the hardened `paged-fetch-core`: required stable order ending in a
   unique column, page-2+ errors and cap overflow **throw**. Converted every
   read the review listed: the eight analytics pages, absence (Bradford + RTW),
   leave fairness, inbox, dashboard trainee/solo metrics (removing a
   `.range(0, 49999)` that was silently capped at 1,000), trainee-overview
   supervisor join, hours-screen approved leave (ID chunks of 200) and
   supervisor join. Also converted fixed-range reads found in the whole-app
   sweep: trainee start-date / leave-audit / theatre-validation checks,
   tutorial audit/verify/backfill profile and trace reads, the audit
   assistant's staffing and duty histograms, and the late-changes report.
   Each of these pages now shows an error with Retry instead of zeros.
   Calendar feed leave was already paged and fail-closed; added multi-page
   (2,300 rows) and page-2-failure tests. Tests: `src/lib/__tests__/paged-select.test.ts`
   (multi-page with delay, filters/desc order, page-2 failure, exact cap vs
   over cap, empty, missing order).
   Bounded `.limit(N)` lists that are explicitly "latest N" displays (sync
   metrics, reclassification runs, push dispatch batches) were left as-is.
4. **Calendar** (re-verified): AM/PM leave stays timed, notes/reasons are
   never selected or rendered, any source error → 503 (23 tests).
5. **Lint 216 → 0 errors** with real fixes: typed Supabase clients,
   message-part type guard, explicit row types in the assistant, `unknown`
   in catches, shared British date helpers (`formatMonthYearGB`,
   `formatShortDayMonthGB`, `londonDateISO`, `londonHourOfDay` in
   `src/lib/utils.ts`, same output and time zones), regex escape cleanup
   (equivalence checked), declaration-order fixes (a ref breaks the
   settings-page mutation cycle), and test doubles typed via
   `src/test-utils/dyn.ts` instead of `any`.

### Still open / not verified

- Not exercised in a real signed-in browser: membership denial for a
  disabled account, the lease limit with two live streams, and the error
  notices on the converted pages.
- RTW completion on the absence/inbox pages relies on `conducted_at`, which
  is NOT NULL in the schema, so the wellbeing "uncompleted interview" case
  cannot occur there.
- `pagedRows` types its rows as the full table row even when fewer columns
  are selected (pre-existing pattern; compile-time only).
- Study-course cost split across leave years still needs the owner's rule.

## Earlier pass — release status (superseded above)

**Not release-clean.** CI's `supply-chain` job will fail: 2 moderate advisories
remain in development tools, plus 1 low (see §2). Lint fails with 191
pre-existing errors (§6). Typecheck, the full test suite, both DB harnesses
and the production build pass. I recommend publishing only after the owner
accepts the itemised risks below. I have not published.

## Commands and exact results (earlier pass)


| Check | Command | Exit | Result |
|---|---|---|---|
| Unit/integration suite | `bunx vitest run` | 0 | 184 files; **1,853 passed, 4 skipped**, 0 failed (the skipped tests are live-RLS probes that need credentials) |
| Typecheck (CI command) | `bun run typecheck` (`tsc --noEmit -p .`) | 0 | 0 errors |
| Typecheck (fast) | `tsgo --noEmit -p .` | 0 | 0 errors |
| Production build | `bun run build` | 0 | built (`--max-old-space-size=8192`) |
| DB trigger/RLS/audit harness | `PG=… bash tests/db-harness/run.sh` | 0 | **129 cases, 0 failures** (previously 99) |
| PostgREST integration | `PG=… PGRST=… bash tests/db-harness/postgrest.sh` | 0 | **12 cases, 0 failures** against real PostgREST 14.1 |
| Dependency audit | `node scripts/check-supply-chain.mjs` | **1** | lock 1,153 packages; 2 moderate, 1 low; xlsx listed as UNSCANNED (reviewed) |
| Lint | `bunx eslint . --quiet` | **1** | **191 errors**: 154 `no-explicit-any`, 16 `no-use-before-define`, 12 `no-restricted-syntax`, 9 `no-useless-escape`. All in files this pass did not touch; none in the new or changed files. |

## 1. AuthProvider identity transition

**Defect (reproduced):** `onAuthStateChange` published session B straight away,
but A's roles, name and cache stayed in place with `loading=false` until a
`setTimeout`. The cache purge also awaited `cancelQueries()`.

**Fix** (`src/lib/auth-context.tsx`, `src/lib/auth-identity.ts`):
- `applySession()` handles every identity change synchronously, in one
  React batch:
  - bumps the generation;
  - clears the cache (`cancelQueries` runs fire-and-forget and is never awaited);
  - resets roles, grade and name;
  - closes the loading gate (`loading=true` until B's profile loads);
  - then publishes B.
- The network load is still deferred (supabase-js callback rule). A
  generation token makes any superseded load a no-op, including one that
  settles before the timer fires.
- A same-user `TOKEN_REFRESHED` only swaps the session: no purge, no reload,
  roles kept.
- Sign-out purges locally before the network call.
- The initial `getSession()` result is ignored if any auth event arrived
  while it was pending.

**Tests:** `src/lib/__security__/auth-provider-transition.test.tsx` mounts the
real `AuthProvider` with a mocked client. It covers seven cases:
- A→B before the timer, with a never-resolving `cancelQueries`;
- a delayed A load resolving after the switch;
- A→B→A with a stale first A load;
- sign-out with a pending network call;
- same-user refresh;
- the `getSession` vs `SIGNED_OUT` race;
- an initial load for B.

Every render is recorded, and the test asserts that no render shows another
account's roles or name. **Against the old code (commit `2a86354`) 6 of the 7
fail; with the fix all 7 pass.**

## 2. Supply chain

The rewritten `scripts/check-supply-chain.mjs` fails closed (exit 2) on:
- a missing or unparseable lock, a lock without `lockfileVersion` or the root
  workspace, or an empty package tree;
- any dependency spec in the root manifest that differs from the lock or is
  not resolved;
- a stale `package-lock.json`;
- spawn failure, a signal, or an exit code other than 0/1;
- exit 1 with no advisories, or exit 0 with advisories;
- non-object JSON (`[]`, `null`, scalars), an `error` payload, an empty
  advisory list, or an advisory without a valid severity, id, title, url or
  vulnerable_versions.

**Non-registry packages** (tarballs, git) are checked against
`scripts/supply-chain-unscanned.json`, which needs an exact key, resolution
URL and integrity. An unreviewed one is exit 2. A reviewed one is printed as
`UNSCANNED`, and the success message is "no advisories … among scanned
registry packages", never a global "clean".
- xlsx 0.20.3 (SheetJS CDN) is reviewed: it is newer than the fixes for the
  npm-registry xlsx advisories. **Residual risk:** no advisory database covers
  it.

**Tests:** `scripts/check-supply-chain.test.ts` runs the real script with a fake
`bun` against fixture projects: **28 cases**. They cover clean `{}` (0), high
(1), moderate (1), low below threshold (0), ENOAUDIT (2), `[]`, `null`, missing
severity, unknown severity, an empty list, malformed or empty JSON, exit-code
disagreements, an unexplained exit, a missing `bun`, a missing / `{}` / empty
/ unparseable lock, a manifest mismatch, a missing dependency, a stale
package-lock, and unreviewed / reviewed / tampered tarballs.

**Lockfiles:** `bun.lock` is the only lockfile. `package-lock.json`, with its
33 spec mismatches from the baseline, was removed earlier and is now rejected
by both the scanner and CI.

**Overrides added** (`package.json`):
- `undici ^7.30.1`: fixes 18 advisories; miniflare had pinned 7.28.0.
- `sharp ^0.35.5`: fixes 3 high advisories; miniflare had pinned 0.34.5.

After both, the dev server served `/login` with 200, and the build and the
full suite pass.

**Remaining (not suppressed):**
| Package | Severity | Via | Why not fixed |
|---|---|---|---|
| esbuild 0.18.20 | moderate (dev-server CORS) | drizzle-kit → @esbuild-kit | Development migration tool only; never runs a dev server; forcing ≥0.25 breaks @esbuild-kit's pinned API |
| minimatch 3.1.5 / 10.2.5 | moderate (ReDoS) | eslint, typescript-eslint | Lint tooling only; minimatch 11 changes the module API eslint 9 imports |
| katex | low | chat maths/diagram rendering (production) | The upstream range only allows ^0.16 |

## 3. Audit SQL isolation

- **Migration `0005_audit_reader_explicit_column_allowlist`** (applied live):
  - revokes all `audit_reader` table, sequence and default privileges;
  - stores a reviewed allowlist (`audit_ro.column_allowlist`, 38 tables) and
    grants exactly those columns.
  - **Excluded:** every notes, reason, comment or message column; raw payloads
    (`source_row`, `details`, `args`, `matched_value`, `person_label`); URLs
    and errors (`*_report_url`, `last_error`); tokens, hashes, ciphertext and
    emails; and whole tables (AI chats, passkeys, push, access requests, pulse
    responses, recognition, return-to-work, RPC audit, quotas).
  - New columns get no access by default.
  - **Live check:** 374 columns granted, no table-level grants. The only two
    granted names that match a sensitivity pattern are counters
    (`notes_updated`, `errors_count`).
- **Wrapper:** the text screen now also rejects `U&` Unicode-escaped
  identifiers and references to `exec_select`, `audit_ro` or the wrapper
  itself. This is defence in depth only.
- **Boundary proven without the text screen** (harness `raw` cases, which call
  `audit_ro.exec_select` directly):
  - Turning read-only back off fails ("must be set before any query"), and so
    does a write attempted after it.
  - `set_config('statement_timeout','0')` followed by `pg_sleep(4)` is
    cancelled by the caller's role timeout.
  - A recursive `exec_select` that tries a side effect fails ("read-only
    transaction"); one that tries a hidden column fails ("permission denied").
  - A data-modifying CTE is rejected.
  - The net queue stays at 0 rows.
- **Live timeout source:** `authenticated` and `authenticator` have
  `statement_timeout=8s` (checked read-only). The wrapper's own `set_config`
  timeout cannot re-arm the current statement, so the role limit is the real
  bound.
- **PostgREST:** GET (and POST) with a VOLATILE function works in current
  PostgREST. This was *not* a bug, and the app keeps `rpc(..., {get:true})`.
  The disposable PostgREST test (`tests/db-harness/postgrest.sh`) runs a real
  server with locally signed synthetic JWTs:
  - Allowed: admin GET (200, rows), admin POST (200), the describe-schema
    query (200).
  - Denied: non-admin (403), anonymous (401), raw payload and URL columns
    (403), `net.http_post` by GET and POST (400), a Unicode-escaped
    `set_config` (400), a data-modifying CTE (400).
  - No side effects reached the database.
- **Untested:** the same GET call through the live Supabase gateway with a real
  admin session (no session could be minted). The local server is 14.1; the
  hosted version was not confirmed.

## 4. Encrypted leave / profile / view paths

The fixture now mirrors the live trigger set, checked read-only against
`pg_trigger`:
- the `a10_` guards and `leave_requests_sync_encryption`;
- the ciphertext columns;
- profile email/GMC encryption;
- `security_invoker` `profiles_v` and `leave_requests_v`, with the live
  non-definer INSTEAD OF UPDATE/INSERT bodies.

`auth.uid()` now uses Supabase's real definition (`claim.sub` or
`request.jwt.claims`).

The **calendar-token expectation was wrong in the original 65-case fixture**:
it allowed staff to edit their own token. It is now `denied`, including
setting it via `profiles_v` and clearing a server-minted token.

New cases:
- staff writes `email_enc` / `email_hash` / `gmc_number_enc` directly
  (denied);
- email change via the view (denied);
- rename via the view (allowed);
- pre-approved or forged-decision insert via `leave_requests_v` (denied);
- own pending insert via the view, with the reason re-encrypted (allowed);
- a legitimate reason edit combined with forged `decision_notes_enc`
  (denied).

All 129 cases pass.

## 5. Calendar feed

The route is now thin. Its logic lives in `src/lib/calendar-feed.ts`, tested
with fixtures in `src/lib/__security__/calendar-feed-sources.test.ts` (21
tests).
- **503 when:** any query fails (profile, membership, assignments, leave,
  theatre sessions, supervisors, or a later page), or a referenced theatre
  session or supervisor is missing. There is no partial 200.
- **404 when:** the member is inactive, has `left_at` set, has no roles, or
  the token is unknown, short or malformed (checked before any query).
- **Privacy:**
  - assignment notes and theatre-session notes are no longer selected or
    rendered;
  - the earlier test that *required* notes was updated to forbid them;
  - leave reasons are never selected.
- **Half days:** AM/PM leave uses the app's shared rule (now in
  `src/features/leave/leave-halves.ts`):
  - AM is 08:00–13:00 and PM is 13:00–18:00, Europe/London;
  - a PM start or AM end gives timed boundaries;
  - full days stay all-day.
- **ICS fixtures:**
  - every CR/LF form is escaped;
  - a CRLF injection into the calendar name cannot start a new property;
  - folding keeps each line at or under 75 UTF-8 octets (é, 🩺, €), with a
    leading space on continuation lines;
  - unfolding restores the exact text;
  - a 75-octet line is not folded.
- **Headers:** every response is `private, no-store`.

## 6. Report integrity and CI

- All results above are from the final tree. Failing exits (scanner 1,
  lint 1) are reported as failures.
- **No tests were weakened.** Two old calendar assertions changed because the
  requirement changed (notes must be absent; `NO_STORE` constant). The scanner
  test file was replaced by a stricter, executed version.
- **Lint ignores** were added only for generated files that must not be
  edited (`src/integrations/supabase/types.ts`, `previewAuthStorage.ts`,
  `src/routeTree.gen.ts`) and for the codemod expected-output fixtures. No
  rule was disabled. No vulnerability is suppressed.
- **CI** (`.github/workflows/ci.yml`):
  - Bun is pinned at 1.4.4;
  - `bun install --frozen-lockfile` runs everywhere;
  - a new step checks `bun.lock` is unchanged and `package-lock.json` is
    absent;
  - `bun run typecheck` and `bun run build` run (8 GB heap set in the build
    script);
  - the supply-chain job scans the committed lock without installing, and its
    failure exit is visible.

## Changed files (this pass)

- **Sign-in:** `src/lib/auth-context.tsx`, `src/lib/auth-identity.ts`,
  `src/lib/__security__/auth-provider-transition.test.tsx` (new).
- **Supply chain:** `scripts/check-supply-chain.mjs`,
  `scripts/check-supply-chain.test.ts`, `scripts/supply-chain-unscanned.json`
  (new), `package.json` (overrides), `bun.lock`.
- **Database:** `drizzle/migrations/0005_audit_reader_explicit_column_allowlist.sql`
  (new, applied live), `tests/db-harness/fixture.sql`,
  `tests/db-harness/cases.sql`, `tests/db-harness/run.sh`,
  `tests/db-harness/postgrest.sh` (new).
- **Calendar:** `src/lib/calendar-feed.ts` (new),
  `src/routes/api/public/calendar/$token.ts`,
  `src/features/leave/leave-halves.ts` (new),
  `src/features/leave/leave-utils.ts`,
  `src/lib/__security__/calendar-feed-sources.test.ts` (new),
  `calendar-feed-route.test.ts`, `calendar-feed-privacy.test.ts`.
- **CI, lint and docs:** `.github/workflows/ci.yml`, `eslint.config.js`,
  `src/integrations/supabase/types.ts` (regenerated by the migration tool),
  `docs/audit-2026-11-01-accuracy-remediation.md` (correction note), this
  file.

## Untested boundaries / incomplete items

| Item | Reason | Risk |
|---|---|---|
| Live signed-in checks (audit tool via the hosted gateway, account switch in a real browser, chat at 375 px) | No signed-in session could be minted for this project | Hosted PostgREST/gateway behaviour may differ from local 14.1; covered by the local server and the real-provider unit tests |
| Chat concurrency cap | Not implemented (hourly quotas only) | One user can hold several streams at once within the hourly limits |
| esbuild / minimatch advisories, katex low | Pinned upstream in dev tools; katex range is fixed upstream | Development tools only; katex low severity in maths rendering |
| xlsx tarball | Not covered by any advisory database | Manually reviewed; pinned by URL + integrity |
| Other analytics pages still use fixed wide ranges | Carried over from the previous report | Possible undercounts above 1,000 rows on those pages |
| 191 lint errors | Pre-existing, outside this pass | Code quality, not behaviour |
| Cross-year study £ attribution | Waiting on the department's rule | Budget may be attributed to the wrong year |
| Access-request client IP trust / no idempotency key | Carried over | Bounded by per-email and global quotas |
