
CREATE OR REPLACE FUNCTION public.get_profiles_decrypted()
RETURNS TABLE(
  id uuid, email text, full_name text, grade public.staff_grade,
  training_level text, gmc_number text, start_date date, active boolean,
  clwrota_external_id text, rotation_end_date date, ltft_days_off text[],
  left_at date, calendar_feed_token text,
  created_at timestamptz, updated_at timestamptz
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT p.id,
    public.decrypt_owner_or_coord(p.email_enc, p.id),
    p.full_name, p.grade, p.training_level,
    public.decrypt_owner_or_coord(p.gmc_number_enc, p.id),
    p.start_date, p.active, p.clwrota_external_id, p.rotation_end_date,
    p.ltft_days_off, p.left_at, p.calendar_feed_token,
    p.created_at, p.updated_at
  FROM public.profiles p
$$;

CREATE OR REPLACE FUNCTION public.get_profile_decrypted(p_id uuid)
RETURNS TABLE(
  id uuid, email text, full_name text, grade public.staff_grade,
  training_level text, gmc_number text, start_date date, active boolean,
  clwrota_external_id text, rotation_end_date date, ltft_days_off text[],
  left_at date, calendar_feed_token text,
  created_at timestamptz, updated_at timestamptz
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT * FROM public.get_profiles_decrypted() WHERE id = p_id
$$;

CREATE OR REPLACE FUNCTION public.get_access_requests_decrypted()
RETURNS TABLE(
  id uuid, email text, full_name text, message text,
  status public.access_request_status,
  decided_at timestamptz, decided_by uuid, decision_notes text,
  created_at timestamptz
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT a.id,
    public.decrypt_coord_only(a.email_enc),
    a.full_name, a.message, a.status,
    a.decided_at, a.decided_by, a.decision_notes, a.created_at
  FROM public.access_requests a
$$;

CREATE OR REPLACE FUNCTION public.get_leave_requests_decrypted()
RETURNS TABLE(
  id uuid, staff_id uuid, type public.leave_type,
  start_date date, end_date date,
  half_day_start public.session_half, half_day_end public.session_half,
  reason text, status public.leave_status,
  decided_by uuid, decided_at timestamptz,
  decision_notes text, conflict_notes text,
  reserve_listed_at timestamptz, clwrota_external_id text,
  created_at timestamptz, updated_at timestamptz
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT l.id, l.staff_id, l.type, l.start_date, l.end_date,
    l.half_day_start, l.half_day_end,
    public.decrypt_owner_or_coord(l.reason_enc, l.staff_id),
    l.status, l.decided_by, l.decided_at,
    public.decrypt_coord_only(l.decision_notes_enc),
    public.decrypt_coord_only(l.conflict_notes_enc),
    l.reserve_listed_at, l.clwrota_external_id,
    l.created_at, l.updated_at
  FROM public.leave_requests l
$$;

CREATE OR REPLACE FUNCTION public.get_ai_messages_decrypted(p_conversation_id uuid)
RETURNS TABLE(
  id uuid, conversation_id uuid, user_id uuid,
  role public.chat_role, parts jsonb, created_at timestamptz
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT m.id, m.conversation_id, m.user_id, m.role,
    public.decrypt_ai_message_parts(m.parts_enc, m.conversation_id),
    m.created_at
  FROM public.ai_messages m
  WHERE m.conversation_id = p_conversation_id
  ORDER BY m.created_at ASC
$$;

GRANT EXECUTE ON FUNCTION public.get_profiles_decrypted()        TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_profile_decrypted(uuid)     TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_access_requests_decrypted() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_leave_requests_decrypted()  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_ai_messages_decrypted(uuid) TO authenticated, service_role;
