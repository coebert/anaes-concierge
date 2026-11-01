# Baseline audit — 2026-11-01 (no behaviour changes)

Scope: inspect-only baseline. No application code, data, cron, or production deployment was changed. No emails/pushes sent, no CLWRota sync/import invoked, no records altered. Database inspection was catalog metadata only (`pg_class`, `pg_policies`, `information_schema`, `pg_proc` privileges). Secrets, tokens, emails and user IDs are redacted.

## 1. Architecture snapshot
- TanStack Start v1 on Cloudflare Workers; Lovable Cloud (Postgres + Auth) backend. 60 public tables.
- 32 modules use `createServerFn`; 27 reference `requireSupabaseAuth`.
- No Supabase Edge Functions (`supabase/functions` absent). Server entry points are TanStack routes:
  - `/api/public/health`, `/api/public/calendar/$token` (iCal feed, token-auth)
  - `/api/public/hooks/{clwrota-sync, icu-sync, icu-weekly-audit, tutorial-backfill, tutorial-weekly-audit, rpc-access-alerts, seed-clwrota-vault, daily-digest, push-dispatch}` (shared-secret auth via `x-webhook-secret`, triggered by pg_cron/pg_net).
- Sensitive columns encrypted with pgcrypto (`*_enc`) + HMAC lookup hashes; decryption via SECURITY DEFINER `get_*_decrypted` RPCs with owner/coordinator gating and `rpc_access_audit` logging.

## 2. Commands run and results

| Check | Command | Result |
|---|---|---|
| Typecheck | `bunx tsgo --noEmit` | **PASS** (exit 0, 0 errors) |
| Unit/integration | `bunx vitest run` | **FAIL** (exit 1): files 13 failed / 153 passed (166); tests **20 failed / 1633 passed / 4 skipped** (1657); 27.7 s |
| Lint | `bunx eslint .` | **FAIL** (exit 1): 12,264 problems (12,206 errors, 58 warnings); 12,029 auto-fixable |
| Production build | harness build (`vite build`), log `/tmp/observability/build-errors.log` | **PASS** — `build OK` at 2026-11-01T13:00:15Z. Not re-run manually (harness-managed). |
| Dependency scan | `security--dependency_scan` (bun.lock, 76 prod packages) | **5 critical, 38 high, 33 moderate** advisories |
| Platform security scan | `security--get_scan_results` (prior turn) | 0 findings across all scanners; several scanners `up_to_date=false` → **re-run needed**, do not treat as current |

### 2.1 Test failures (20 tests, 13 files)
| Group | Files / tests | Cause (evidence) |
|---|---|---|
| A. Mock drift | `src/features/audit/robustness.clwrota-payload.test.ts`, `robustness.clwrota-label-variations.test.ts` (whole-file load failure) | `No "createMiddleware" export is defined on the "@tanstack/react-start" mock` — test mocks predate middleware usage. Test-infra defect. |
| B. Timezone grid | `src/lib/theatre-grid-dates.test.ts` — 8 tests (UTC, London, Berlin, New_York, LA, Honolulu, Tokyo, Auckland) "returns 2026-01-31 / Sat" | Subprocess `node --import tsx -e …` command fails in sandbox. Needs triage: environment vs. real date regression — **not confirmed either way**. |
| C. Chat e2e leave pattern | 10 tests across 9 `src/routes/api/-chat.*.e2e.test.ts` files (half-day, overlap, week/weekend boundary, rejected/cancelled, wellbeing) | e.g. `pattern.leave.onLeaveToday` assertions and `expected undefined to be 90`. Indicates fixture/contract drift in `get_staff_current_pattern` tool output (field missing). **Potential accuracy risk** for chat answers about leave; needs triage. |

### 2.2 Lint breakdown
~12,000 are `prettier/prettier` formatting (auto-fixable). Non-format rules: `react-refresh/only-export-components` 9, `@typescript-eslint/no-use-before-define` 3, `@typescript-eslint/no-explicit-any` 3, `no-restricted-syntax` 3, `react-hooks/exhaustive-deps` 1.

### 2.3 Dependency advisories (top)
- CRITICAL `@tanstack/react-start` 1.168.41 — unauthenticated reflected XSS in server-function responses. Fix: ≥1.168.60 (and `@tanstack/start-server-core` ≥1.169.39).
- CRITICAL DOMPurify SAFE_FOR_TEMPLATES bypass via `streamdown`, `@streamdown/mermaid`, `jspdf` (dompurify >3.4.16).
- HIGH `seroval` deserialization DoS / callable invocation via `@tanstack/react-router` 1.170.24 and react-start (seroval >1.6.7).
- HIGH `undici`, `sharp` (via `@cloudflare/vite-plugin`, mostly build-time), `browserslist`, `js-yaml`, `source-map-js` (build-time).
Full table: 76 rows; regenerate with the dependency scan.

