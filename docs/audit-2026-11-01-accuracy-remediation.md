# Accuracy, reliability and security follow-up remediation — 2026-11-01

Scope: the independent follow-up security review plus accuracy/reliability items A–I,
the baseline red tests, supply chain and zod 4. Continues from security pass
`2a86354c`. **Synthetic data only.** Nothing was published; no emails/pushes were
sent; no CLWRota sync ran; no staff/rota/leave rows were changed. Live database
changes were schema DDL only (two migrations below).

Provenance key: **[unit]** vitest with mocks · **[harness]** disposable local
Postgres 16 (`tests/db-harness/run.sh`) running the real repo migrations on a synthetic
schema · **[live-meta]** read-only metadata query on the live database ·
**[blocked]** could not be verified (reason given).

## Final verification

| Check | Command | Result |
|---|---|---|
| Full test suite | `bunx vitest run` | **182 files, 1,801 passed, 4 skipped, 0 failed** (baseline: 20 failed / 1,633 passed / 4 skipped) |
| DB harness | `PG=… bash tests/db-harness/run.sh` | **99 cases, 0 failures** |
| Typecheck | `tsgo --noEmit -p .` | pass (0 errors) |
| Production build | `bun run build` | pass |
| Lint | `bunx eslint . --quiet` | **200 errors** (baseline 12,264; 12,395 were formatting, auto-fixed after behaviour fixes). Remaining: 160 `no-explicit-any`, 18 `no-use-before-define`, 12 `no-restricted-syntax` (locale date formatting), 9 `no-useless-escape`, 1 prettier. Not fixed this pass. |
| Dependency audit | `node scripts/check-supply-chain.mjs` (= `bun audit --json` on committed `bun.lock`) | **exit 1 — 25 advisories ≥ moderate, 4 low**. See supply chain. |

The 4 skipped tests are pre-existing live-database RLS probes that skip without credentials.

## Migrations (applied live, DDL only)

1. `0003_security_followup_guards_quotas` (`security_followup_guards_quotas`)
2. `0004_harden_request_quota_inputs` (`harden_request_quota_inputs`) — strict bucket-spec
   regex, window 1 s–7 days, max ≥ 1, bytes 0–10 MB, invalid input raises (no divide-by-zero).

Earlier, unchanged: `0000_security_remediation_workflow_guards`,
`0001_audit_reader_restricted_role`, `0002_audit_sql_force_read_only`.
`0002` (forced read-only audit SQL) was re-checked: `0003` builds on it and adds a
statement timeout and prohibited-function screen; it does not replace it.

## Security follow-up

| Item | Status | Evidence |
|---|---|---|
| Leave guard runs before encryption trigger; rejects direct writes to `reason_enc` / `decision_notes_enc` / `conflict_notes_enc`; protects `created_at` and import bookkeeping; own pending reason edits still encrypted | Fixed | [harness] real trigger order (`a10_…` sorts before `leave_requests_sync_encryption`), plaintext and ciphertext tamper cases, view path; [live-meta] trigger names/order confirmed |
| Coordinator could alter own approved leave / forge `decided_by` | Fixed in `0003` | [harness] |
| `calendar_feed_token` server-owned | Fixed | [harness] self-update denied; admin/server path allowed |
| audit_reader: PUBLIC `net` usage, side effects | Partly fixed | Platform grants PUBLIC usage on `net` (owned by `supabase_admin`) and this project cannot revoke it. Mitigated by restricted role, forced read-only transaction, timeout, and a function-name screen (defence in depth, not the boundary). [harness] allow/deny cases. **[blocked]** real PostgREST `rpc(..., {get:true})` positive query: no signed-in session could be created (`lovable auth-session --self` found no matching user). Usability through PostgREST GET is **not verified**. |
| Staff-directory decryption requires active app member | Fixed | `src/lib/app-membership.ts` (active profile + ≥1 role, fails closed) [unit] |
| Calendar feed fails closed | Fixed | 503 on any source error, 404 for inactive/roleless owner, `private, no-store`, no leave reasons, CRLF-safe escaping and UTF-8 byte-based 75-octet folding [unit] |
| Passkeys bound to exact one-time ceremony ID | Fixed | email + usernameless, concurrent ceremonies, cross-user substitution, replay, expiry, wrong purpose, origin/RP, counter-write failure [unit]; exact-ID single consume + direct credential write revocation [harness] |
| Access requests: durable atomic quotas, generic response, bounded input | Fixed | 5/client/h, 1/email/h, 3/email/day, 30 global/h; emails only after a granted insert (mocked) [unit][harness] |
| Chat: bounded request + durable quota; email only on explicit opt-in | Fixed | 200 KB body, 100 messages, 20 parts, 8k chars; 60 req & 4 MB/user/h, 1,000/h global; 429 on exhaustion, 503 if quota store errors [unit]. No prior email-preference setting existed, so the reply email was made **off by default** and a per-message "Email me this answer" tick-box was added (resets after each send). |

