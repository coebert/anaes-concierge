
ALTER TABLE public.theatre_sessions
  ADD COLUMN IF NOT EXISTS is_non_sag boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS non_sag_override boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS theatre_sessions_is_non_sag_idx
  ON public.theatre_sessions (is_non_sag)
  WHERE is_non_sag = true;
