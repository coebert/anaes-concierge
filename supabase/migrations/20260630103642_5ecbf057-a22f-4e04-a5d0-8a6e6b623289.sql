
-- INSTEAD OF triggers on the encryption-aware views so callers can keep using
-- the plaintext column names for INSERT/UPDATE; the trigger encrypts.

-- profiles_v
CREATE OR REPLACE FUNCTION public._profiles_v_insert()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
BEGIN
  INSERT INTO public.profiles (
    id, email, full_name, grade, training_level, gmc_number,
    start_date, active, clwrota_external_id, rotation_end_date,
    ltft_days_off, left_at, calendar_feed_token
  ) VALUES (
    COALESCE(NEW.id, gen_random_uuid()),
    NEW.email, NEW.full_name, NEW.grade, NEW.training_level, NEW.gmc_number,
    NEW.start_date, COALESCE(NEW.active, true), NEW.clwrota_external_id,
    NEW.rotation_end_date, NEW.ltft_days_off, NEW.left_at, NEW.calendar_feed_token
  );
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS profiles_v_insert ON public.profiles_v;
CREATE TRIGGER profiles_v_insert INSTEAD OF INSERT ON public.profiles_v
  FOR EACH ROW EXECUTE FUNCTION public._profiles_v_insert();

CREATE OR REPLACE FUNCTION public._profiles_v_update()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
BEGIN
  UPDATE public.profiles SET
    email = NEW.email,
    full_name = NEW.full_name,
    grade = NEW.grade,
    training_level = NEW.training_level,
    gmc_number = NEW.gmc_number,
    start_date = NEW.start_date,
    active = NEW.active,
    clwrota_external_id = NEW.clwrota_external_id,
    rotation_end_date = NEW.rotation_end_date,
    ltft_days_off = NEW.ltft_days_off,
    left_at = NEW.left_at,
    calendar_feed_token = NEW.calendar_feed_token,
    updated_at = now()
  WHERE id = OLD.id;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS profiles_v_update ON public.profiles_v;
CREATE TRIGGER profiles_v_update INSTEAD OF UPDATE ON public.profiles_v
  FOR EACH ROW EXECUTE FUNCTION public._profiles_v_update();

CREATE OR REPLACE FUNCTION public._profiles_v_delete()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
BEGIN
  DELETE FROM public.profiles WHERE id = OLD.id;
  RETURN OLD;
END $$;
DROP TRIGGER IF EXISTS profiles_v_delete ON public.profiles_v;
CREATE TRIGGER profiles_v_delete INSTEAD OF DELETE ON public.profiles_v
  FOR EACH ROW EXECUTE FUNCTION public._profiles_v_delete();

-- access_requests_v
CREATE OR REPLACE FUNCTION public._access_requests_v_insert()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
BEGIN
  INSERT INTO public.access_requests (
    id, email, full_name, message, status, decided_at, decided_by, decision_notes
  ) VALUES (
    COALESCE(NEW.id, gen_random_uuid()),
    NEW.email, NEW.full_name, NEW.message,
    COALESCE(NEW.status, 'pending'),
    NEW.decided_at, NEW.decided_by, NEW.decision_notes
  );
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS access_requests_v_insert ON public.access_requests_v;
CREATE TRIGGER access_requests_v_insert INSTEAD OF INSERT ON public.access_requests_v
  FOR EACH ROW EXECUTE FUNCTION public._access_requests_v_insert();

CREATE OR REPLACE FUNCTION public._access_requests_v_update()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
BEGIN
  UPDATE public.access_requests SET
    email = NEW.email,
    full_name = NEW.full_name,
    message = NEW.message,
    status = NEW.status,
    decided_at = NEW.decided_at,
    decided_by = NEW.decided_by,
    decision_notes = NEW.decision_notes
  WHERE id = OLD.id;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS access_requests_v_update ON public.access_requests_v;
CREATE TRIGGER access_requests_v_update INSTEAD OF UPDATE ON public.access_requests_v
  FOR EACH ROW EXECUTE FUNCTION public._access_requests_v_update();

CREATE OR REPLACE FUNCTION public._access_requests_v_delete()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
BEGIN
  DELETE FROM public.access_requests WHERE id = OLD.id;
  RETURN OLD;
