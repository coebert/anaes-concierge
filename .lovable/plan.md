# Web Push Notifications for Rota Changes

## Scope

Send a browser push notification to Dr Rob Coe whenever one of his `rota_assignments` is added, removed, or edited **within 48h of the session**. The existing `rota_change_log` trigger already logs exactly those events (its ±48h filter matches this requirement), so we build on top of it.

All notifications are effectively immediate — the "only within 48h" trigger scope makes the batched-vs-immediate distinction moot, since every eligible event is a short-notice change.

## Components

### 1. Database
- New table `public.push_subscriptions` (`user_id`, `endpoint` unique, `p256dh`, `auth`, `user_agent`, `created_at`). RLS: user manages their own rows; service_role reads all.
- New table `public.push_notification_log` (`assignment_id`, `staff_id`, `change_log_id` unique, `sent_at`, `status`, `error`) to make dispatch idempotent.
- Reuse `public.rota_change_log` as the change source (already 48h-scoped, already records action/prev/new).

### 2. Secrets
- Generate `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` server-side.
- Expose the public key to the browser via `VITE_VAPID_PUBLIC_KEY` (safe to ship).

### 3. Service worker
- `public/push-sw.js` — handles `push` and `notificationclick` only. Scoped narrowly so it doesn't interfere with anything else. No offline / app-shell caching.

### 4. Client
- `src/lib/push-notifications.ts` — helpers to check support, request permission, subscribe, persist the subscription server-side, and unsubscribe.
- New card on `src/routes/_authenticated/staff.tsx` profile / a dedicated "Notifications" section on the settings page: toggle "Push notifications for last-minute list changes", plus per-device status.
- Only surface the UI to users whose profile matches (works for everyone but Rob Coe is the primary use case; no hard-coding a single user).

### 5. Dispatcher
- Server route `POST /api/public/hooks/push-dispatch` (webhook-secret protected, matches the existing `clwrota-sync` pattern).
- Reads `rota_change_log` rows without a corresponding `push_notification_log` row, joins to `push_subscriptions` for that `staff_id`, sends via `web-push`, records outcome. Auto-prunes 410/404 subscriptions.
- pg_cron job every 1 minute calls the endpoint.

### 6. Notification content
Title: "Rota change — <date> <AM/PM>"
Body examples:
- Insert: "Added: <Theatre> · <role>"
- Delete: "Removed: <Theatre> · <role>"
- Update: "Changed: <what changed> on <Theatre>"
Clicking opens `/rota?date=YYYY-MM-DD`.

## Technical Notes

- `web-push` is Worker-compatible (pure JS, uses Web Crypto). Install as a dependency; import lazily inside the dispatch handler.
- The dispatch route lives under `/api/public/*` so pg_cron can reach it without auth; it verifies `x-webhook-secret` against `PUSH_WEBHOOK_SECRET` (generated).
- `supabaseAdmin` is imported inside the handler only (route files are client-reachable).
- Subscribing requires HTTPS + user gesture; the toggle handles both.
- iOS support requires the site added to the home screen first — the UI notes this if `Notification` is unavailable.

## Files

New:
- `supabase/migrations/<ts>_push_subscriptions.sql`
- `public/push-sw.js`
- `src/lib/push-notifications.ts`
- `src/lib/push-dispatch.server.ts`
- `src/routes/api/public/hooks/push-dispatch.ts`
- `src/components/push-notifications-card.tsx`

Edited:
- Settings/profile page — mount the card.
- `.env` / secrets — VAPID keys, `PUSH_WEBHOOK_SECRET`.
- pg_cron job (via `supabase--insert`).

## Out of scope

- Email fallback (user chose push-only).
- Batched digests (all eligible changes are already <48h → immediate).
- Notifying on changes >48h in the future or historical edits.
