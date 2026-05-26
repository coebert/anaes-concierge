
-- Prevent staff from modifying decision fields on their own leave requests,
-- and prevent coordinators/admins from approving their own leave requests.
CREATE OR REPLACE FUNCTION public.enforce_leave_request_update_rules()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_is_coord boolean := public.current_user_is_coordinator_or_admin();
BEGIN
  -- Block self-approval/decision changes by the request owner, even if they
  -- also hold a coordinator/admin role.
  IF v_uid IS NOT NULL AND v_uid = OLD.staff_id THEN
    IF (NEW.status IS DISTINCT FROM OLD.status
        AND NEW.status NOT IN ('pending','cancelled'))
       OR NEW.decided_by IS DISTINCT FROM OLD.decided_by
       OR NEW.decided_at IS DISTINCT FROM OLD.decided_at
       OR NEW.decision_notes IS DISTINCT FROM OLD.decision_notes
    THEN
      RAISE EXCEPTION 'You cannot approve, deny, or modify decision fields on your own leave request.'
        USING ERRCODE = 'insufficient_privilege';
    END IF;

    -- Owners can never change staff_id or shift the request to another user.
    IF NEW.staff_id IS DISTINCT FROM OLD.staff_id THEN
      RAISE EXCEPTION 'Cannot reassign leave request to another staff member.'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;

  -- Non-coordinator owners may not edit other restricted bookkeeping fields.
  IF v_uid = OLD.staff_id AND NOT v_is_coord THEN
    NEW.decided_by    := OLD.decided_by;
    NEW.decided_at    := OLD.decided_at;
    NEW.decision_notes := OLD.decision_notes;
    NEW.conflict_notes := OLD.conflict_notes;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_leave_request_update_rules ON public.leave_requests;
CREATE TRIGGER trg_enforce_leave_request_update_rules
BEFORE UPDATE ON public.leave_requests
FOR EACH ROW
EXECUTE FUNCTION public.enforce_leave_request_update_rules();
