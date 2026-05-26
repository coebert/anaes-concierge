# AI-managed custom rota rules

Let admins teach the AI assistant new working-pattern rules in plain English (e.g. *"Dr Smith always has the morning off after an overnight on-call"*). The AI remembers them, factors them into any rota work it does, and the rota editor warns when a manual change appears to break one.

## 1. New table: `custom_rota_rules`

| Column | Purpose |
|---|---|
| `id` | uuid pk |
| `scope` | enum: `staff` \| `grade` \| `department` |
| `staff_id` | uuid (nullable, used when scope = staff) |
| `grade` | text (nullable, used when scope = grade) |
| `rule_text` | text — the canonical natural-language rule as authored |
| `summary` | text — short label shown in the UI (e.g. "Morning off after on-call") |
| `active` | boolean, default true |
| `created_by`, `created_at`, `updated_at` | audit |

RLS: admins manage; all authenticated users can read (so the rota editor can display them).

## 2. AI assistant tools (admin only)

Add to `src/routes/api/chat.ts`:

- `list_custom_rules({ staff_id?, grade? })`
- `create_custom_rule({ scope, staff_id?, grade?, rule_text, summary })`
- `update_custom_rule({ id, ...patch })`
- `delete_custom_rule({ id })`

The system prompt is extended so that, for admin sessions, the **current active rules are injected** before the conversation starts. This means whenever the AI writes or amends a rota, it factors them in automatically.

## 3. Admin UI

Add a small "Working-pattern rules — custom" card on `/admin/rules` listing the active rules with a delete button. Creation happens through the chat assistant (per the user's brief — "tell the AI assistant").

## 4. Manual-edit warnings

In `coordinator.rota.tsx`, when an admin is considering a candidate assignment:

1. Fetch active rules applicable to that staff member (their own + grade + department).
2. Call a new server function `checkCustomRuleViolations({ staffId, date, session, role, contextAssignments })` which uses Lovable AI Gateway to ask: *"Does the proposed change break any of these rules? For each, answer violated=yes/no with one-sentence reason."*
3. Merge any `violated=yes` results into the existing `Issue[]` as **warnings**, with the rule text in the message — slotting into the existing `SeverityIcon` / candidate-issues UI with no new component plumbing.

Results are cached client-side per `(staffId,date,session,role)` so we don't re-call the model on every render.

## Technical notes

- New file `src/lib/custom-rules.functions.ts` — `createServerFn` for `checkCustomRuleViolations`, protected by `requireSupabaseAuth` + admin role check.
- Reuses existing `createLovableAiGatewayProvider` and `generateText` with `Output.object` for structured `{violations:[{ruleId, violated, reason}]}` output.
- One migration adds the table, GRANTs, RLS, and triggers.
- No changes to the existing `rota-validation.ts` deterministic checks — custom-rule warnings are layered on top.