END $$;
DROP TRIGGER IF EXISTS access_requests_v_delete ON public.access_requests_v;
CREATE TRIGGER access_requests_v_delete INSTEAD OF DELETE ON public.access_requests_v
  FOR EACH ROW EXECUTE FUNCTION public._access_requests_v_delete();

-- leave_requests_v
CREATE OR REPLACE FUNCTION public._leave_requests_v_insert()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
BEGIN
  INSERT INTO public.leave_requests (
    id, staff_id, type, start_date, end_date, half_day_start, half_day_end,
    reason, status, decided_by, decided_at, decision_notes, conflict_notes,
    reserve_listed_at, clwrota_external_id
  ) VALUES (
    COALESCE(NEW.id, gen_random_uuid()),
    NEW.staff_id, NEW.type, NEW.start_date, NEW.end_date,
    NEW.half_day_start, NEW.half_day_end,
    NEW.reason, COALESCE(NEW.status, 'pending'),
    NEW.decided_by, NEW.decided_at, NEW.decision_notes, NEW.conflict_notes,
    NEW.reserve_listed_at, NEW.clwrota_external_id
  );
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS leave_requests_v_insert ON public.leave_requests_v;
CREATE TRIGGER leave_requests_v_insert INSTEAD OF INSERT ON public.leave_requests_v
  FOR EACH ROW EXECUTE FUNCTION public._leave_requests_v_insert();

CREATE OR REPLACE FUNCTION public._leave_requests_v_update()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
BEGIN
  UPDATE public.leave_requests SET
    staff_id = NEW.staff_id,
    type = NEW.type,
    start_date = NEW.start_date,
    end_date = NEW.end_date,
    half_day_start = NEW.half_day_start,
    half_day_end = NEW.half_day_end,
    reason = NEW.reason,
    status = NEW.status,
    decided_by = NEW.decided_by,
    decided_at = NEW.decided_at,
    decision_notes = NEW.decision_notes,
    conflict_notes = NEW.conflict_notes,
    reserve_listed_at = NEW.reserve_listed_at,
    clwrota_external_id = NEW.clwrota_external_id,
    updated_at = now()
  WHERE id = OLD.id;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS leave_requests_v_update ON public.leave_requests_v;
CREATE TRIGGER leave_requests_v_update INSTEAD OF UPDATE ON public.leave_requests_v
  FOR EACH ROW EXECUTE FUNCTION public._leave_requests_v_update();

CREATE OR REPLACE FUNCTION public._leave_requests_v_delete()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
BEGIN
  DELETE FROM public.leave_requests WHERE id = OLD.id;
  RETURN OLD;
END $$;
DROP TRIGGER IF EXISTS leave_requests_v_delete ON public.leave_requests_v;
CREATE TRIGGER leave_requests_v_delete INSTEAD OF DELETE ON public.leave_requests_v
  FOR EACH ROW EXECUTE FUNCTION public._leave_requests_v_delete();

-- ai_messages_v
CREATE OR REPLACE FUNCTION public._ai_messages_v_insert()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
BEGIN
  INSERT INTO public.ai_messages (id, conversation_id, user_id, role, parts)
  VALUES (
    COALESCE(NEW.id, gen_random_uuid()),
    NEW.conversation_id, NEW.user_id, NEW.role, NEW.parts
  );
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS ai_messages_v_insert ON public.ai_messages_v;
CREATE TRIGGER ai_messages_v_insert INSTEAD OF INSERT ON public.ai_messages_v
  FOR EACH ROW EXECUTE FUNCTION public._ai_messages_v_insert();

CREATE OR REPLACE FUNCTION public._ai_messages_v_delete()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
BEGIN
  DELETE FROM public.ai_messages WHERE id = OLD.id;
  RETURN OLD;
END $$;
DROP TRIGGER IF EXISTS ai_messages_v_delete ON public.ai_messages_v;
CREATE TRIGGER ai_messages_v_delete INSTEAD OF DELETE ON public.ai_messages_v
  FOR EACH ROW EXECUTE FUNCTION public._ai_messages_v_delete();

-- INSERT/UPDATE/DELETE grants on the views
GRANT INSERT, UPDATE, DELETE ON public.profiles_v TO authenticated, service_role;
GRANT INSERT, UPDATE, DELETE ON public.access_requests_v TO authenticated, service_role;
GRANT INSERT, UPDATE, DELETE ON public.leave_requests_v TO authenticated, service_role;
GRANT INSERT, DELETE ON public.ai_messages_v TO authenticated, service_role;
