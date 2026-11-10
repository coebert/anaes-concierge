# Unverified forecast slots — reconciliation (10 Nov 2026)

Scope: live Salisbury forecast 10 Nov 2026 – 1 Feb 2027, active theatres only.
Database read 18:23 UTC; configured CLWRota assignments feed read 18:24 UTC
(read-only replay, 9,441 rows, same window). No writes, imports, deploys or alerts.
Output is counts/codes only — no names, notes or identifiers.

## Result
19 unverified slots = 19 pre-created theatre-list records (created 3 Jun 2026,
not from CLWRota) with no linked rota row, no imported title/note row, no legacy
title and no coordinator note. App reason for all 19: "No imported rows".

| Date | Half | Theatre | Feed week status | Feed row for slot | Stage / reason | Tags |
|---|---|---|---|---|---|---|
| 24 Nov | AM | Endo | Setup | none (no Endo/Endoscopy row any half) | absent from assignments feed | none evidenced |
| 24 Nov | PM | Endo | Setup | none | absent from assignments feed | none evidenced |
| 2 Dec | AM | Endo | Setup | 1 (consultant) | stale: dropped by old "off site" rule at 17:08 import; not re-imported since fix | none |
| 2 Dec | PM | Endo | Setup | 1 (consultant) | stale (as above) | none |
| 3 Dec | AM | MRI | Setup | 1 (consultant) | stale | none |
| 8 Dec | AM | Laser | Setup | 1 (consultant) | stale | none |
| 15 Dec | AM | Laser | Setup | 1 (consultant) | stale | none |
| 17 Dec | AM | MRI | Setup | 1 (consultant) | stale | none |
| 22 Dec | AM | Endo | Not setup | none | absent from assignments feed | none evidenced |
| 22 Dec | PM | Endo | Not setup | none | absent from assignments feed | none evidenced |
| 31 Dec | AM | MRI | Not setup (planned) | 1 (consultant) | stale | none |
| 6 Jan | AM | Endo | Not setup (planned) | 1 (consultant) | stale | none |
| 6 Jan | PM | Endo | Not setup (planned) | 1 (consultant) | stale | none |
| 12 Jan | AM | Laser | Not setup (planned) | 1 (consultant) | stale | none |
| 14 Jan | AM | MRI | Not setup (planned) | 1 (consultant) | stale | none |
| 19 Jan | AM | Laser | Not setup (planned) | 1 (consultant) | stale | none |
| 26 Jan | AM | Endo | Not setup | none | absent from assignments feed | none evidenced |
| 26 Jan | PM | Endo | Not setup | none | absent from assignments feed | none evidenced |
| 28 Jan | AM | MRI | Not setup (planned) | 1 (consultant) | stale | none |

All 13 "stale" rows: title is only the room name, no list note, no place note,
specialty contains "off site"; current rule keeps them and they map to the
exact slot (Laser/MRI by place name, Endo by slot title); not stored now.
They were last imported by the 17:08 window (11 Oct – 10 Mar, pre-fix rule).
Hourly imports cover only today−3 … today+14; the nightly rotating full import
is projected (from code, live schedule table not readable) to reach these dates
on 14–15 Nov 23:20 UTC. Dates > 48 h ahead create no change-log/alert entries.

## Tag audit
Every feed row in the window carrying VRAM/DIEP/Robotic (12 rows, 6 days:
11, 13, 17, 18, 23, 25 Nov; DIEP 8, Robotic 4) is linked to an active theatre
list and its tags are stored. No tagged row is dropped, unmatched, inactive or
non-theatre. No importer defect hiding tagged lists was found; app unchanged.

## Limits
- Endo/Laser/MRI imported titles are the room name only (7/7 matched sessions in
  window; 67 of 1,496 other active sessions likewise) — "labelled" here means a
  title exists, not that the procedure is known.
- 6 Endo slots: the assignments feed only carries assigned people, so it cannot
  distinguish "no list" from "list with no anaesthetist" or give a list name.
  Needed: the CLWRota Uncovered sessions report (Date, Session, Location,
  Speciality, List Name) or a slot-level Report Builder API report.
- Feed contradicts the weekly-screen observation of "blank" Laser AM 8/15 Dec:
  each has an assigned consultant row whose only title is "Laser".

## Live import 25 Nov 2026 – 1 Feb 2027 (authorised, 10 Nov 18:35 UTC)
Supported explicit-range hook on the published app; rota step only.
- Window recorded 25 Nov – 1 Feb, outcome ok, 7,660 rows, 0 write errors, 0 unmatched staff.
- 75 inserted, 3,227 updated, 4,345 skipped non-working, 35 duplicates collapsed, 48 removed.
- No change-log or alert entries (all dates > 48 h ahead).
- The 13 slots: each now has 1 linked entry and an imported title row (room name only, no
  list note, complete evidence). Unverified slots 19 → 6 (Endo AM+PM 24 Nov, 22 Dec, 26 Jan).
- Forecast unchanged otherwise: 6 tagged days (DIEP 11, 18, 23, 25 Nov; Robotic 13, 17 Nov),
  3 potential pressure (11, 17, 23 Nov), 0 elevated, no multi-tagged day.
- Discrepancy: the 48 removals are working rows (12 theatre, 27 on-call, 5 ward, 4 admin; all
  Not setup weeks, none tagged) whose fallback key person|date|half also belongs to a
  non-working row; the clean-up deletes them right after saving. Pre-existing; not fixed.
