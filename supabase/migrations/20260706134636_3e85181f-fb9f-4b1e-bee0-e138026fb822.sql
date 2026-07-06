CREATE OR REPLACE FUNCTION public.consume_passkey_challenge(p_user_id uuid, p_purpose text)
RETURNS TABLE(challenge text)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  DELETE FROM public.passkey_challenges
   WHERE id = (
     SELECT id FROM public.passkey_challenges
      WHERE user_id = p_user_id
        AND purpose = p_purpose
        AND expires_at > now()
      ORDER BY created_at DESC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
   )
   RETURNING challenge;
$$;

-- Only the server-side admin client (service_role) should invoke this.
REVOKE ALL ON FUNCTION public.consume_passkey_challenge(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.consume_passkey_challenge(uuid, text) FROM anon;
REVOKE ALL ON FUNCTION public.consume_passkey_challenge(uuid, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.consume_passkey_challenge(uuid, text) TO service_role;

COMMENT ON FUNCTION public.consume_passkey_challenge(uuid, text) IS
  'Atomically deletes and returns the most-recent non-expired passkey challenge for (user_id, purpose). Prevents concurrent requests from reusing the same challenge. Invoked only from server-side code via service_role.';
