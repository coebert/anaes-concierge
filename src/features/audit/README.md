# Audit Module Documentation

## Legacy Inactive Theatre Filter

### Background

The Salisbury site previously included an NHH (New Hall Hospital) theatre that was later decommissioned and marked `active = false` in the `theatres` table. However, stale `theatre_sessions` rows from earlier syncs remain in the database, still linked to that inactive theatre ID.

If these stale rows were treated as valid demand, the audit would report a phantom consultant shortfall even though every **active** theatre is fully staffed.

### Expected Behaviour

The robustness audit must **exclude** any `theatre_sessions` row whose `theatre_id` belongs to a theatre with `active = false` before counting demand or coverage. This applies to:

- `computeRobustness()` — main pressure calculation
- `computeListCoverage()` — list-level coverage view
- `loadDayDetail()` — per-day drilldown view

### Implementation

All three functions fetch the set of inactive theatre IDs upfront (via `.eq("active", false)`) and filter the `theatre_sessions` array before it enters demand/coverage logic:

```typescript
const inactiveTheatreIds = new Set(
  (inactiveTheatreRows ?? []).map((t) => t.id)
);

const theatreSessions = theatreSessionsRaw.filter(
  (t) =>
    !isEmergencyTheatreSession(t, emergencySpecialtyIds) &&
    !(t.theatre_id && inactiveTheatreIds.has(t.theatre_id))
);
```

### Regression Test

`robustness.inactive-theatre.test.ts` covers this scenario:

- **Test 1** — two consultants each cover one active theatre AM list, plus a phantom `theatre_sessions` row on an inactive "NHH (legacy)" theatre. The audit must report:
  - `required === 2` (only active theatres count)
  - `unfilled === 0`
  - `risk !== "shortfall"` (headroom ≥ 0)

- **Test 2 (control)** — one consultant covers only one of two active theatre lists. The audit must correctly flag a `shortfall` risk.

If you change the demand model or the theatre lookup, ensure both tests still pass so the inactive-theatre guard is not accidentally removed.
