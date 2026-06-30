
REVOKE EXECUTE ON FUNCTION public.get_profiles_decrypted()        FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.get_profile_decrypted(uuid)     FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.get_access_requests_decrypted() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.get_leave_requests_decrypted()  FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.get_ai_messages_decrypted(uuid) FROM PUBLIC, anon;
