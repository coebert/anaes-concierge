
-- Trigger functions: no direct EXECUTE needed by any client role.
REVOKE EXECUTE ON FUNCTION public._sync_profiles_encryption() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public._sync_leave_requests_encryption() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public._sync_ai_messages_encryption() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public._sync_access_requests_encryption() FROM PUBLIC, anon, authenticated;

-- Internal decryption / crypto helpers: only service_role and callers
-- reached via other SECURITY DEFINER RPCs should execute these.
REVOKE EXECUTE ON FUNCTION public.decrypt_owner_or_coord(bytea, uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.decrypt_coord_only(bytea) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.decrypt_ai_message_parts(bytea, uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.hmac_text(text) FROM PUBLIC, anon, authenticated;

-- Email-based lookup helpers: not called directly from client code.
REVOKE EXECUTE ON FUNCTION public.find_profile_id_by_email(text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.find_access_request_by_email(text) FROM PUBLIC, anon, authenticated;

-- Anomaly detector: block anon; keep authenticated (admin check is enforced inside).
REVOKE EXECUTE ON FUNCTION public.detect_rpc_access_anomalies(integer, integer) FROM PUBLIC, anon;
