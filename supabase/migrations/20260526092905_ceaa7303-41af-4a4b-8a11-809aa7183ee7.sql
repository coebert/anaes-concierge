CREATE UNIQUE INDEX IF NOT EXISTS rota_assignments_no_double_booking
ON public.rota_assignments (staff_id, session_date, session);