# CLWRota capture audit — 12 Nov 2026

Scope: the three configured Central API feeds (assignments, leave_events, people) against the
deployed import, the live database and downstream cover/forecast. Evidence is read-only: feeds
fetched with the configured key (GET only), database read through a SELECT-only client, every
write recorded in memory and never sent. Counts only — no names, notes or identifiers.
Read times 09:34–09:56 UTC. Rota window 25 Nov 2026 – 1 Feb 2027 unless stated.

## 1. Sources
| Feed | Query | Rows | Kind |
|---|---|---|---|
| Assignments | `query/assignments` | 7,662 in window | one row per person per half; 101 accepted fields |
| Leave | `query/leave_events` | 12,158 events (4,673 requests), −365/+240 days | one row per leave day/session |
| People | `query/people` | 133 | one row per person |

- **No source for unstaffed lists.** None of the 101 accepted assignment fields describes a
  session with nobody on it; `slot_*` values only arrive on staffed rows. Lists with nobody
  rostered can't be seen from this feed. The CLWRota Uncovered sessions report (or a
  session-level Report Builder query) is still needed. No URL was guessed.
- Window status in the feed: Setup 2,820 rows, Not setup 4,842, none Published. Row state:
  actual 4,517, planned 3,145 (neither means delivered).

## 2. Field inventory (assignments)
Req = requested, Ret = non-empty rows returned. Pending = kept once migration 0011 is applied.

| Field | Ret | Before | Now (preview) |
|---|---|---|---|
| date, session/shift label | 7,662 | used (date, half) | + raw label kept (pending) |
| start_time, end_time, duration | 7,662 | used only to split all-day ME rows; not stored | stored typed (pending) |
| state, rota_status | 7,662 | week-level counts only | + per row (pending) |
| pa_value | 7,662 | stored (`pa_credit`) | unchanged |
| slot_titles | 7,658 | theatre-linked: source labels + legacy title; **1,997 other stored rows: not stored**; 35 collapsed: lost | every stored row + collapsed rows (pending) |
| slot_notes | 25 | linked 6 → labels; unlinked 8 → assignment note (derived); 11 on day-off rows → excluded | + raw per row (pending) |
| place.additional_info | 2,317 (22 values, constant per place) | linked → labels; 1,051 unlinked: not stored | per row (pending) |
| place.name / local_id / category | 7,662 | name used for matching; id and category unused | kept per row (pending) |
| role.name / role_category | 7,662 | normalised role only | raw kept (pending) |
| slot_speciality | 4,808 | theatre specialty | + per row (pending) |
| extra_type.name / description | 30 / 0 | stored lowercased | unchanged + raw (pending) |
| assignment_type | 7,662 (Extra 6) | unused | kept (pending) |
| extra_submittal.* (36 fields, incl. admin_notes, extra_notes, reason_for_cover) | 0 | — | pay fields no longer requested; nothing to capture |
| person.mobile_number, last_login, sharing_mobile_number, payscale, payroll_period_type, calculation_set | up to 7,584 | **fetched, never used or stored** | **no longer requested** |
| person.email / local_id / rota_name | 7,662 | staff matching | unchanged |
| service.*, tier org units | constant | unused | unchanged |

The People feed also stops requesting mobile, last login and pay fields. The Leave feed requests
`leave_request.details` (5,124 non-empty, stored encrypted as the reason). It doesn't request the
HR fields available (occupational health, disability, HR interaction). `course_cost` and
`course_name` are available but not requested, so the department needs to decide whether to
bring them in for the study budget.

## 3. Row disposition (assignments, 7,662 rows; exact — every row mapped)
| Disposition | Rows |
|---|---|
| Excluded: day-off/available label (Available pools 770+301, Ignored places 3,186, 41 in Theatre/Admin/Ward places carrying an independent off/leave marker) | 4,298 |
| Unparseable date / session, no key, unmatched staff | 0 / 0 / 0 / 0 |
| Collapsed (one row per person per half): 13 same fallback key (7 on-call→theatre, 4 SPA, 1 admin, 1 in-charge → ICU on-call), 22 vs a medical-examiner half (10 in-charge, 6 SPA, 6 theatre) | 35 |
| Stored, linked to a theatre list | 1,328 |
| Stored, theatre duty with no list (weekend day lists ×26, Cardiac Suite etc. have no app theatre) | 25 |
| Stored, not a list (on-call, ICU, ward, SPA, admin, ME, teaching…) | 1,976 |
| **Total** | **7,662** |

