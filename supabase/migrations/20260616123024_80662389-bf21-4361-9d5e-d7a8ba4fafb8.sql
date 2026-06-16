
REVOKE EXECUTE ON FUNCTION public.trigger_clwrota_sync_rate_limited(text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.trigger_clwrota_sync_all_rate_limited() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.trigger_clwrota_sync(text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.trigger_clwrota_sync_with_query(text, text) FROM PUBLIC, anon, authenticated;
