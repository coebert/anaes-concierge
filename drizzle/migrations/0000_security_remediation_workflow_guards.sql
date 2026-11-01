-- 1. Leave requests: unforgeable initial state + decision metadata
CREATE OR REPLACE FUNCTION public.enforce_leave_request_insert_rules()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_coord boolean;
BEGIN
  -- Trusted server paths (service role imports / CLWRota sync) have no JWT subject.
  IF v_uid IS NULL THEN RETURN NEW; END IF;
  v_coord := public.current_user_is_coordinator_or_admin();
  IF v_uid = NEW.staff_id OR NOT v_coord THEN
    IF COALESCE(NEW.status, 'pending') <> 'pending' THEN
      RAISE EXCEPTION 'New leave requests must start as pending.' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NEW.decided_by IS NOT NULL OR NEW.decided_at IS NOT NULL OR NEW.decision_notes IS NOT NULL
       OR NEW.reserve_listed_at IS NOT NULL OR NEW.clwrota_external_id IS NOT NULL THEN
      RAISE EXCEPTION 'Decision and import fields cannot be set when requesting leave.' USING ERRCODE = 'insufficient_privilege';
    END IF;
    NEW.status := 'pending';
  ELSE
    -- Coordinator/admin recording leave for someone else: actor identity is server-derived.
    IF NEW.status IN ('approved', 'rejected') THEN
      NEW.decided_by := v_uid;
      NEW.decided_at := now();
    ELSE
      NEW.decided_by := NULL;
      NEW.decided_at := NULL;
    END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_enforce_leave_request_insert_rules ON public.leave_requests;
CREATE TRIGGER trg_enforce_leave_request_insert_rules
  BEFORE INSERT ON public.leave_requests
  FOR EACH ROW EXECUTE FUNCTION public.enforce_leave_request_insert_rules();

CREATE OR REPLACE FUNCTION public.enforce_leave_request_update_rules()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_is_coord boolean := public.current_user_is_coordinator_or_admin();
BEGIN
  IF v_uid IS NULL THEN RETURN NEW; END IF;

  IF v_uid = OLD.staff_id THEN
    IF (NEW.status IS DISTINCT FROM OLD.status AND NEW.status NOT IN ('pending','cancelled'))
       OR NEW.decided_by IS DISTINCT FROM OLD.decided_by
       OR NEW.decided_at IS DISTINCT FROM OLD.decided_at
       OR NEW.decision_notes IS DISTINCT FROM OLD.decision_notes
       OR NEW.reserve_listed_at IS DISTINCT FROM OLD.reserve_listed_at
       OR NEW.clwrota_external_id IS DISTINCT FROM OLD.clwrota_external_id
    THEN
      RAISE EXCEPTION 'You cannot approve, deny, or modify decision fields on your own leave request.'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NEW.staff_id IS DISTINCT FROM OLD.staff_id THEN
      RAISE EXCEPTION 'Cannot reassign leave request to another staff member.'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    -- Once decided, the owner may only cancel; dates/type/reason are frozen.
    IF OLD.status <> 'pending' THEN
      IF NEW.status IS DISTINCT FROM 'cancelled'
         OR NEW.start_date IS DISTINCT FROM OLD.start_date
         OR NEW.end_date IS DISTINCT FROM OLD.end_date
         OR NEW.half_day_start IS DISTINCT FROM OLD.half_day_start
         OR NEW.half_day_end IS DISTINCT FROM OLD.half_day_end
         OR NEW.type IS DISTINCT FROM OLD.type
         OR NEW.reason IS DISTINCT FROM OLD.reason
      THEN
        RAISE EXCEPTION 'A decided leave request can only be cancelled by its owner.'
          USING ERRCODE = 'insufficient_privilege';
      END IF;
    END IF;
    IF NOT v_is_coord THEN
      NEW.conflict_notes := OLD.conflict_notes;
    END IF;
    RETURN NEW;
  END IF;

  -- Coordinator/admin deciding someone else's request: actor is server-derived.
  IF v_is_coord THEN
    IF NEW.status IS DISTINCT FROM OLD.status AND NEW.status IN ('approved','rejected') THEN
      NEW.decided_by := v_uid;
      NEW.decided_at := now();
    ELSIF NEW.decided_by IS DISTINCT FROM OLD.decided_by AND NEW.decided_by IS NOT NULL AND NEW.decided_by <> v_uid THEN
      RAISE EXCEPTION 'decided_by must be the acting reviewer.' USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- 2. Profiles: only self-service fields editable by the row owner