**Not implemented / limitations**
- Chat **concurrency cap** (simultaneous in-flight streams per user) not implemented; hourly request and byte quotas only.
- Access-request client key uses `cf-connecting-ip`, then `x-real-ip`/`x-forwarded-for`. Off-Cloudflare these can be spoofed; per-email and global caps still bound abuse.
- No idempotency key on access requests; duplicates are bounded by the 1/email/hour quota.
- `ChatPart` still allows extra nested fields, inside the 200 KB total cap.
- Signed-in live checks of these flows: **[blocked]** (no session).

## Accuracy

**A–B Leave counting** (`src/features/leave/leave-count.ts`, now used by allowances, entitlement ledger, Allowances tab, study budget): strict ISO dates (rejects `2026-02-30`); anniversary leave years (31 Mar 2028 → year starting 1 Apr 2027; half-open end); clip to the selected year **before** counting; half-day markers apply only at retained working-day boundaries. Tested cases [unit]: 30 Mar–2 Apr 2026 in year 1 Apr 2026 = 2; Sat 11 Apr PM → Mon 13 Apr = 1; Fri 10 → Mon 13 Apr = 2; Mon 6 Apr ending AM = 0.5; proration from 1 Oct 2026 = 182/365 → 0.499. Allowances keyed by `staff_id + leave_year_start`.
- **Judgement call, flagged:** a study course whose dates cross two leave years has its days split by date. Its £ cost is **not split** and is counted only in the year the course starts. These requests are listed in `crossYearCostRequestIds` and the study budget card now says so. If the department has a different rule, this needs confirming.

**C Leave page:** department leave, allowances, own leave, year totals, entitlement history and TOIL ledger all page through every row with a stable `(date, id)` order. The old fixed 0–4999 / 0–9999 / 0–499 windows are gone. Load failures show an error and Retry. Year totals clear on year change, ignore stale responses, and reload after submit/cancel. `computeLeaveConflicts` checks every query and throws on failure (the coordinator view shows "Cover could not be checked", not "no conflicts"). It now compares morning/afternoon overlap with colleagues' half-days. PA settings read errors now stop the ICU/specialty/appraisal/calendar pages instead of silently using default rates.

**D Paging helpers** (`src/lib/paged-fetch-core.ts`, used by all three helpers): validates sizes; any page error rejects; when the cap lands on a full page, a one-row probe distinguishes "exactly complete" from "more rows" (`IncompleteResultError`); `fetchAllPages` returns `complete:false`. Tested [unit] with 2,345 and 1,234 rows, below/exact/above cap, zero/fractional sizes, a page-2 error and delayed responses. Note: the probe adds one request to query budgets.
- **Not done:** other pages still use fixed wide ranges (e.g. admin analytics, absence, leave-fairness, inbox, `trainees.index` 0–49999, TCS page). These cap at 1,000 rows server-side and can undercount. They were outside A–D's named files and are still to do.

**E Trainee on-call %:** on-call sessions ÷ all rostered sessions, same unit; exact duplicate rows counted once; no sessions → unavailable (null). All-ICU AM+PM+eve day = 100% (was 33.3%); pure theatre 0%; ICU shift count unchanged. The card now reads "% of rostered sessions" [unit].

