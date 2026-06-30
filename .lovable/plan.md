## Goal

Complete column-level encryption rollout: switch every server read of `profiles.email/gmc_number`, `access_requests.email`, `leave_requests.{reason,decision_notes,conflict_notes}`, and `ai_messages.parts` to go through access-controlled decrypt helpers, switch all email lookups to `email_hash`, then drop the plaintext columns.

## Approach

Use database **views** as the read surface. Views decrypt on read, applying the access rules already encoded in the helpers (`decrypt_owner_or_coord`, `decrypt_coord_only`, `decrypt_ai_message_parts`). One view per table means the application code keeps reading "email", "gmc_number", "reason" etc. — only the `.from("profiles")` target changes to `.from("profiles_v")`. This keeps the rewrite mechanical and low-risk.

Writes continue to target the base tables; the existing sync triggers already encrypt `_enc`/`_hash` from any plaintext write. In Phase 3, after plaintext is dropped, we switch writes to target `_enc` directly (or via SECURITY DEFINER `set_*` RPCs for fields with mixed-access UI).

## Phases

### Phase 2a — Database views and lookup RPCs (one migration)

- Create `profiles_v`, `access_requests_v`, `leave_requests_v`, `ai_messages_v` as `security_invoker=true` views that:
  - Project every base column EXCEPT plaintext sensitive fields.
  - Replace each sensitive field with `decrypt_*(...)` returning the same column name.
  - GRANT SELECT to `authenticated` (and `anon` only on views that already serve anon — none here).
- Add `find_profile_by_email(text) -> uuid` and `find_access_request_by_email(text) -> access_requests row` SECURITY DEFINER RPCs that look up by `email_hash = hmac_text($1)`. These replace the few places that filter by raw email.
- Update `handle_new_user` trigger to use `email_hash` for lookup instead of `email`.

### Phase 2b — Application rewrite

For each file in the list below, change `.from("<table>")` → `.from("<table>_v")` on **reads only**, and change any `.eq("email", x)` lookup to call the new RPC. Writes stay on the base table.

Files to update:
- `src/lib/access-requests.functions.ts`
- `src/lib/admin-access-requests.functions.ts`
- `src/lib/admin-staff.functions.ts`
- `src/lib/admin-gmc.functions.ts`
- `src/lib/staff-directory.functions.ts`
- `src/lib/leave-notifications.functions.ts`
- `src/lib/calendar-feed.functions.ts`
- `src/lib/trainee-theatre-validation.functions.ts`
- `src/lib/trainee-start-dates.functions.ts`
- `src/lib/trainee-leave-audit.functions.ts`
- `src/lib/last-minute-changes.functions.ts`
- `src/lib/custom-rules.functions.ts`
- `src/lib/clwrota.functions.ts` (largest — ~6 sites)
- `src/routes/api/chat.ts`
- `src/routes/api/audit-tool.ts`
- `src/routes/api/public/calendar/$token.ts`
- `src/routes/api/public/health.ts`

For each: update the generated types reference if needed and run a typecheck. Server functions running under `requireSupabaseAuth` use the user's RLS context → the access-controlled decrypts apply correctly. Functions using `supabaseAdmin` bypass RLS but the decrypt helpers' role check uses `auth.uid()`, which is `NULL` under service-role — meaning `decrypt_owner_or_coord` will return NULL. For those code paths I'll either (a) call `decrypt_text` directly (admin trust boundary already crossed) by selecting `_enc` and decrypting in the function, or (b) keep them user-scoped. I'll audit each `supabaseAdmin` reader and pick per call site; the default will be (a) via a small `admin_decrypt_*` SECURITY DEFINER RPC restricted to `service_role`.

### Phase 3 — Drop plaintext (one migration, after Phase 2b verified)

- Drop sync triggers (no longer needed; writes will target `_enc` going forward, or use new `set_*` RPCs from the few UI write sites).
- Add lightweight write helpers on base tables: a BEFORE-INSERT/UPDATE trigger that, if any code still writes plaintext, encrypts it and clears the plaintext local before the row hits storage — belt-and-braces for the transition window.
- After a verification pass, `ALTER TABLE ... DROP COLUMN email, DROP COLUMN gmc_number, …`. Also drop `ai_messages.parts`, `leave_requests.reason/decision_notes/conflict_notes`, `access_requests.email`.
- Update generated Supabase types.

## Verification

- After Phase 2a: `tsgo` typecheck, plus a manual SELECT through each `_v` view as admin and as a regular signed-in user (via `supabase--read_query` impersonation or app-side smoke test).
- After Phase 2b: run the existing e2e/test suite, then drive the live app via Playwright for the high-traffic flows (login, staff directory, leave requests, AI chat, calendar feed, admin staff & GMC pages, access request approval).
- After Phase 3: same Playwright sweep, plus confirm no code references the dropped plaintext columns (`rg`).

## Technical notes

- Views with `security_invoker=true` keep base-table RLS active for the caller.
- Decrypt helpers check `auth.uid()`; reads under `supabaseAdmin` (service role) will get NULL from access-gated helpers — those sites need the admin decrypt path.
- `ai_messages_v` exposes `parts` (jsonb) via `decrypt_ai_message_parts(parts_enc, conversation_id)`.
- `email_hash` is HMAC-SHA256 of `lower(btrim(email))` keyed by the vault HMAC key — deterministic for lookup, not reversible.
- AI chat insert into `ai_messages` will continue to write `parts` (jsonb); the trigger mirrors it into `parts_enc`. In Phase 3, the insert switches to `parts_enc = encrypt_jsonb($1)`.

## Risks

- ~50+ query sites means a real chance of missing one; `rg` sweeps before Phase 3 will catch them.
- `clwrota.functions.ts` is large and uses both user and admin clients — careful per-site decisions needed.
- Any external integration that joined on plaintext email needs to switch to `email_hash` lookup; I'll audit `clwrota` and `email_inbound_log` paths.
