ALTER TABLE public.clwrota_sync_metrics ADD COLUMN IF NOT EXISTS is_backfill boolean NOT NULL DEFAULT false;
UPDATE public.clwrota_sync_metrics SET is_backfill = true WHERE notes LIKE '[BACKFILL%';
CREATE INDEX IF NOT EXISTS clwrota_sync_metrics_is_backfill_idx ON public.clwrota_sync_metrics(is_backfill);