
-- Views: keep base RLS via security_invoker, return original column names so app code only needs to swap the table name.

CREATE OR REPLACE VIEW public.profiles_v WITH (security_invoker = true) AS
SELECT
  id,
  public.decrypt_owner_or_coord(email_enc, id)         AS email,
  full_name,
  grade,
  training_level,
  public.decrypt_owner_or_coord(gmc_number_enc, id)    AS gmc_number,
  start_date,
  active,
  clwrota_external_id,
  created_at,
  updated_at,
  rotation_end_date,
  ltft_days_off,
  left_at,
  calendar_feed_token,
  email_hash
FROM public.profiles;
GRANT SELECT ON public.profiles_v TO authenticated, service_role;

CREATE OR REPLACE VIEW public.access_requests_v WITH (security_invoker = true) AS
SELECT
  id,
  -- access_requests has no row "owner" relevant before account exists; coord-only is correct.
  public.decrypt_coord_only(email_enc) AS email,
  full_name,
  message,
  status,
  created_at,
  decided_at,
  decided_by,
  decision_notes,
  email_hash
FROM public.access_requests;
GRANT SELECT ON public.access_requests_v TO authenticated, service_role;

CREATE OR REPLACE VIEW public.leave_requests_v WITH (security_invoker = true) AS
SELECT
  id,
  staff_id,
  type,
  start_date,
  end_date,
  half_day_start,
  half_day_end,
  -- Reason: owner OR coordinator (owner of the leave should see their own reason)
  public.decrypt_owner_or_coord(reason_enc, staff_id)            AS reason,
  status,
  decided_by,
  decided_at,
  -- Decision notes / conflict notes: coordinator-only
  public.decrypt_coord_only(decision_notes_enc)                  AS decision_notes,
  public.decrypt_coord_only(conflict_notes_enc)                  AS conflict_notes,
  created_at,
  updated_at,
  reserve_listed_at,
  clwrota_external_id
FROM public.leave_requests;
GRANT SELECT ON public.leave_requests_v TO authenticated, service_role;

CREATE OR REPLACE VIEW public.ai_messages_v WITH (security_invoker = true) AS
SELECT
  id,
  conversation_id,
  user_id,
  role,
  public.decrypt_ai_message_parts(parts_enc, conversation_id) AS parts,
  created_at
FROM public.ai_messages;
GRANT SELECT ON public.ai_messages_v TO authenticated, service_role;

-- Email-hash lookup helpers (SECURITY DEFINER; safe — return only id/status, not decrypted email).

CREATE OR REPLACE FUNCTION public.find_profile_id_by_email(p_email text)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT id FROM public.profiles
   WHERE email_hash = public.hmac_text(p_email)
   LIMIT 1
