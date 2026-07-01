
REVOKE EXECUTE ON FUNCTION public.get_access_requests_decrypted() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.get_leave_requests_decrypted() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.get_profiles_decrypted() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.get_profile_decrypted(uuid) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.get_access_requests_decrypted() TO service_role;
GRANT EXECUTE ON FUNCTION public.get_leave_requests_decrypted() TO service_role;
GRANT EXECUTE ON FUNCTION public.get_profiles_decrypted() TO service_role;
GRANT EXECUTE ON FUNCTION public.get_profile_decrypted(uuid) TO service_role;
