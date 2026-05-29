ALTER TABLE public.clwrota_sync_state
  ADD COLUMN IF NOT EXISTS sync_days_back integer NOT NULL DEFAULT 30,
  ADD COLUMN IF NOT EXISTS sync_days_ahead integer NOT NULL DEFAULT 120;

ALTER TABLE public.clwrota_sync_state
  ADD CONSTRAINT clwrota_sync_days_back_range CHECK (sync_days_back BETWEEN 0 AND 3650),
  ADD CONSTRAINT clwrota_sync_days_ahead_range CHECK (sync_days_ahead BETWEEN 1 AND 3650);