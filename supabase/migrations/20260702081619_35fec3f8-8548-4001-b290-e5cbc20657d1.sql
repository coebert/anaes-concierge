
-- get_profiles_decrypted and get_profile_decrypted declared ltft_days_off as
-- text[], but the underlying column is smallint[]. PostgREST raised
-- "structure of query does not match function result type" and returned no
-- rows, so the global calendar could not resolve staff names.
DROP FUNCTION IF EXISTS public.get_profiles_decrypted();
CREATE OR REPLACE FUNCTION public.get_profiles_decrypted()
 RETURNS TABLE(id uuid, email text, full_name text, grade staff_grade, training_level text, gmc_number text, start_date date, active boolean, clwrota_external_id text, rotation_end_date date, ltft_days_off smallint[], left_at date, calendar_feed_token text, created_at timestamp with time zone, updated_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_rows INTEGER;
BEGIN
  RETURN QUERY
  SELECT p.id,
    public.decrypt_owner_or_coord(p.email_enc, p.id),
    p.full_name, p.grade, p.training_level,
    public.decrypt_owner_or_coord(p.gmc_number_enc, p.id),
    p.start_date, p.active, p.clwrota_external_id, p.rotation_end_date,
    p.ltft_days_off, p.left_at, p.calendar_feed_token,
    p.created_at, p.updated_at
  FROM public.profiles p;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  PERFORM public.log_rpc_access('get_profiles_decrypted', v_rows, NULL);
END;
$function$;

-- Keep the tightened ACL (no PUBLIC/anon/authenticated EXECUTE).
REVOKE EXECUTE ON FUNCTION public.get_profiles_decrypted() FROM PUBLIC, anon, authenticated;

DROP FUNCTION IF EXISTS public.get_profile_decrypted(uuid);
CREATE OR REPLACE FUNCTION public.get_profile_decrypted(p_id uuid)
 RETURNS TABLE(id uuid, email text, full_name text, grade staff_grade, training_level text, gmc_number text, start_date date, active boolean, clwrota_external_id text, rotation_end_date date, ltft_days_off smallint[], left_at date, calendar_feed_token text, created_at timestamp with time zone, updated_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_rows INTEGER;
BEGIN
  RETURN QUERY
  SELECT p.id,
    public.decrypt_owner_or_coord(p.email_enc, p.id),
    p.full_name, p.grade, p.training_level,
    public.decrypt_owner_or_coord(p.gmc_number_enc, p.id),
    p.start_date, p.active, p.clwrota_external_id, p.rotation_end_date,
    p.ltft_days_off, p.left_at, p.calendar_feed_token,
    p.created_at, p.updated_at
  FROM public.profiles p
  WHERE p.id = p_id;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  PERFORM public.log_rpc_access(
    'get_profile_decrypted',
    v_rows,
    jsonb_build_object('p_id', p_id)
  );
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.get_profile_decrypted(uuid) FROM PUBLIC, anon, authenticated;
