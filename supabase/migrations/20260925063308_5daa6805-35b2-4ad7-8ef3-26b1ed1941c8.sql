ALTER FUNCTION public.is_app_member(uuid) SECURITY INVOKER;
CREATE OR REPLACE FUNCTION public.is_app_member(_user_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public AS $$
  SELECT _user_id IS NOT NULL AND _user_id = auth.uid() AND EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id)
$$;