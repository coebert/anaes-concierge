
DROP POLICY IF EXISTS "Staff update own pending leave requests" ON public.leave_requests;
CREATE POLICY "Staff update own pending leave requests"
ON public.leave_requests
FOR UPDATE
TO authenticated
USING (auth.uid() = staff_id AND status = 'pending'::leave_status)
WITH CHECK (
  auth.uid() = staff_id
  AND status IN ('pending'::leave_status, 'cancelled'::leave_status)
);

REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.log_late_rota_change() FROM PUBLIC, anon, authenticated;
