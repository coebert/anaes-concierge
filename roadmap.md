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
- [ ] Publish that fix and run one import so the 48 Not setup working rows are saved live — needs Rob's go-ahead to publish
