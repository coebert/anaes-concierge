-- Backfill duty_type on previously-synced rows by inspecting the free-text
-- "Surgeon: X" label in notes plus the staff member's grade/training level.
-- Only touches CLWRota-sourced rows currently classified as theatre.

WITH classified AS (
  SELECT
    ra.id,
    CASE
      WHEN lower(coalesce(ra.notes, '')) ~ 'consultant in charge|\mcic\M'
        THEN 'consultant_in_charge'::duty_type
      WHEN lower(coalesce(ra.notes, '')) ~ '\m(2nd|second)\M.*obstet|obstet.*\m(2nd|second)\M'
        THEN 'obstetrics_2nd'::duty_type
      WHEN lower(coalesce(ra.notes, '')) ~ 'obstet'
        THEN 'obstetrics'::duty_type
      WHEN lower(coalesce(ra.notes, '')) ~ 'icu|intensive|critical care' THEN
        CASE
          WHEN p.grade = 'consultant'::staff_grade THEN 'icu_consultant_oncall'::duty_type
          WHEN p.grade = 'trainee'::staff_grade
               AND upper(coalesce(p.training_level,'')) IN ('CT1','CT2','ACCS1','ACCS2','ACCS3')
            THEN 'icu_trainee'::duty_type
          ELSE 'icu_ct2_plus'::duty_type
        END
      WHEN lower(coalesce(ra.notes, '')) ~ 'on[ -]?call' THEN
        CASE
          WHEN p.grade = 'consultant'::staff_grade THEN 'general_consultant_oncall'::duty_type
          WHEN p.grade = 'sas'::staff_grade THEN 'registrar_oncall'::duty_type
          WHEN p.grade = 'trainee'::staff_grade
               AND upper(coalesce(p.training_level,'')) IN ('CT1','CT2','ACCS1','ACCS2','ACCS3')
            THEN 'sho_oncall'::duty_type
          WHEN p.grade = 'trainee'::staff_grade THEN 'registrar_oncall'::duty_type
          ELSE 'registrar_oncall'::duty_type
        END
      ELSE 'theatre'::duty_type
    END AS new_duty
  FROM public.rota_assignments ra
  JOIN public.profiles p ON p.id = ra.staff_id
  WHERE ra.source = 'clwrota'
    AND ra.duty_type = 'theatre'
    AND ra.locally_modified = false
)
UPDATE public.rota_assignments ra
SET duty_type = c.new_duty,
    role_on_list = CASE WHEN c.new_duty = 'theatre' THEN ra.role_on_list ELSE 'on_call'::rota_role END,
    theatre_session_id = CASE WHEN c.new_duty = 'theatre' THEN ra.theatre_session_id ELSE NULL END
FROM classified c
WHERE ra.id = c.id
  AND c.new_duty <> 'theatre';
