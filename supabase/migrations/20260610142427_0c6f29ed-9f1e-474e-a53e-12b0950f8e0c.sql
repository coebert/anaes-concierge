WITH tagged(session_date, session, theatre_name) AS (
  VALUES
    ('2026-05-14'::date, 'am'::session_half, 'NHH Theatre 4'),
    ('2026-05-14'::date, 'pm'::session_half, 'NHH Theatre 4'),
    ('2026-05-15'::date, 'am'::session_half, 'NHH Theatre 2'),
    ('2026-05-15'::date, 'pm'::session_half, 'NHH Theatre 2'),
    ('2026-05-18'::date, 'am'::session_half, 'NHH Theatre 3'),
    ('2026-05-18'::date, 'pm'::session_half, 'NHH Theatre 3'),
    ('2026-05-20'::date, 'am'::session_half, 'NHH Theatre 5'),
    ('2026-05-20'::date, 'pm'::session_half, 'NHH Theatre 5'),
    ('2026-05-21'::date, 'am'::session_half, 'NHH Theatre 3'),
    ('2026-05-21'::date, 'pm'::session_half, 'NHH Theatre 3'),
    ('2026-05-22'::date, 'am'::session_half, 'NHH Theatre 2'),
    ('2026-05-22'::date, 'pm'::session_half, 'NHH Theatre 2'),
    ('2026-05-28'::date, 'am'::session_half, 'NHH Theatre 4'),
    ('2026-05-28'::date, 'pm'::session_half, 'NHH Theatre 4'),
    ('2026-05-29'::date, 'am'::session_half, 'NHH Theatre 1'),
    ('2026-06-03'::date, 'am'::session_half, 'NHH Theatre 5'),
    ('2026-06-03'::date, 'pm'::session_half, 'NHH Theatre 5'),
    ('2026-06-04'::date, 'am'::session_half, 'NHH Theatre 3'),
    ('2026-06-04'::date, 'pm'::session_half, 'NHH Theatre 4'),
    ('2026-06-08'::date, 'am'::session_half, 'NHH Theatre 4'),
    ('2026-06-09'::date, 'am'::session_half, 'NHH Theatre 4'),
    ('2026-06-11'::date, 'am'::session_half, 'NHH Theatre 2'),
    ('2026-06-11'::date, 'am'::session_half, 'NHH Theatre 5'),
    ('2026-06-11'::date, 'pm'::session_half, 'NHH Theatre 2'),
    ('2026-06-11'::date, 'pm'::session_half, 'NHH Theatre 5'),
    ('2026-06-15'::date, 'am'::session_half, 'NHH Theatre 5'),
    ('2026-06-15'::date, 'pm'::session_half, 'NHH Theatre 5'),
    ('2026-06-19'::date, 'am'::session_half, 'NHH Theatre 5')
), matched AS (
  SELECT ts.id
  FROM tagged
  JOIN public.theatres th ON lower(th.name) = lower(tagged.theatre_name)
  JOIN public.theatre_sessions ts
    ON ts.theatre_id = th.id
   AND ts.session_date = tagged.session_date
   AND ts.session = tagged.session
  WHERE ts.non_sag_override = false
)
UPDATE public.theatre_sessions ts
SET is_non_sag = true,
    updated_at = now()
FROM matched
WHERE ts.id = matched.id
  AND ts.is_non_sag = false;