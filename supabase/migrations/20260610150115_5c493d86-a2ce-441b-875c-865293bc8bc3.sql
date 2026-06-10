ALTER TABLE public.rota_assignments
  ADD COLUMN IF NOT EXISTS is_non_sag boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS rota_assignments_is_non_sag_idx
  ON public.rota_assignments (is_non_sag)
  WHERE is_non_sag = true;