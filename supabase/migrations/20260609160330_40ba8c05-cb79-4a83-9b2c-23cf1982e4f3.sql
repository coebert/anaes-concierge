
-- 1. Profile column to remember when a trainee effectively left
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS left_at date;

-- 2. SECURITY DEFINER function that deactivates trainees with a >28 day gap
CREATE OR REPLACE FUNCTION public.mark_departed_trainees()
RETURNS TABLE(staff_id uuid, left_at date)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  WITH last_activity AS (
    SELECT
      p.id AS staff_id,
      GREATEST(
        (SELECT MAX(ra.session_date)
           FROM public.rota_assignments ra
          WHERE ra.staff_id = p.id),
        (SELECT MAX(lr.end_date)
           FROM public.leave_requests lr
          WHERE lr.staff_id = p.id
            AND lr.status = 'approved')
      ) AS last_day
    FROM public.profiles p
    WHERE p.grade = 'trainee'
      AND p.active = true
  ),
  to_mark AS (
    SELECT la.staff_id, (la.last_day + INTERVAL '1 day')::date AS effective_left_at
      FROM last_activity la
     WHERE la.last_day IS NOT NULL
       AND la.last_day < CURRENT_DATE
       AND (CURRENT_DATE - la.last_day) > 28
  )
  UPDATE public.profiles p
     SET active = false,
         left_at = t.effective_left_at,
         updated_at = now()
    FROM to_mark t
   WHERE p.id = t.staff_id
   RETURNING p.id, p.left_at;
END;
$$;

REVOKE ALL ON FUNCTION public.mark_departed_trainees() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.mark_departed_trainees() TO service_role;
