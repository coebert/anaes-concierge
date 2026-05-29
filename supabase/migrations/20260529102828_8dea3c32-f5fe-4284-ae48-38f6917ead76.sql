CREATE UNIQUE INDEX IF NOT EXISTS leave_requests_clwrota_external_id_key
  ON public.leave_requests (clwrota_external_id)
  WHERE clwrota_external_id IS NOT NULL;