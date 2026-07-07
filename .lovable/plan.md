# Point 10 — Wellbeing & retention signals

Turn the rota + leave + sickness data the app already collects into
proactive wellbeing and retention intelligence, plus two lightweight new
data streams (pulse survey + peer recognition).

## What gets built

### 1. Wellbeing score engine (pure TS)

`src/features/wellbeing/wellbeing-score.ts`

Composite per-staff score over rolling 90 days, derived from:

- Nights worked / month (from `rota_assignments.session = 'night'`)
- Weekends worked / month (Saturday + Sunday sessions)
- Unsocial-hours share (evening + night as % of all sessions)
- Short-notice changes *received* by this doctor (from `rota_change_log`
  where `hours_before_session <= 48`, filtered to their assignments)
- Cancelled / denied leave count (from `leave_requests` where status
  went from approved → cancelled or denied within window)
- Sickness Bradford Factor (imported from `bradford-factor.ts`)
- Exception reports raised in window

Each signal is normalised 0–1 against role-peer median and combined with
transparent weights. Output: `{ score 0–100, band, drivers[] }` where
higher = better wellbeing. Unit-tested with fixtures.

### 2. Attrition risk model (pure TS)

`src/lib/attrition-risk.ts`

Composite features from existing data:

- Wellbeing score (inverse)
- Bradford Factor (>200)
- Leave-denial rate (12m)
- Short-notice changes received (12m)
- LTFT requests recorded in `leave_requests` for parental/carers
- Time-since-last-approved-annual-leave
- Overdue RTW interviews
- Recent pulse-survey score trend (if available)

Output: `{ risk 0–1, band: low|watch|elevated|high, top_factors[] }`.
Explicitly *not* a black-box ML model — a transparent weighted rubric so
HR can defend the flag in a conversation.

### 3. Pulse-survey module

New tables:

- `public.pulse_survey_cycles`: `opens_at`, `closes_at`,
  `question_1`, `question_2`, `question_3`, `active bool`.
- `public.pulse_survey_responses`: `cycle_id`, `staff_id`,
  `score_1..3 smallint (1..5)`, `comment_enc bytea`, `created_at`.
  Unique `(cycle_id, staff_id)`.

RLS:
- Any authenticated user can insert their own response and read their own.
- Admins read all rows.
- Coordinators read aggregated stats only via RPC `get_pulse_aggregate()`
  (returns cycle + grade-level averages, no per-user rows).

The comment field is encrypted with the existing sync-trigger pattern; a
`get_pulse_responses_decrypted()` RPC follows the same `decrypt_owner_or_coord`
rule as the other encrypted tables.

### 4. Recognition ledger

New table `public.recognition_entries`:

- `staff_id` (recipient), `from_user_id`, `category`
  (`teaching`, `kindness`, `clinical`, `above_beyond`, `covering_gap`, `other`),
- `message`/`message_enc`, `is_public bool`, `created_at`.

RLS:
- Any authenticated user can insert (they are the sender).
- Recipient always reads their own.
- Public entries readable by all authenticated users (feed).
- Sender always reads their own sent messages.
- Admins read all.

### 5. Routes

- `src/routes/_authenticated/wellbeing.tsx` — staff-facing:
  their own score, trend line, top drivers, current pulse-survey CTA,
  received recognition list.
- `src/routes/_authenticated/admin.wellbeing.tsx` — admin league table:
  per-doctor wellbeing score, attrition-risk badge, drivers, quick links.
- `src/routes/_authenticated/pulse.tsx` — take the currently-open pulse survey.
- `src/routes/_authenticated/admin.pulse.tsx` — manage cycles, view aggregated
  results (grade × cycle heatmap, comments feed if entitled).
- `src/routes/_authenticated/recognition.tsx` — send kudos + view public feed.

### 6. Dialogs / components

- `PulseSurveyDialog` — 3-question form, 1–5 slider each, optional comment.
- `RecognitionDialog` — pick recipient + category + short message.
- Wellbeing score card component reused on the trainee detail page.

### 7. Navigation

- `Wellbeing` (self) under `Home`
- `Recognition` under `Home`
- `Wellbeing (admin)` and `Pulse surveys` under `Audits & robustness`

## Sequencing

1. Migration: `pulse_survey_cycles`, `pulse_survey_responses`,
   `recognition_entries`, encryption triggers, decrypted RPCs, RLS, GRANTs.
2. Pure-TS `wellbeing-score.ts` + `attrition-risk.ts` with tests.
3. Dialogs (`PulseSurveyDialog`, `RecognitionDialog`).
4. Staff routes (`/wellbeing`, `/pulse`, `/recognition`).
5. Admin routes (`/admin/wellbeing`, `/admin/pulse`).
6. Nav entries.
