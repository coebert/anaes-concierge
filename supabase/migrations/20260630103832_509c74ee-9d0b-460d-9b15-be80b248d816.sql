
CREATE OR REPLACE FUNCTION public.decrypt_owner_or_coord(p_cipher bytea, p_owner uuid)
RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_cipher IS NULL THEN RETURN NULL; END IF;
  IF current_user = 'service_role'
     OR pg_has_role(current_user, 'service_role', 'MEMBER')
     OR auth.uid() = p_owner
     OR public.current_user_is_coordinator_or_admin() THEN
    RETURN public.decrypt_text(p_cipher);
  END IF;
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION public.decrypt_coord_only(p_cipher bytea)
RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_cipher IS NULL THEN RETURN NULL; END IF;
  IF current_user = 'service_role'
     OR pg_has_role(current_user, 'service_role', 'MEMBER')
     OR public.current_user_is_coordinator_or_admin() THEN
    RETURN public.decrypt_text(p_cipher);
  END IF;
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION public.decrypt_ai_message_parts(p_cipher bytea, p_conversation_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_owner uuid;
BEGIN
  IF p_cipher IS NULL THEN RETURN NULL; END IF;
  IF current_user = 'service_role'
     OR pg_has_role(current_user, 'service_role', 'MEMBER') THEN
    RETURN public.decrypt_jsonb(p_cipher);
  END IF;
  SELECT user_id INTO v_owner FROM public.ai_conversations WHERE id = p_conversation_id;
  IF auth.uid() = v_owner OR public.current_user_is_coordinator_or_admin() THEN
    RETURN public.decrypt_jsonb(p_cipher);
  END IF;
  RETURN NULL;
END $$;
