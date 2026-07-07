
-- 1. pulse_survey_cycles
CREATE TABLE public.pulse_survey_cycles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  opens_at date NOT NULL,
  closes_at date NOT NULL,
  question_1 text NOT NULL,
  question_2 text NOT NULL,
  question_3 text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES public.profiles(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.pulse_survey_cycles TO authenticated;
GRANT ALL ON public.pulse_survey_cycles TO service_role;
ALTER TABLE public.pulse_survey_cycles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone signed-in reads cycles"
  ON public.pulse_survey_cycles FOR SELECT TO authenticated USING (true);

CREATE POLICY "Admins manage cycles"
  ON public.pulse_survey_cycles FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

CREATE TRIGGER pulse_cycles_updated_at
  BEFORE UPDATE ON public.pulse_survey_cycles
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- 2. pulse_survey_responses
CREATE TABLE public.pulse_survey_responses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cycle_id uuid NOT NULL REFERENCES public.pulse_survey_cycles(id) ON DELETE CASCADE,
  staff_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  score_1 smallint NOT NULL CHECK (score_1 BETWEEN 1 AND 5),
  score_2 smallint NOT NULL CHECK (score_2 BETWEEN 1 AND 5),
  score_3 smallint NOT NULL CHECK (score_3 BETWEEN 1 AND 5),
  comment text,
  comment_enc bytea,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (cycle_id, staff_id)
);
CREATE INDEX pulse_responses_cycle_idx ON public.pulse_survey_responses (cycle_id);

GRANT SELECT, INSERT, UPDATE ON public.pulse_survey_responses TO authenticated;
GRANT ALL ON public.pulse_survey_responses TO service_role;
ALTER TABLE public.pulse_survey_responses ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff read own pulse response"
  ON public.pulse_survey_responses FOR SELECT TO authenticated
  USING (auth.uid() = staff_id OR public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Staff insert own pulse response"
  ON public.pulse_survey_responses FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = staff_id);

CREATE POLICY "Staff update own pulse response"
  ON public.pulse_survey_responses FOR UPDATE TO authenticated
  USING (auth.uid() = staff_id)
  WITH CHECK (auth.uid() = staff_id);

CREATE OR REPLACE FUNCTION public._sync_pulse_response_encryption()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.comment IS DISTINCT FROM OLD.comment THEN
    NEW.comment_enc := public.encrypt_text(NEW.comment);
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER pulse_responses_encrypt
  BEFORE INSERT OR UPDATE ON public.pulse_survey_responses
  FOR EACH ROW EXECUTE FUNCTION public._sync_pulse_response_encryption();

CREATE TRIGGER pulse_responses_updated_at
  BEFORE UPDATE ON public.pulse_survey_responses
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- 3. recognition_entries
CREATE TABLE public.recognition_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  from_user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  category text NOT NULL CHECK (category IN
    ('teaching','kindness','clinical','above_beyond','covering_gap','other')),
  message text,
  message_enc bytea,
  is_public boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX recognition_staff_idx ON public.recognition_entries (staff_id, created_at DESC);
CREATE INDEX recognition_public_idx ON public.recognition_entries (is_public, created_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.recognition_entries TO authenticated;
GRANT ALL ON public.recognition_entries TO service_role;
ALTER TABLE public.recognition_entries ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Read recognition (self, sender, public, admin)"
  ON public.recognition_entries FOR SELECT TO authenticated
  USING (
    auth.uid() = staff_id
    OR auth.uid() = from_user_id
    OR is_public = true
    OR public.has_role(auth.uid(), 'admin')
  );

CREATE POLICY "Send recognition"
  ON public.recognition_entries FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = from_user_id);

CREATE POLICY "Sender updates own recognition"
  ON public.recognition_entries FOR UPDATE TO authenticated
  USING (auth.uid() = from_user_id)
  WITH CHECK (auth.uid() = from_user_id);

CREATE POLICY "Sender or admin deletes recognition"
  ON public.recognition_entries FOR DELETE TO authenticated
  USING (auth.uid() = from_user_id OR public.has_role(auth.uid(), 'admin'));

