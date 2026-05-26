ALTER TABLE public.profiles
ADD COLUMN IF NOT EXISTS ltft_days_off smallint[] NOT NULL DEFAULT '{}'::smallint[];

COMMENT ON COLUMN public.profiles.ltft_days_off IS 'Weekdays (0=Mon..6=Sun) on which an LTFT staff member is contractually off.';