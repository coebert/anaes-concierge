ALTER TABLE public.clwrota_sync_state
ADD COLUMN IF NOT EXISTS auto_reclassify_trainee_solo boolean NOT NULL DEFAULT false;