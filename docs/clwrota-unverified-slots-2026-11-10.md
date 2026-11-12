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

## Key-collision investigation (12 Nov 2026, 09:17–09:25 UTC)
Read-only same-range replay (25 Nov 2026 – 1 Feb 2027) of the real import code against the
configured feed and live database; every write was recorded in memory and never sent (database
API limited to reads, egress limited to the feed). Counts only.

- Feed now: 7,662 rows (7,660 on 10 Nov); 4,298 non-working (was 4,345), 3,364 working
  rows -> 3,386 drafts (22 all-day medical-examiner rows split into AM+PM by their times).
- **The 48 rows are already back.** Production already served the clean-up fix (published at or
  after 10 Nov 18:57). The rotating imports of 11 Nov 20:00 and 20:30 re-saved all 48
  (27 ICU consultant on-call, 13 theatre — all linked to a list, 3 obstetrics, 3 SPA, 1 admin,
  1 in-charge) and deleted none. The old delete-every-non-working-key rule would delete the same
  48 again (replayed: 48 deleted after saving); current code deletes 0.
- **The "9 unexplained" were an accounting artefact.** The 44 working rows "not under their own
  key" were 22 all-day medical-examiner rows stored as two half rows (`key|am`, `key|pm`, both
  saved) + 22 rows lost to the one-row-per-half collapse. 44 - 35 left 9 only because the 13
  repeated-key collapses do not leave a key missing. Historical figures reconcile exactly:
  (7,660 - 4,345) + 22 splits - 35 collapses = 3,302 saved.
- **35 collapses are all separate duties, not true duplicates:**
  - 13 share a fallback key: an ICU consultant on-call row plus a theatre (7), SPA (4), admin
    (1) or in-charge (1) row in the same weekday half. Previously the later feed row won.
  - 22 have different keys: an all-day medical-examiner split beats an AM in-charge (10),
    SPA (6) or theatre (6) row (existing priority). Unchanged; logged for a decision.
- Other collision paths checked: medical-examiner pre-split purge (only un-suffixed ME rows),
  stale same-half replacement (pre-upsert; a failed upsert chunk self-heals on the next run),
  locally edited rows (0 in window; never deleted or overwritten), manual rows (0 in window),
  chunked slices (a key never spans two slices), explicit source ids (latest copy still wins).

### Fix (tested)
- Working evidence is recorded for every working-classified feed row before later row skips, so
  a shared non-working row can never delete it (e.g. if the person is temporarily unmatched).
- Two working rows on one fallback key resolve by the existing duty priority, not feed order:
  theatre still wins over on-call (7); ICU consultant on-call now wins over SPA (4), admin (1)
  and in-charge (1). Repeated source row ids keep latest-copy-wins.
- Replay vs live code, same feed: 0 rows deleted either way, 0 rows added/removed by the fix;
  6 stored halves change duty (4 SPA, 1 admin, 1 in-charge -> ICU consultant on-call, 28 Dec–25 Jan).

Forecast before import (app logic, read-only, 10 Nov – 1 Feb): 6 tagged days, 3 potential
pressure (11, 17, 23 Nov), 0 elevated, 6 unverified slots (Endo AM+PM 24 Nov, 22 Dec, 26 Jan);
25 Nov – 1 Feb halves: 57 ok, 33 tight, 4 SPA needed, 4 shortfall.

### Live import after publishing (12 Nov 2026 09:31 UTC, rota only, 25 Nov 2026 – 1 Feb 2027)
- New deployment observed on the live site before the import; the import's own summary used the
  new wording ("0 identical duty, 35 a different duty"), confirming the new code ran.
- 7,662 rows, 3,351 saved (48 inserted, 3,303 updated), 0 write errors, 0 rows deleted,
  0 non-working clean-ups, 48 working rows kept despite a same-key non-working row; window
  recorded as ok and fully covered. 0 change-log entries, 0 alerts (all dates > 48 h away).
- Database before/after: 3,587 -> 3,635 rows; 0 removed; 48 added, all December ICU trainee
  (46) or general on-call (2) rows that changed in CLWRota from non-working to working since
  10 Nov — not the 48 collision rows, which were all still present. 6 duty changes exactly as
  replayed; 0 theatre-link changes. Live result matched the replay prediction by duty type.
- Forecast after (10 Nov – 1 Feb): unchanged — 6 tagged days, 3 potential pressure
  (11, 17, 23 Nov), 0 elevated, 6 unverified Endo slots. Cover: only 25 Jan changed
  (AM one fewer SPA contingency; PM ok -> tight, the consultant now on ICU on-call that day);
  Dec ICU rows raised "other duty" counts on 14–22 Dec without changing headroom.
  25 Nov – 1 Feb halves: 56 ok, 34 tight, 4 SPA needed, 4 shortfall.
- Unrelated: the cover view's leave read dropped 14 rows repeated across page boundaries
  (its sort order isn't unique) — flagged in the roadmap, not changed.
