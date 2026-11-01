-- 0006: active-membership gate for role checks + durable chat stream leases.

-- 1) A role only counts while its holder is an ACTIVE member: profile exists,
--    active = true, left_at IS NULL. SECURITY DEFINER so RLS on profiles
--    (which itself calls these helpers) never recurses.
CREATE OR REPLACE FUNCTION public._is_active_member_profile(_user_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT _user_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.id = _user_id AND p.active IS TRUE AND p.left_at IS NULL
  )
$$;
REVOKE EXECUTE ON FUNCTION public._is_active_member_profile(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._is_active_member_profile(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role app_role)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role)
     AND public._is_active_member_profile(_user_id)
$$;

CREATE OR REPLACE FUNCTION public.current_user_is_coordinator_or_admin()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = auth.uid() AND role IN ('admin', 'rota_coordinator')
  ) AND public._is_active_member_profile(auth.uid())
$$;

CREATE OR REPLACE FUNCTION public.is_app_member(_user_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public AS $$
  SELECT _user_id IS NOT NULL AND _user_id = auth.uid()
     AND EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id)
     -- INVOKER: reads the caller's own profile through the existing
     -- "staff read own" RLS policy (no recursion; no extra grant needed).
     AND EXISTS (SELECT 1 FROM public.profiles p
                 WHERE p.id = _user_id AND p.active IS TRUE AND p.left_at IS NULL)
$$;

-- 2) Durable per-user concurrency leases for /api/chat streams.
CREATE TABLE public.chat_stream_leases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX chat_stream_leases_user_idx ON public.chat_stream_leases (user_id, expires_at);
GRANT ALL ON public.chat_stream_leases TO service_role;
ALTER TABLE public.chat_stream_leases ENABLE ROW LEVEL SECURITY;
-- No policies: only the service-role server path and the definer RPCs touch it.

-- Atomically: lock this user's lease set, reap expired leases (crash
-- recovery), refuse when at the cap, otherwise insert and return lease id.
-- Returns NULL when the cap is reached. Inputs are bounded.
CREATE OR REPLACE FUNCTION public.acquire_chat_stream_lease(p_user_id uuid, p_max integer, p_ttl_seconds integer)
RETURNS uuid LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_active integer; v_id uuid;
BEGIN
  IF p_user_id IS NULL THEN RAISE EXCEPTION 'user required'; END IF;
  IF p_max IS NULL OR p_max < 1 OR p_max > 10 THEN RAISE EXCEPTION 'p_max out of range'; END IF;
  IF p_ttl_seconds IS NULL OR p_ttl_seconds < 30 OR p_ttl_seconds > 3600 THEN
    RAISE EXCEPTION 'p_ttl_seconds out of range';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('chat_stream_lease:' || p_user_id::text, 0));
  DELETE FROM public.chat_stream_leases WHERE user_id = p_user_id AND expires_at <= now();
  SELECT count(*) INTO v_active FROM public.chat_stream_leases WHERE user_id = p_user_id;
  IF v_active >= p_max THEN RETURN NULL; END IF;
  INSERT INTO public.chat_stream_leases (user_id, expires_at)
  VALUES (p_user_id, now() + make_interval(secs => p_ttl_seconds))
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION public.release_chat_stream_lease(p_lease_id uuid)
RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_n integer;
BEGIN
  DELETE FROM public.chat_stream_leases WHERE id = p_lease_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n > 0;
END $$;

REVOKE EXECUTE ON FUNCTION public.acquire_chat_stream_lease(uuid, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.release_chat_stream_lease(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.acquire_chat_stream_lease(uuid, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_chat_stream_lease(uuid) TO service_role;
