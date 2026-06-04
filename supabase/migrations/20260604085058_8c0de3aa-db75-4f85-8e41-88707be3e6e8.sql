ALTER TABLE public.clwrota_sync_metrics
  ADD COLUMN IF NOT EXISTS rows_deleted integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS non_working_cleaned integer NOT NULL DEFAULT 0;