Stored assignments = 3,329 rows + 22 extra ME halves = 3,351, which matches the live import exactly.
Leave: 12,158 events, 460 skipped (15 people not in the app), 11,698 grouped into 4,670 requests,
all saved. Staff feed disposition wasn't traced row by row.

## 4. Defects found and fixed (preview, tested)
**A. Removed assignments never left the app.** The feed has no tombstones. Of 3,635 stored rows in
the window, **284 are no longer in CLWRota.** In 234 the person has no feed rows at all that day; in
50 they have other halves only. 176 fall on approved leave (CLWRota drops the duty when leave is
approved). 122 are linked to 119 theatre lists, and 29 of those lists would have nobody linked.
No tagged list is affected. With these rows gone, the cover view shows real gaps it currently
hides: 13 half-days change risk (ok 56→49, SPA needed 4→8, shortfall 4→6, headroom 166→130), and
25 Nov becomes a potential-pressure day (DIEP, PM tight). The fix is `removed-assignments.ts`,
run after saving. It applies only to dates the feed returned with every row matched, inside the
requested window, from today onward. It never touches locally edited or manual rows, and it
refuses to run if the import had any error or if more than 10% (minimum 25) would go. A
read-only rehearsal removed all 284 and nothing else. Across the default import window, 395 past
rows are also absent: they are counted and kept, and need a decision.
Tests: `removed-assignments.test.ts` (10).

**B. Multi-day leave saved as one day.** The import read each event's own start/end and kept the
last one per request. **892 approved requests** had the wrong span (1,098 multi-day requests
truncated in the import payload), missing about 1,996 working days: annual 796, sick 439,
maternity 330, study 154, TOIL 122, others 155. 205 of them end today or later. Leave now comes
from `leave_request.start_date/end_date`, merged by widest event span. In a rehearsal all 4,469
requests matched their source span (0 wrong). Test: `leave-span.test.ts`, which fails on the old
code.

**C. Notes-like values dropped for non-list rows.** These are now kept independently per stored
assignment by `source-details.ts`: titles, list notes, place notes, place/role/category, typed
times, state, and the 35 collapsed rows. They go to a service-only table in pending migration
`drizzle/pending/0011_rota_assignment_source_details.sql`. Until that's applied, the import logs
"not installed yet" and carries on. The throwaway-database harness
`tests/db-harness/source-details/run.sh` passed 35/35, including real PostgREST: staff, admin,
coordinator and anon are denied; service can read and write; values are bounded; deleting or
re-keying an assignment cascades. Tests: `source-details.test.ts` (9).

**D. Unused personal data pulled in.** Mobile numbers, last login and pay fields are no longer
requested by any feed. A re-read returned the same rows (7,662 / 11,739 / 133) and every rota row
was handled identically. Test: `report-field-minimisation.test.ts` (4).

Full suite: 2,148 passed, 4 skipped. Preview build OK.

## 5. Not changed — need a decision or a source
- Half-day leave: the feed has per-event times, but the import never sets the half-day fields.
  The app also reads `half_day_start` two opposite ways: the pattern view takes 'pm' as "PM
  only", while the leave lists show 'am' as "PM only". The meaning needs fixing before half-days
  are imported.
- The 22 medical-examiner collapses and the one-row-per-half rule. The losing rows are kept as
  source details once 0011 is applied.
- Weekend day lists (26 rows), Cardiac Suite and Endoscopy (Wednesdays) have no or alias-only app
  theatre. No mapping was invented.
- 395 past rows absent from the feed are kept as history.
- The six Endo slots still need the Uncovered sessions report.

## 6. Activation (not done — not authorised by this audit)
1. Publish, then run one rota import and one leave import. Expected for 25 Nov – 1 Feb: 284 rows
   removed (about 465 across the default today-to-+120-day window), and 892 approved leave
   requests widened. Deletions within 48 hours and leave changes go through the existing change
   triggers, which may raise normal alerts.
2. Approve and apply migration 0011, then the next rota import fills the source details.
