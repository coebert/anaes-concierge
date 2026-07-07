# Bradford Factor + Return-to-Work workflow

Absence management for HR/Guardian: score each staff member's sickness pattern using the standard Bradford Factor (S²×D) and track a Return-to-Work (RTW) interview for every sickness spell, as NHS policy requires.

Sickness data already exists — `leave_requests` has `type='sick'` (142 approved rows). We derive Bradford scores from that; no duplicate sickness table is created.

## What gets built

### 1. Bradford Factor engine (pure library)

`src/lib/bradford-factor.ts`

- `computeBradfordFactor(spells, referenceDate)` → `{ score, spells, days, band }`.
- Rolling 12 months back from `referenceDate` (default: today).
- **S** = number of distinct sickness spells that overlap the window.
- **D** = total calendar days of sickness inside the window (half-days count as 0.5, weekends included by default; a flag lets HR switch to working days).
- Score bands (industry standard, editable):
  - `0–50` Green (no action)
  - `51–200` Amber (informal review)
  - `201–450` Red (formal review / attendance meeting)
  - `>450` Critical (final review)
- Unit-tested with fixtures — single long spell vs many short spells produces the expected S²×D difference.

### 2. Per-staff sickness summary

`src/features/absence/absence-summary.ts`

Given a staff member's `leave_requests` rows (type='sick', status='approved'), returns:
- Bradford score + band
- Spell count, total days
- Days since last spell
- Post-weekend / post-on-call pattern flags (spell starts on Monday, or day after a rostered night/weekend from `rota_assignments`)
- Frequent short-spell flag (≥3 spells ≤2 days each in 6 months)
- RTW status per spell: `not_started` / `scheduled` / `completed` / `overdue`

### 3. Return-to-Work interviews

New table `public.return_to_work_interviews`:

- `id`, `leave_request_id` (FK to the sickness spell), `staff_id`, `conducted_by`, `conducted_at`
- `fitness_confirmed` boolean
- `reasonable_adjustments` text (encrypted like other notes fields)
- `follow_up_required` boolean, `follow_up_date`
- `notes` text (encrypted)
- Standard `created_at`, `updated_at`

RLS:
- Staff can read their own interview record.
- Admins (Guardian/HR) can read/write all.
- Coordinators read-only.
- Same encryption pattern as `leave_requests.decision_notes` (coord+owner decrypt).

An RTW is **due** when a sickness spell's `end_date` is in the past and no interview exists. **Overdue** after 3 working days.

### 4. HR admin page — `/admin/absence`

New route `src/routes/_authenticated/admin.absence.tsx` (Guardian/HR-facing):

- **League table**: every active staff member, sorted by Bradford score (descending). Columns: name, grade, spells (12m), days (12m), Bradford, band pill, last spell, RTW status. Filters: band, grade, has-open-RTW.
- **Trigger thresholds panel**: shows count of staff in each band.
- **Pattern flags column**: post-on-call, post-weekend, frequent short spells.
- **Row click** → drawer with each spell, RTW status per spell, "Log RTW interview" button.

### 5. RTW interview dialog

`src/components/absence/RTWInterviewDialog.tsx`

Reachable from:
- Admin absence page (per spell)
- Trainee detail card (new section — see below)
- Staff's own leave history (read-only view of their own completed RTW)

Fields: date, fitness confirmed, adjustments, follow-up, notes. Save inserts into `return_to_work_interviews`.

### 6. Absence card on trainee detail page

Adds an "Absence & wellbeing" card to `src/routes/_authenticated/trainees.$staffId.tsx`, alongside the exception-reports card added earlier:

- Bradford score + band
- Spell/days summary (12m)
- Overdue RTW badge (if any)
- Recent 5 sickness spells with RTW status

### 7. Sidebar

Add "Absence (Bradford)" under the `Audits` section of `src/lib/navigation.ts` — admin/HR only.

## Data model summary

```text
leave_requests (existing)
   type='sick', status='approved'  ─── source of truth for spells
      │
      └─ return_to_work_interviews (new)
             leave_request_id  ─── one interview per spell
```

## Technical details

- All Bradford math is pure-TS in `src/lib/bradford-factor.ts` and unit-tested — no DB triggers for scoring; the score is recomputed on read from the leave rows (cheap, ≤ few hundred rows per staff).
- Post-on-call/post-weekend detection joins each spell start against `rota_assignments` for the preceding day; done in the query layer, not stored.
- Encrypted note columns follow the existing `leave_requests` trigger pattern (`_sync_..._encryption`) — plaintext columns present for compatibility, encrypted `*_enc` columns synced by trigger, RPC `get_rtw_interviews_decrypted()` for reads.
- Grants: `authenticated` gets SELECT/INSERT/UPDATE, `service_role` ALL, no `anon`.
- Route file follows the `_authenticated/` pattern; navigation entry gated by the existing admin/HR role check.

## Sequencing

1. Migration: `return_to_work_interviews` table, encryption triggers, RPC, RLS/GRANTs.
2. Pure-TS `bradford-factor.ts` + tests.
3. Absence-summary helper + tests.
4. `RTWInterviewDialog` component.
5. `/admin/absence` page + navigation link.
6. Trainee-card "Absence & wellbeing" section.

Wait for approval before starting the migration.
