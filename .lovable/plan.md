# Point 4 — Leave fairness & full entitlement ledger

Turn `leave_requests` + `leave_allowances` into an HR-usable fairness &
entitlement system. No duplicate leave tables — we extend what exists.

## What gets built

### 1. Schema (migration)

- **Extend `leave_type` enum** with `carers`, `jury`, `industrial`, `toil`
  (already have `annual`, `study`, `professional`, `compassionate`, `sick`,
  `parental`, `other`).
- **Extend `leave_allowances`** with the fields HR actually asks for:
  - `carers_days numeric(6,2) not null default 5`
  - `parental_days numeric(6,2) not null default 0`
  - `compassionate_days numeric(6,2) not null default 5`
  - `ltft_fraction numeric(4,3) not null default 1.000` — pro-rating knob
  - `carry_over_days numeric(6,2) not null default 0` — annual leave brought
    forward
  - `sla_target_days smallint not null default 14` — decision SLA
- **New table `public.leave_ledger_entries`** (TOIL / banked-hours ledger):
  - `id`, `staff_id`, `entry_date`, `kind` (`accrual` | `spend` | `adjustment`),
  - `hours numeric(6,2)`, `reason text` (encrypted), `related_leave_request_id`,
  - `created_by`, `created_at`, `updated_at`.
  - RLS: staff read own, admins full, coordinators read-only.
  - Encryption on `reason` follows the existing `_sync_..._encryption` trigger
    pattern; `get_leave_ledger_decrypted()` RPC for reads.

### 2. Pure-TS entitlement engine

`src/features/leave/entitlement-ledger.ts`

For a given staff + leave-year, returns per-type breakdown:
`{ type, entitlement, prorated_entitlement, carry_over, taken, pending,
   remaining, unit }` — days for calendar leave, hours for TOIL.

- Pro-rates against `ltft_fraction` and mid-year start (`profiles.start_date`)
  / leaver date (`profiles.left_at`).
- Half-days count as 0.5.
- TOIL sourced from `leave_ledger_entries` (accruals − spends).

Unit-tested with fixtures (full-timer, LTFT 0.6, mid-year starter, leaver
mid-year, carry-over).

### 3. Pure-TS fairness engine

`src/lib/leave-fairness.ts` (with tests)

Rolling 12-month window per staff member:

- **Denial rate** = denied / (approved + denied), with denial-reason taxonomy
  from `decision_notes`.
- **Prime-date share**: fraction of approved leave days falling on school
  holidays, bank holidays, or the Christmas/NY window (Dec 20 – Jan 2).
- **SLA compliance**: median hours from `created_at` → `decided_at`, and
  count breaching `sla_target_days`.
- **Peer Gini index** across staff — surface the top/bottom deciles.

### 4. Staff route — `/leave/entitlements`

`src/routes/_authenticated/leave.entitlements.tsx`

- One card per leave type with a progress bar (taken / pending / remaining).
- TOIL balance card with ledger history.
- SLA countdown chip on any pending requests.
- Read-only view of own record; link to submit new leave.

### 5. Admin route — `/admin/leave-fairness`

`src/routes/_authenticated/admin.leave-fairness.tsx`

- **Denial-reason league** — categorised counts and trend.
- **Prime-date allocation league** — per-doctor share of leave on prime dates,
  sortable, highlighting outliers.
- **SLA breach table** — pending > target and decided > target.
- **Per-doctor Gini** and 12-month totals.

### 6. TOIL grant/spend dialog

`src/components/leave/ToilLedgerDialog.tsx` — admin action to grant or spend
TOIL hours, writes to `leave_ledger_entries`. Reachable from admin fairness
page and from a trainee detail card.

### 7. Sidebar

Add "Leave fairness" under `Audits` (admin/HR only) and "My entitlements"
under the staff leave section of `src/lib/navigation.ts`.

## Sequencing

1. Migration: extend enum, extend `leave_allowances`, create
   `leave_ledger_entries` + encryption trigger + RPC + RLS/GRANTs.
2. `entitlement-ledger.ts` + tests.
3. `leave-fairness.ts` + tests.
4. `/leave/entitlements` route + nav.
5. `/admin/leave-fairness` route + nav.
6. `ToilLedgerDialog`.
