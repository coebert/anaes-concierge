# Security remediation — 2026-11-01

Follows `docs/audit-2026-11-01-baseline.md`. Nothing was published. No emails or push
messages were sent. No CLWRota sync was run. No live staff, rota or leave rows were changed.
The only live changes are the three additive database migrations listed below.

## Test provenance

| Kind | Meaning |
|---|---|
| **LIVE-META** | Read-only catalog queries (pg_proc/pg_trigger/ACLs) against the live database. No user rows were read. |
| **SIMULATED-DB** | `tests/db-harness/run.sh`: a throwaway Postgres 16 cluster under `/tmp` loaded with a synthetic fixture that copies the live policies, plus the **real** migration files from `drizzle/migrations/`. Each case runs as `authenticated` with a synthetic `auth.uid()` (or as `service_role`) and is rolled back. |
| **UNIT** | Vitest with synthetic inputs and mocked `fetch`/env. |
| **BLOCKED** | Authenticated dynamic tests against the live backend. There is no isolated test backend and no synthetic accounts, so these were **not run**. They are not counted as passed. |

## Migrations applied (live)

1. `drizzle/migrations/0000_security_remediation_workflow_guards.sql` (`security_remediation_workflow_guards`)
2. `drizzle/migrations/0001_audit_reader_restricted_role.sql` (`audit_reader_restricted_role`)
3. `drizzle/migrations/0002_audit_sql_force_read_only.sql` (`audit_sql_force_read_only`)

LIVE-META: the triggers `trg_enforce_leave_request_insert_rules` and `trg_enforce_leave_request_update_rules` are present on `leave_requests`. The ACLs of `admin_run_readonly_sql` are now `postgres, authenticated, service_role` (the function checks for the admin role internally). `_enc_key`, `decrypt_text`, `encrypt_text`, `hmac_text`, `upsert_vault_secret`, `find_profile_id_by_email` and `find_access_request_by_email` are executable only by `postgres` and `service_role`. The only callers of the email lookups are passkey server functions using the service role.

## Findings → fixes

| # | Fix | Evidence |
|---|---|---|
| 1 Leave | A BEFORE INSERT trigger makes new requests start as `pending` with no decision or import fields, unless the caller is a trusted server (no `auth.uid()`). The BEFORE UPDATE trigger stops owners from approving their own requests or changing decision fields, ownership, or the dates/type/reason of a decided request. Owners can still edit or cancel pending requests and cancel decided ones. When a coordinator or admin decides a request, `decided_by` and `decided_at` are set from the actor; forged `decided_by` is rejected. | SIMULATED-DB: 15 leave cases, including coordinator self-approval on insert (denied) and a coordinator rewriting their own approved dates (denied). |
| 2 Profiles | The owner can only change display name and calendar token. Changes to grade, active, dates, CLWRota id, email/hash, GMC number and training level are rejected. Admins and trusted sync can still edit these. | SIMULATED-DB: 11 profile cases. |
| 3 Exceptions | On INSERT the server computes `due_by` (24h for safety reports, 7 days otherwise), and review fields are rejected. On UPDATE trainees can only withdraw their own submitted report. Admin reviewers move it through acknowledged/resolved; `responder_id` and the timestamps come from the server, and an outcome is required to resolve. Reviewers cannot edit a submission or review their own report. | SIMULATED-DB: 13 cases. **Decision kept:** coordinators stay read-only on exceptions, which matches the existing live UPDATE policy and the admin-only `ExceptionCard` actions. Say if coordinators should review. |
| 4 Audit SQL | The keyword-denylist SECURITY DEFINER function was replaced. Queries now run as the NOLOGIN role `audit_reader`, which can read only allow-listed tables and columns. It has no `vault`/`auth`/`extensions` schema access and cannot execute decrypt, encrypt or vault functions. Only one statement is allowed. Migration 0002 makes the wrapper **force** `transaction_read_only=on` itself, whatever HTTP verb is used, so `net.http_post` (executable by PUBLIC) cannot queue requests. The admin role is checked first. | SIMULATED-DB: 17 cases. Vault access (direct and via CTE), `_enc_key()`, `decrypt_text()`, `upsert_vault_secret` via CTE, `net.http_post` (read-only and read-write tx), email, calendar token, leave reason, push table, multiple statements, data-modifying CTE and non-admin callers are all denied. Rota and name reads are allowed. |
| 5 Push | `src/lib/push-endpoint.ts` keeps an allowlist of FCM, Mozilla, Apple and WNS hosts. It requires https, no userinfo, the default port and no IP literals. It checks key lengths and the base64url charset, and caps the payload. The browser checks before saving. The dispatchers check again just before each send, with a 10 s timeout. A DB trigger enforces the same rules on direct REST writes, including from the service role. | UNIT: 21 cases. SIMULATED-DB: 9 cases. No notification was sent. |
| 6 Calendar | `Cache-Control: private, no-store, max-age=0`, `nosniff`, `no-referrer`. The leave reason is no longer selected. Sensitive leave types show as "Leave (approved)", while annual and study keep their labels. The token URL format is unchanged. | UNIT: 3 cases. One of them is a source check, which only adds to the label tests. |
| 7 Dependencies | See the section below. | |
| 8 Hook auth | `src/lib/webhook-auth.ts`: SHA-256 plus `timingSafeEqual`, fails closed when the secret is unset or empty, and returns a generic `401 Unauthorized` without saying whether it is configured. Used by all 9 `/api/public/hooks/*` routes. | UNIT: 4 cases, including real route handlers. |
| 9 Health | Anonymous `/api/public/health` returns cheap liveness only (`status:"alive", scope:"liveness"`) and makes no DB or upstream calls. Detailed readiness needs the secret, uses timeouts and a cache with de-duplication, and does no exact counts. `health.tsx` copes with liveness-only, 503, non-JSON and error responses, and has retry. | UNIT: 5 cases (mocked fetch is asserted not called). |
| 10 Auth cache | `AuthIdentityGuard` cancels in-flight queries and clears the cache when the account changes or the user signs out. It keeps the cache on a token refresh for the same user. Generation tokens drop a stale `loadProfile` from the previous account. | UNIT: 4 cases. |