$$;
GRANT EXECUTE ON FUNCTION public.find_profile_id_by_email(text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.find_access_request_by_email(p_email text)
RETURNS TABLE(id uuid, status text, full_name text, created_at timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT id, status::text, full_name, created_at
    FROM public.access_requests
   WHERE email_hash = public.hmac_text(p_email)
   ORDER BY created_at DESC
$$;
GRANT EXECUTE ON FUNCTION public.find_access_request_by_email(text) TO authenticated, service_role;

-- Admin decrypt helpers (service_role only). These bypass the role check because
-- service_role is already a privileged trust boundary (used in webhooks and admin
-- server functions that have verified the caller).

CREATE OR REPLACE FUNCTION public.admin_decrypt_text(p_cipher bytea)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF current_user <> 'service_role'
     AND NOT pg_has_role(current_user, 'service_role', 'MEMBER') THEN
    RAISE EXCEPTION 'admin_decrypt_text requires service_role' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN public.decrypt_text(p_cipher);
END $$;
REVOKE ALL ON FUNCTION public.admin_decrypt_text(bytea) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_decrypt_text(bytea) TO service_role;

CREATE OR REPLACE FUNCTION public.admin_decrypt_jsonb(p_cipher bytea)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF current_user <> 'service_role'
     AND NOT pg_has_role(current_user, 'service_role', 'MEMBER') THEN
    RAISE EXCEPTION 'admin_decrypt_jsonb requires service_role' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN public.decrypt_jsonb(p_cipher);
END $$;
REVOKE ALL ON FUNCTION public.admin_decrypt_jsonb(bytea) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_decrypt_jsonb(bytea) TO service_role;

-- Admin-only views (service_role) for backend reads that need plaintext during
-- webhook syncs, notification dispatch, invites, etc. Bypass access checks but
-- only callable via service_role (REVOKE from anon/authenticated).

CREATE OR REPLACE VIEW public.profiles_admin_v WITH (security_invoker = true) AS
SELECT
  p.id, public.admin_decrypt_text(p.email_enc) AS email,
  p.full_name, p.grade, p.training_level,
  public.admin_decrypt_text(p.gmc_number_enc) AS gmc_number,
  p.start_date, p.active, p.clwrota_external_id, p.created_at, p.updated_at,
  p.rotation_end_date, p.ltft_days_off, p.left_at, p.calendar_feed_token, p.email_hash
FROM public.profiles p;
REVOKE ALL ON public.profiles_admin_v FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.profiles_admin_v TO service_role;

CREATE OR REPLACE VIEW public.access_requests_admin_v WITH (security_invoker = true) AS
SELECT
  id, public.admin_decrypt_text(email_enc) AS email,
  full_name, message, status, created_at, decided_at, decided_by, decision_notes, email_hash
FROM public.access_requests;
REVOKE ALL ON public.access_requests_admin_v FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.access_requests_admin_v TO service_role;

CREATE OR REPLACE VIEW public.leave_requests_admin_v WITH (security_invoker = true) AS
SELECT
  id, staff_id, type, start_date, end_date, half_day_start, half_day_end,
  public.admin_decrypt_text(reason_enc) AS reason,
  status, decided_by, decided_at,
  public.admin_decrypt_text(decision_notes_enc) AS decision_notes,
  public.admin_decrypt_text(conflict_notes_enc) AS conflict_notes,
  created_at, updated_at, reserve_listed_at, clwrota_external_id
FROM public.leave_requests;
REVOKE ALL ON public.leave_requests_admin_v FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.leave_requests_admin_v TO service_role;

CREATE OR REPLACE VIEW public.ai_messages_admin_v WITH (security_invoker = true) AS
SELECT
  id, conversation_id, user_id, role,
  public.admin_decrypt_jsonb(parts_enc) AS parts,
  created_at
FROM public.ai_messages;
REVOKE ALL ON public.ai_messages_admin_v FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.ai_messages_admin_v TO service_role;

-- Update handle_new_user to look up by email_hash instead of plaintext email.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
declare
  v_existing_id uuid;
  v_pre_approved boolean := false;
  v_email_hash bytea;
begin
  v_email_hash := public.hmac_text(new.email);
  select id into v_existing_id from public.profiles where email_hash = v_email_hash limit 1;

  if v_existing_id is not null and v_existing_id <> new.id then
    update public.rota_assignments set staff_id = new.id where staff_id = v_existing_id;
    update public.rota_assignments set supervisor_id = new.id where supervisor_id = v_existing_id;
    update public.fixed_sessions set staff_id = new.id where staff_id = v_existing_id;
    update public.leave_requests set staff_id = new.id where staff_id = v_existing_id;
    update public.leave_allowances set staff_id = new.id where staff_id = v_existing_id;
    update public.job_plans set staff_id = new.id where staff_id = v_existing_id;

    update public.profiles
      set id = new.id,
          full_name = coalesce(nullif(full_name,''), new.raw_user_meta_data->>'full_name', ''),
          updated_at = now()
      where id = v_existing_id;

    v_pre_approved := true;
  elsif v_existing_id is null then
    select exists (
      select 1 from public.access_requests
      where email_hash = v_email_hash and status = 'approved'
    ) into v_pre_approved;

    if v_pre_approved then
      insert into public.profiles (id, email, full_name)
      values (new.id, new.email, coalesce(new.raw_user_meta_data->>'full_name', ''));
    end if;
  else
    v_pre_approved := true;
  end if;

  if v_pre_approved then
    insert into public.user_roles (user_id, role)
    values (new.id, 'staff')
    on conflict do nothing;
  end if;

  return new;
end;
$$;
