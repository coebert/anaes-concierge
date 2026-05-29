DROP INDEX IF EXISTS public.leave_requests_clwrota_external_id_key;

ALTER TABLE public.leave_requests
  ADD CONSTRAINT leave_requests_clwrota_external_id_key UNIQUE (clwrota_external_id);