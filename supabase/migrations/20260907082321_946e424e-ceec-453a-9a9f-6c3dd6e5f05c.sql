CREATE TABLE IF NOT EXISTS public.daily_digest_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  digest_date date NOT NULL,
  status text NOT NULL DEFAULT 'sent',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (staff_id, digest_date)
);

GRANT SELECT ON public.daily_digest_log TO authenticated;
GRANT ALL ON public.daily_digest_log TO service_role;

ALTER TABLE public.daily_digest_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own digest log"
ON public.daily_digest_log
FOR SELECT
TO authenticated
USING (auth.uid() = staff_id);