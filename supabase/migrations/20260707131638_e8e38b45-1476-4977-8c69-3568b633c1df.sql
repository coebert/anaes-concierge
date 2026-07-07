-- Revoke public EXECUTE on the log_leave_request_change trigger function so it
-- is no longer callable directly by anon/authenticated clients. It runs
-- automatically as a trigger under SECURITY DEFINER; no application code needs
-- to invoke it. Triggers fire regardless of EXECUTE grants on the function.
REVOKE EXECUTE ON FUNCTION public.log_leave_request_change() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.log_leave_request_change() FROM anon;
REVOKE EXECUTE ON FUNCTION public.log_leave_request_change() FROM authenticated;