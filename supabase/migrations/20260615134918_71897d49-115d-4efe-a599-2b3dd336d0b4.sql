ALTER TABLE public.clwrota_sync_state
  ADD COLUMN IF NOT EXISTS last_successful_rota_sync_at timestamptz,
  ADD COLUMN IF NOT EXISTS incremental_days_back integer NOT NULL DEFAULT 3,
  ADD COLUMN IF NOT EXISTS incremental_days_ahead integer NOT NULL DEFAULT 14;

ALTER TABLE public.clwrota_sync_state
  ADD CONSTRAINT clwrota_incremental_days_back_range
    CHECK (incremental_days_back >= 0 AND incremental_days_back <= 365),
  ADD CONSTRAINT clwrota_incremental_days_ahead_range
    CHECK (incremental_days_ahead >= 1 AND incremental_days_ahead <= 365);