CREATE OR REPLACE FUNCTION public.enforce_profile_self_update()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL OR public.has_role(v_uid, 'admin') THEN RETURN NEW; END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.email IS DISTINCT FROM OLD.email
     OR NEW.email_enc IS DISTINCT FROM OLD.email_enc
     OR NEW.email_hash IS DISTINCT FROM OLD.email_hash
     OR NEW.grade IS DISTINCT FROM OLD.grade
     OR NEW.training_level IS DISTINCT FROM OLD.training_level
     OR NEW.gmc_number IS DISTINCT FROM OLD.gmc_number
     OR NEW.gmc_number_enc IS DISTINCT FROM OLD.gmc_number_enc
     OR NEW.start_date IS DISTINCT FROM OLD.start_date
     OR NEW.active IS DISTINCT FROM OLD.active
     OR NEW.clwrota_external_id IS DISTINCT FROM OLD.clwrota_external_id
     OR NEW.rotation_end_date IS DISTINCT FROM OLD.rotation_end_date
     OR NEW.ltft_days_off IS DISTINCT FROM OLD.ltft_days_off
     OR NEW.left_at IS DISTINCT FROM OLD.left_at
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'Only your display name and calendar link can be changed from your own profile.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS profiles_enforce_self_update ON public.profiles;
CREATE TRIGGER profiles_enforce_self_update
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.enforce_profile_self_update();

-- 3. Exception reports: workflow + actor identity
CREATE OR REPLACE FUNCTION public.enforce_exception_report_insert()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF auth.uid() IS NULL THEN RETURN NEW; END IF;
  IF COALESCE(NEW.status, 'submitted') <> 'submitted'
     OR NEW.outcome IS NOT NULL OR NEW.outcome_note IS NOT NULL
     OR NEW.responder_id IS NOT NULL OR NEW.acknowledged_at IS NOT NULL OR NEW.resolved_at IS NOT NULL THEN
    RAISE EXCEPTION 'New exception reports must be submitted without review fields.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  NEW.status := 'submitted';
  NEW.created_at := now();
  NEW.due_by := now() + CASE WHEN COALESCE(NEW.immediate_safety_concern, false)
                             THEN interval '24 hours' ELSE interval '7 days' END;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS exception_reports_enforce_insert ON public.exception_reports;
CREATE TRIGGER exception_reports_enforce_insert
  BEFORE INSERT ON public.exception_reports
  FOR EACH ROW EXECUTE FUNCTION public.enforce_exception_report_insert();

