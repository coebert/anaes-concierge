# Roadmap (2026-11-01 remediation)

Done: security follow-up, accuracy A–E, TCS honesty, frontend F–I, baseline tests, zod 4, auth identity transition, fail-closed scanner, audit column allowlist + PostgREST harness, encrypted/view-path harness, calendar fail-closed/half days, CI lock/typecheck/build. Reports: `docs/audit-2026-11-01-accuracy-remediation.md`, `docs/audit-2026-11-01-final-verification.md`.

## Open
- [ ] Signed-in live checks (hosted audit GET, browser account switch, chat 375px) — blocked: no signed-in session
- [ ] Chat concurrency cap — not implemented
- [ ] Convert remaining fixed wide-range queries on analytics pages to full paging
- [ ] 191 pre-existing lint errors (mostly `any`)
- [ ] esbuild (drizzle-kit) + minimatch (eslint) moderate, katex low — blocked on upstream pins
- [ ] Confirm cross-year study £ attribution rule — waiting on department
- [ ] Wellbeing: department sign-off on coverage gate (10 sessions) — awaiting user
- [ ] Wellbeing: per-person pulse trend not wired (shown "not assessed") — needs survey design decision
- [ ] Review 16 SECURITY DEFINER linter warnings individually; deep code scan is stale (cannot trigger here)
- [ ] Theatre pressure forecast: manual confirm/override of tagged lists — needs a new table (production migration), kept read-only in v1
- [ ] Apply pending migration `drizzle/pending/0008_theatre_session_source_labels.sql` to the live database (needs Rob's go-ahead), then one rota import fills the original titles/notes
- [ ] Apply pending migration `drizzle/pending/0009_clwrota_week_status.sql` (needs Rob's go-ahead); next import records week status
- [ ] Decide whether CLWRota `state=planned` rows (future Not setup weeks) should be imported as assignments
- [ ] Uncovered sessions / week status dates / planned-vs-delivered: needs an authorised Report Builder API report or exact export header sample
- [x] Shared cover rules, duty-category read failures shown with Retry, weekly import status (Status vs Import) — synthetic-tested
- [x] Apply migrations 0008/0009/0010 to live and run one real rota import
- [x] Publish (incl. off-site day-off fix) and run one live import; verify 17 Nov Laser AM, forecast, unmatched counts
- [ ] Decide whether a list staffed only by SAS/junior doctors counts as filled in headroom — waiting on department
- [x] 13 unverified slots (2 Dec–28 Jan) re-imported under the fixed off-site rule (live import 25 Nov–1 Feb, 10 Nov 18:35)
- [x] Unplaced sessions report (admins + coordinators): lists with nobody linked beside CLWRota rows placed on no list
- [ ] 6 blank Endo slots (24 Nov, 22 Dec, 26 Jan): report narrows them, but only CLWRota (Uncovered sessions) can say cancelled vs uncovered
- [ ] 104 lists have nobody linked but only 6 show as unverified in the forecast (the rest have titles) — investigate why their staff rows aren't linked
- [x] Importer no longer deletes a working row that shares its person/date/half key with a non-working row (fixed in preview, tested)
- [x] Clean-up fix was already live (published ≥ 10 Nov 18:57); the 48 rows were re-saved by the 11 Nov 20:00/20:30 imports
- [x] Fallback-key collisions: working evidence recorded before later skips; two working rows on one key resolved by duty priority (published + live import 25 Nov–1 Feb, 12 Nov)
- [ ] 22 rows per window lost to a same-half medical-examiner split (6 theatre, 10 in-charge, 6 SPA; all AM) — one row per half is stored; needs a department decision on which duty wins

- [ ] Cover view leave read: sort order not unique (14 repeated rows dropped across pages) — add an id tiebreaker

## CLWRota end-to-end capture audit (12 Nov)
- [x] Field inventory, exact row disposition, notes capture — `docs/clwrota-capture-audit-2026-11-12.md`
- [x] Preview fixes: removed-assignment reconciliation, leave request span, per-assignment source details (writer), unused personal fields dropped
- [x] Published (12 Nov 11:04, Rob approved); scheduled rota/leave imports apply the fixes (284 stale rows removed, 892 leave requests widened) as they reach those dates
- [x] Migration 0011 (per-assignment titles/notes) applied live 12 Nov 11:10 after 35/35 throwaway-DB checks; filled by each scheduled rota import from 12:05 for the dates it covers
- [ ] Decide meaning of `half_day_start/end` (screens disagree) before importing half-day leave
- [ ] Decide what to do with 395 past rows no longer in CLWRota (kept as history)
- [ ] Weekend day lists / Cardiac Suite have no app theatre — department decision

## Practice summary for appraisal (12 Nov)
- [x] My practice summary (/me/practice-summary): own data only, appraisal-year default + custom dates, print + aggregate CSV, tests (preview only)
- [x] Published; signed-in preview check of /me/practice-summary (figures match the appraisal-year page)
- [x] Appraisal-year page loads from the server: own year only, other doctors for admins/coordinators, paged, errors with Retry (preview, tested)
- [x] Published with the leave section (12 Nov)
- [x] Leave import run live with the span fix (12 Nov 11:12): 4,670 requests saved, 0 errors; My practice summary shows approved leave in working days

## 12 Nov follow-ups
- [x] Duties & on-call: read-only MRI location line (AM/PM, people linked to MRI lists; list-with-nobody vs no list)
- [x] My practice summary: "Days with daytime work" counts each date once (was summed per specialty: 149 → 119 on 2026/27); report + CSV + print use the same total; tests + synthetic PDF check
- [x] Appraisal-year page counts each worked date once (119), shared rule with My practice summary (preview; not yet published)
- [x] Live run 12 Nov 11:46 (rota 25 Nov–1 Feb): 284 stale rows removed by the guarded pass, but the data-loss check didn't allow for them and marked the run partial — fixed (check now subtracts guarded removals), published, re-run 11:52 clean
- [x] Leave import re-run 12 Nov 11:48: 12,175 pulled, 4,673 saved, 0 errors; 461 skipped for 15 people not in the app