## Dependencies (#7)

- Upgraded to the aligned TanStack set that supports Vite 7: `@tanstack/react-start@1.168.61`, `@tanstack/react-router@1.170.42` and `@tanstack/router-plugin@1.168.43`. All three share router-core 1.171.35. `react-start@1.169.x` needs Vite 8, so it was not used.
- seroval resolved to 1.7.6 (within the router's `^1.6.7`). `streamdown@2.7.1`, `@streamdown/mermaid@1.0.3`, `vite@^7.3.7`, `vitest@^4.1.12`.
- `xlsx` moved to the official SheetJS 0.20.3 tarball. The npm registry stops at the vulnerable 0.18.5.
- Overrides, all within the major versions consumers already declare: `dompurify ^3.4.17`, `browserslist ^4.29.5`, `source-map-js ^1.2.2`, `js-yaml ^4.3.2` (only 4.x is in the lock), `postcss ^8.5.32`, `shell-quote ^1.12.0`, `launch-editor ^2.14.2`.
- After the upgrade, 5 type errors appeared because `errorComponent` now gets `error: unknown`. They were fixed in `__root.tsx` and 4 route files.
- **Not fixed (documented, not suppressed):**
  - `undici` and `sharp` are pinned exactly by `wrangler`/`miniflare`. Even the latest `@cloudflare/vite-plugin@1.66.0` still pins `undici 7.28.0`. These are build and dev tools and are not in the Worker bundle.
  - `zod` 3.x has no fix in 3.x. Moving to 4 is a breaking API migration.
  - `brace-expansion`, `minimatch` and `nanoid` are present in two major versions each, and the fixes need a major bump. They are dev-only.
  - `esbuild` 0.18/0.24 are nested dev copies.
- `scripts/check-supply-chain.mjs` was rewritten. It parses the **committed `bun.lock`** and sends the exact resolved versions to the npm bulk advisory API. It does not re-resolve, and it fails closed on network or parse errors.
- `.github/workflows/ci.yml` cache keys now hash `bun.lock` (they used to hash a non-existent `bun.lockb`).

## Commands and results

| Command | Result |
|---|---|
| `bash tests/db-harness/run.sh` | **65 cases, 0 failures** (SIMULATED-DB, all 3 migrations applied from repo files) |
| `bunx vitest run src/lib/__security__ src/routes/api/public/hooks` | 6 files, **42 passed** |
| `bunx vitest run` (full) | 171 files: 12 failed / 159 passed. Tests: **12 failed / 1678 passed / 4 skipped**. Baseline was 20 failed. All 12 remaining failures predate this work: 10 chat leave-label e2e tests and 2 robustness suites with mock drift (`createMiddleware` missing from mock). They are scheduled for the next turn. |
| `bunx tsgo --noEmit -p tsconfig.json` | exit 0 |
| `NODE_OPTIONS=--max-old-space-size=6144 bunx vite build` | exit 0. With the default heap the build ran out of memory (exit 134) in the sandbox. |
| `node scripts/check-supply-chain.mjs` (full lock, 944 pkgs) | critical 0 / high 21 / moderate 17 / low 4 → exit 1 at the default `moderate` level. Before the upgrade: critical 1 / high 29 / moderate 29. CI will fail on this check until the items above are resolved. This is intended. |
| `security--dependency_scan` (production deps) | Before: 5 critical / 38 high / 33 moderate. After: **0 critical / 11 high / 13 moderate**. All of these come from `@cloudflare/vite-plugin` (undici/sharp) and `zod`. |

## Blocked / not verified

- Signed-in live calls (staff/coordinator/admin) against the real API and REST. These need an isolated backend and synthetic accounts.
- The audit AI tool calling `admin_run_readonly_sql` end to end over PostgREST on live. The wrapper logic was tested only in SIMULATED-DB.
- A real browser push subscription round trip. Endpoint formats were tested against documented provider URL shapes, not live subscriptions.
- Re-subscribing an existing iCal client to the changed feed (the format is unchanged and was not exercised live).
