
-- Lock down SECURITY DEFINER functions: revoke EXECUTE from PUBLIC and anon.
-- Trigger functions never need callable grants; user-facing decrypted RPCs
-- are for signed-in users only.

REVOKE EXECUTE ON FUNCTION public._sync_leave_ledger_encryption() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public._sync_pulse_response_encryption() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public._sync_recognition_encryption() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public._sync_rtw_encryption() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public._sync_leave_ledger_encryption() FROM authenticated;
REVOKE EXECUTE ON FUNCTION public._sync_pulse_response_encryption() FROM authenticated;
REVOKE EXECUTE ON FUNCTION public._sync_recognition_encryption() FROM authenticated;
REVOKE EXECUTE ON FUNCTION public._sync_rtw_encryption() FROM authenticated;

REVOKE EXECUTE ON FUNCTION public.get_competency_eligibility(date) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.get_leave_ledger_decrypted() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.get_pulse_aggregate(uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.get_pulse_responses_decrypted(uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.get_recognition_decrypted(uuid, integer) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.get_rtw_interviews_decrypted() FROM PUBLIC, anon;

-- email_inbound_log: writes must only ever happen via service_role
-- (webhook / edge function). Explicitly revoke client-role write grants
-- so the intent is enforced at the GRANT layer, not just RLS.
REVOKE INSERT, UPDATE, DELETE ON public.email_inbound_log FROM anon, authenticated, PUBLIC;
GRANT ALL ON public.email_inbound_log TO service_role;
