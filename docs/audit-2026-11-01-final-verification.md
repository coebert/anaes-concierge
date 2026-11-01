# Final verification — 2026-11-01

Follows `audit-2026-11-01-accuracy-remediation.md`. Covers the six remaining
defects that were reproduced independently. **Synthetic data only.** Nothing was
published; no notifications, emails or CLWRota syncs; no staff, rota or leave
rows were changed. The one live database change was grants/functions (DDL)
only. The dangerous audit-SQL examples were run **only** on disposable local
clusters, never on the live database.

## Release status

**Not release-clean.** CI's `supply-chain` job will fail: 2 moderate advisories
remain in development tools, plus 1 low (see §2). Lint fails with 191
pre-existing errors (§6). Typecheck, the full test suite, both DB harnesses
and the production build pass. I recommend publishing only after the owner
accepts the itemised risks below. I have not published.

## Commands and exact results (after the final changes)

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
with fixtures in `src/lib/__security__/calendar-feed-sources.test.ts` (23
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