**TCS working hours** (`src/lib/tcs-2016-audit.ts`, page `admin/tcs-audit`): relabelled as an **estimated screening**. It never returns "compliant"; outcomes are `possible_breach`, `incomplete`, `no_flags_estimated` and `insufficient_data`, each with caveats. Changes:
- Long-shift limit defaults to 4. It is 5 only when an explicit agreement is passed in, and no such input exists today.
- The 8-in-14 rule was removed.
- The LTFT pro-rata cap is now information only; the verdict uses 48 h.
- Weekend frequency is "not assessed" unless the full rota cycle length is known and covered.
- Shifts crossing into Saturday/Sunday count as weekend work.

The four reported cases are reproduced as tests [unit], alongside the existing DST test. Sources: the BMA rota checker and the NHS Employers TCS v14 (that PDF was not fetched this pass). **Not legal certification.** PA granularity and dedupe conventions are unchanged.

## Frontend reliability

- **F** Home dashboards, "Today in hospital" and every summary tile now show "Couldn't load… this does not mean there is nothing to show" with Retry. Previously failures looked empty or showed 0. When a refresh fails, the last good data stays on screen with a warning. The rota editor shows load errors, and editing is **paused** until staff, rules, job plans, leave, fixed sessions and the week's and surrounding assignments have all loaded. The documented defaults are used only when the rules row is genuinely absent.
- **G** Chat creates a conversation automatically **at most once** per visit. After that, failure shows an error and Try again, with no loop. On phones the conversations list is a drawer and the chat area can shrink properly (`min-w-0`). Delete buttons are labelled and appear on keyboard focus. **[blocked]** 375 px browser check (no signed-in session).
- **H** Rota grid cells are real buttons with names like "Theatre 3, Monday 6 April 2026, morning session — 2 assigned. Edit", so Enter and Space work. The week navigation buttons and date box are labelled. Focus goes back to the cell when the dialog closes, relying on the dialog library's default (not separately tested).
- **I** Password and Google sign-in always clear the busy state and show a friendly retry message on network or SDK errors [unit]. The passkey flow is unchanged.

## Baseline red tests (20 tests / 13 files)

- 2 robustness files: test mocks lacked `createMiddleware` (pulled in by `require-admin`). Mock updated; assertions unchanged.
- 8 timezone subprocess tests: `tsx` is now a pinned dev dependency (4.23.15). All 13 pass, none skipped.
- 10 chat pattern tests: mocks lacked `.neq` / `.rpc`. Mocks updated; assertions unchanged.
- 3 codemod fixture tests broke when the repo-wide auto-format rewrote expected-output fixtures. Restored; fixtures are now excluded from lint.

## Supply chain / zod 4

- The scanner now wraps `bun audit --json` against the committed `bun.lock`. It fails closed (exit 2) on spawn errors, empty or non-JSON output, an `{"error":…}` payload such as ENOAUDIT, or unknown shapes [unit]. The stale `package-lock.json` was removed. CI pins Bun 1.4.4 (`packageManager` too), runs the audit with Bun, uses a cache key on `bun.lock` with no broad restore fallback, and adds a typecheck + build job.
- **zod 3.25.76 → 4.6.7** (production advisory). The few changed APIs were migrated: `z.record` takes a key schema, `.errors` became `.issues`, and `required_error` became `error`. `.uuid()` was changed to `.guid()` in 12 files to keep zod 3's id format, because zod 4's stricter check rejected fixed ids used in tests. Full suite passes.
- `bun audit fix` upgraded brace-expansion and others within their allowed versions.
- **Remaining advisories (not suppressed):**
  - Development tools only, blocked by exact pins upstream: undici (via jsdom/vitest and miniflare), sharp (via miniflare), minimatch 3 (via eslint), esbuild ≤ 0.24.2 (via drizzle-kit).
  - In the shipped app: katex (low, via the chat's maths and diagram rendering, which only allows ^0.16).
- CI's supply-chain job will **fail** until these upstream pins move.

## Still open

1. Real PostgREST GET positive test of the audit SQL tool — blocked (no session).
2. Signed-in end-to-end and 375 px browser checks — blocked.
3. Chat concurrency cap — not implemented.
4. Fixed wide ranges on other analytics pages — not converted.
5. 200 lint errors (mostly `any`).
6. Development-tool advisories plus katex (low).
7. Cross-year study £ attribution rule needs department confirmation.