CREATE OR REPLACE FUNCTION public.enforce_exception_report_update()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN RETURN NEW; END IF;

  -- Submission fields and SLA are immutable for everyone after submission.
  IF NEW.trainee_id IS DISTINCT FROM OLD.trainee_id
     OR NEW.event_date IS DISTINCT FROM OLD.event_date
     OR NEW.event_session IS DISTINCT FROM OLD.event_session
     OR NEW.category IS DISTINCT FROM OLD.category
     OR NEW.description IS DISTINCT FROM OLD.description
     OR NEW.immediate_safety_concern IS DISTINCT FROM OLD.immediate_safety_concern
     OR NEW.hours_worked_extra IS DISTINCT FROM OLD.hours_worked_extra
     OR NEW.rest_missed_hours IS DISTINCT FROM OLD.rest_missed_hours
     OR NEW.due_by IS DISTINCT FROM OLD.due_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'Submitted exception details cannot be changed.' USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF v_uid = OLD.trainee_id THEN
    IF NOT (OLD.status = 'submitted' AND NEW.status IN ('submitted','withdrawn'))
       OR NEW.outcome IS DISTINCT FROM OLD.outcome
       OR NEW.outcome_note IS DISTINCT FROM OLD.outcome_note
       OR NEW.responder_id IS DISTINCT FROM OLD.responder_id
       OR NEW.acknowledged_at IS DISTINCT FROM OLD.acknowledged_at
       OR NEW.resolved_at IS DISTINCT FROM OLD.resolved_at
    THEN
      RAISE EXCEPTION 'You can only withdraw your own exception while it is submitted.'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;

  IF NOT public.has_role(v_uid, 'admin') THEN
    RAISE EXCEPTION 'Only reviewers can update exception reports.' USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF OLD.status = 'withdrawn' OR NEW.status = 'withdrawn' AND OLD.status <> 'withdrawn' THEN
    RAISE EXCEPTION 'Withdrawn reports are closed; only the trainee can withdraw.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.responder_id IS DISTINCT FROM OLD.responder_id
     AND NEW.responder_id IS NOT NULL AND NEW.responder_id <> v_uid THEN
    RAISE EXCEPTION 'responder_id must be the acting reviewer.' USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NEW.status <> 'submitted' AND OLD.acknowledged_at IS NULL THEN
    NEW.acknowledged_at := now();
    NEW.responder_id := COALESCE(OLD.responder_id, v_uid);
  ELSE
    NEW.acknowledged_at := OLD.acknowledged_at;
  END IF;

  IF NEW.status = 'resolved' THEN
    IF NEW.outcome IS NULL THEN
      RAISE EXCEPTION 'An outcome is required to resolve an exception.' USING ERRCODE = 'check_violation';
    END IF;
    NEW.resolved_at := CASE WHEN OLD.status = 'resolved' THEN OLD.resolved_at ELSE now() END;
    NEW.responder_id := COALESCE(NEW.responder_id, v_uid);
  ELSE
    NEW.resolved_at := NULL;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS exception_reports_enforce_update ON public.exception_reports;
CREATE TRIGGER exception_reports_enforce_update
  BEFORE UPDATE ON public.exception_reports
  FOR EACH ROW EXECUTE FUNCTION public.enforce_exception_report_update();

-- 5. Push subscriptions: endpoint must be a known browser push service
CREATE OR REPLACE FUNCTION public.enforce_push_subscription_endpoint()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NEW.endpoint IS NULL OR length(NEW.endpoint) > 1024
     OR NEW.endpoint !~ '^https://(fcm\.googleapis\.com|android\.googleapis\.com|updates\.push\.services\.mozilla\.com|[a-z0-9-]+\.push\.services\.mozilla\.com|web\.push\.apple\.com|[a-z0-9-]+\.push\.apple\.com|[a-z0-9-]+\.notify\.windows\.com)/[A-Za-z0-9._~:/?=&%+,!*()$-]+$'
  THEN
    RAISE EXCEPTION 'Unsupported push endpoint.' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.p256dh IS NULL OR NEW.p256dh !~ '^[A-Za-z0-9_+/-]{86,88}={0,2}$' THEN
    RAISE EXCEPTION 'Invalid push key.' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.auth IS NULL OR NEW.auth !~ '^[A-Za-z0-9_+/-]{21,24}={0,2}$' THEN
    RAISE EXCEPTION 'Invalid push auth secret.' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.user_agent IS NOT NULL AND length(NEW.user_agent) > 512 THEN
    NEW.user_agent := left(NEW.user_agent, 512);
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS push_subscriptions_enforce_endpoint ON public.push_subscriptions;
CREATE TRIGGER push_subscriptions_enforce_endpoint
  BEFORE INSERT OR UPDATE ON public.push_subscriptions
  FOR EACH ROW EXECUTE FUNCTION public.enforce_push_subscription_endpoint();

REVOKE ALL ON FUNCTION public.enforce_leave_request_insert_rules() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.enforce_profile_self_update() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.enforce_exception_report_insert() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.enforce_exception_report_update() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.enforce_push_subscription_endpoint() FROM PUBLIC, anon, authenticated;