CREATE OR REPLACE FUNCTION public._sync_recognition_encryption()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.message IS DISTINCT FROM OLD.message THEN
    NEW.message_enc := public.encrypt_text(NEW.message);
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER recognition_encrypt
  BEFORE INSERT OR UPDATE ON public.recognition_entries
  FOR EACH ROW EXECUTE FUNCTION public._sync_recognition_encryption();

CREATE TRIGGER recognition_updated_at
  BEFORE UPDATE ON public.recognition_entries
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- 4. Decrypted RPCs
CREATE OR REPLACE FUNCTION public.get_pulse_responses_decrypted(p_cycle_id uuid DEFAULT NULL)
RETURNS TABLE(
  id uuid, cycle_id uuid, staff_id uuid,
  score_1 smallint, score_2 smallint, score_3 smallint,
  comment text, created_at timestamptz
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_rows int;
BEGIN
  RETURN QUERY
  SELECT r.id, r.cycle_id, r.staff_id,
    r.score_1, r.score_2, r.score_3,
    public.decrypt_owner_or_coord(r.comment_enc, r.staff_id),
    r.created_at
  FROM public.pulse_survey_responses r
  WHERE (p_cycle_id IS NULL OR r.cycle_id = p_cycle_id)
    AND (auth.uid() = r.staff_id OR public.has_role(auth.uid(), 'admin'));
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  PERFORM public.log_rpc_access('get_pulse_responses_decrypted', v_rows,
    jsonb_build_object('cycle_id', p_cycle_id));
END $$;
GRANT EXECUTE ON FUNCTION public.get_pulse_responses_decrypted(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.get_pulse_aggregate(p_cycle_id uuid DEFAULT NULL)
RETURNS TABLE(
  cycle_id uuid, opens_at date, closes_at date,
  response_count bigint,
  avg_score_1 numeric, avg_score_2 numeric, avg_score_3 numeric
)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT c.id, c.opens_at, c.closes_at,
    COUNT(r.id)::bigint,
    ROUND(AVG(r.score_1)::numeric, 2),
    ROUND(AVG(r.score_2)::numeric, 2),
    ROUND(AVG(r.score_3)::numeric, 2)
  FROM public.pulse_survey_cycles c
  LEFT JOIN public.pulse_survey_responses r ON r.cycle_id = c.id
  WHERE (p_cycle_id IS NULL OR c.id = p_cycle_id)
    AND (public.current_user_is_coordinator_or_admin())
  GROUP BY c.id, c.opens_at, c.closes_at
  ORDER BY c.opens_at DESC
$$;
GRANT EXECUTE ON FUNCTION public.get_pulse_aggregate(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.get_recognition_decrypted(p_staff_id uuid DEFAULT NULL, p_limit int DEFAULT 100)
RETURNS TABLE(
  id uuid, staff_id uuid, from_user_id uuid, category text,
  message text, is_public boolean, created_at timestamptz
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_rows int;
BEGIN
  RETURN QUERY
  SELECT e.id, e.staff_id, e.from_user_id, e.category,
    CASE
      WHEN e.is_public
        OR auth.uid() = e.staff_id
        OR auth.uid() = e.from_user_id
        OR public.has_role(auth.uid(), 'admin')
      THEN public.decrypt_text(e.message_enc)
      ELSE NULL
    END,
    e.is_public, e.created_at
  FROM public.recognition_entries e
  WHERE (p_staff_id IS NULL OR e.staff_id = p_staff_id)
    AND (
      e.is_public
      OR auth.uid() = e.staff_id
      OR auth.uid() = e.from_user_id
      OR public.has_role(auth.uid(), 'admin')
    )
  ORDER BY e.created_at DESC
  LIMIT LEAST(GREATEST(p_limit, 1), 500);
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  PERFORM public.log_rpc_access('get_recognition_decrypted', v_rows,
    jsonb_build_object('staff_id', p_staff_id, 'limit', p_limit));
END $$;
GRANT EXECUTE ON FUNCTION public.get_recognition_decrypted(uuid, int) TO authenticated;