## 3. Database security (metadata only)
- RLS enabled on **all** public tables (query of `pg_class.relrowsecurity` returned none disabled).
- Tables with RLS but **no policies**: `passkey_challenges` (intentional: server-only via service role / `consume_passkey_challenge`).
- `anon` role: **no table grants** in `public`.
- Policies with literal `true` USING/WITH CHECK: **none**.
- SECURITY DEFINER functions executable by `anon`: **none**.
- 16 SECURITY DEFINER functions executable by `authenticated`; each inspected body performs its own role/owner check (e.g. `admin_run_readonly_sql`, `trigger_clwrota_sync*`, `list_clwrota_cron_runs`, `detect_rpc_access_anomalies`).
- Observations for review (not exploited):
  - `admin_run_readonly_sql` relies on a keyword denylist; SECURITY DEFINER means admin queries bypass RLS and can read `vault`-adjacent functions such as `decrypt_text`/`_enc_key()` via SELECT. Admin-only, but this is effectively plaintext access to all encrypted columns and the encryption key — **high-impact if an admin account is compromised**.
  - `find_access_request_by_email`, `find_profile_id_by_email`, `hmac_text`, `encrypt_text` have no caller check (executable by `authenticated`) → email enumeration / oracle for signed-in users. Medium.
  - `get_pulse_aggregate` returns per-cycle averages without a minimum-response threshold (re-identification risk with small n). Low.
  - `handle_new_user` merges a pre-existing profile by email hash on signup; correctness depends on email verification being enforced (auth settings **unverified** this turn).

## 4. Dynamic non-destructive tests (localhost dev server, invalid credentials only)
Header sent: `x-webhook-secret: invalid`, `Authorization: Bearer invalid`.

| Endpoint | POST | GET |
|---|---|---|
| hooks/clwrota-sync, icu-sync, icu-weekly-audit, tutorial-backfill, tutorial-weekly-audit, rpc-access-alerts, daily-digest, push-dispatch | **401** | 200 (falls through to SPA HTML; no handler executed) |
| hooks/seed-clwrota-vault | **401** JSON | 200 SPA HTML |
| calendar/`badtoken` | 200 SPA HTML | **404** |
| calendar/`' OR 1=1--` (injection probe) | — | **404** (no leak) |
| health | — | **503** `{"status":"unhealthy"}` in sandbox (dependency check failing locally; not diagnosed) |

Additionally, existing test `-clwrota-sync.auth.e2e.test.ts` covers missing/empty/same-length/different-length/unset-secret cases (passing).

Findings:
- `daily-digest` and `push-dispatch` compare secrets with `!==` (not constant-time) while other hooks use `timingSafeEqual`. Low (timing side-channel over network is hard), but inconsistent.
- `push-dispatch` returns `500 "PUSH_WEBHOOK_SECRET not configured"` when unset — reveals configuration state. Low.
- `daily-digest` accepts `?force=1` from any authenticated caller holding the secret — acceptable but should be documented.

### Blocked
- **Authenticated cross-user / role tests (trainee vs coordinator vs admin, IDOR on server functions, RLS as each role): BLOCKED.** Browser auth status `signed_out`; no isolated test backend — the only backend serves production, and only one admin-type real account exists. Minting a session against real users and exercising write paths would violate the no-production-alteration constraint. Recommended: create a draft/isolated backend with synthetic trainee/coordinator/admin fixtures.
- Input-validation fuzzing of authenticated server functions: BLOCKED (same reason). Static review: validators present on reviewed functions; not exhaustively verified.

## 5. Calculations (static, from prior turns + tests)
- ICU/specialty PA logic (weekend replacement credit, on-call dedupe, `creditedStaffIds`) covered by passing suites in `src/features/analytics/*`.
- Pagination helper `fetch-all-pages.ts` used by ICU/PA pages; 1,000-row cap previously found and fixed.
- Leave/wellbeing pattern logic: see failure group C — **accuracy not baselined as green**.

## 6. Prioritised findings
| # | Sev | Finding |
|---|---|---|
| 1 | Critical | `@tanstack/react-start` reflected XSS advisory — upgrade |
| 2 | Critical | DOMPurify bypass via streamdown/mermaid/jspdf — bump/override dompurify |
| 3 | High | seroval deserialization DoS (router/start) |
| 4 | High | 10 failing chat leave-pattern e2e tests (possible wrong answers) |
| 5 | High (if admin compromised) | `admin_run_readonly_sql` can decrypt all data / read key |
| 6 | Medium | Email-lookup/encrypt helpers callable by any signed-in user |
| 7 | Medium | 8 timezone grid tests failing (cause unconfirmed) |
| 8 | Low | Mock drift in 2 robustness suites |
| 9 | Low | Non-constant-time secret compare in daily-digest / push-dispatch; config disclosure |
| 10 | Low | Health endpoint 503 in sandbox |
| 11 | Low | 12k lint errors (formatting) |
| 12 | Info | Platform scanners not up-to-date; re-run before sign-off |

No fixes applied this turn.
