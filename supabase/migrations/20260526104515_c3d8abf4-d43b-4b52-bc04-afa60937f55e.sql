ALTER TABLE public.clwrota_sync_state
  ADD COLUMN IF NOT EXISTS rota_report_url text,
  ADD COLUMN IF NOT EXISTS leave_report_url text,
  ADD COLUMN IF NOT EXISTS staff_report_url text,
  ADD COLUMN IF NOT EXISTS last_pulled_rows integer;

INSERT INTO public.clwrota_sync_state (id) VALUES (1)
  ON CONFLICT (id) DO NOTHING;