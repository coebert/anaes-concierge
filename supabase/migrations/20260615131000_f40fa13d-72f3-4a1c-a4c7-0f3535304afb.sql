CREATE OR REPLACE FUNCTION public.upsert_vault_secret(p_name text, p_secret text, p_description text DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, vault
AS $fn$
DECLARE
  v_id uuid;
BEGIN
  IF p_name IS NULL OR length(p_name) = 0 THEN
    RAISE EXCEPTION 'p_name is required';
  END IF;
  IF p_secret IS NULL OR length(p_secret) = 0 THEN
    RAISE EXCEPTION 'p_secret is required';
  END IF;

  SELECT id INTO v_id FROM vault.secrets WHERE name = p_name LIMIT 1;

  IF v_id IS NULL THEN
    v_id := vault.create_secret(p_secret, p_name, p_description);
  ELSE
    PERFORM vault.update_secret(v_id, p_secret, p_name, p_description);
  END IF;

  RETURN v_id;
END;
$fn$;

REVOKE ALL ON FUNCTION public.upsert_vault_secret(text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.upsert_vault_secret(text, text, text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_vault_secret(text, text, text) TO service_role;