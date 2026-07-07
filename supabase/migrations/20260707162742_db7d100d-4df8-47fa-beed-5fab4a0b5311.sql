
CREATE TABLE public.exception_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trainee_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  event_date date NOT NULL,
  event_session public.session_half,
  category text NOT NULL CHECK (category IN (
    'hours', 'rest', 'education', 'service_support', 'patient_safety'
  )),
  immediate_safety_concern boolean NOT NULL DEFAULT false,
  description text NOT NULL CHECK (length(description) BETWEEN 10 AND 5000),
  hours_worked_extra numeric(4,1) CHECK (hours_worked_extra IS NULL OR (hours_worked_extra >= 0 AND hours_worked_extra <= 24)),
  rest_missed_hours numeric(4,1) CHECK (rest_missed_hours IS NULL OR (rest_missed_hours >= 0 AND rest_missed_hours <= 24)),
  status text NOT NULL DEFAULT 'submitted' CHECK (status IN (
    'submitted', 'acknowledged', 'under_review', 'resolved', 'escalated', 'withdrawn'
  )),
  outcome text CHECK (outcome IS NULL OR outcome IN (
    'no_action', 'toil', 'payment', 'work_schedule_review', 'immediate_safety_action', 'other'
  )),
  outcome_note text,
  responder_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  acknowledged_at timestamptz,
  resolved_at timestamptz,
  due_by timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX exception_reports_trainee_idx ON public.exception_reports (trainee_id, event_date DESC);
CREATE INDEX exception_reports_status_idx ON public.exception_reports (status, due_by);
CREATE INDEX exception_reports_open_safety_idx ON public.exception_reports (immediate_safety_concern, status)
  WHERE immediate_safety_concern = true AND status NOT IN ('resolved', 'withdrawn');

GRANT SELECT, INSERT, UPDATE, DELETE ON public.exception_reports TO authenticated;
GRANT ALL ON public.exception_reports TO service_role;

ALTER TABLE public.exception_reports ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Trainees can read own exceptions"
  ON public.exception_reports FOR SELECT TO authenticated
  USING (trainee_id = auth.uid());

CREATE POLICY "Trainees can insert own exceptions"
  ON public.exception_reports FOR INSERT TO authenticated
  WITH CHECK (trainee_id = auth.uid());

CREATE POLICY "Trainees can withdraw own submitted exceptions"
  ON public.exception_reports FOR UPDATE TO authenticated
  USING (trainee_id = auth.uid() AND status = 'submitted')
  WITH CHECK (trainee_id = auth.uid() AND status IN ('submitted', 'withdrawn'));

CREATE POLICY "Admins can read all exceptions"
  ON public.exception_reports FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Admins can update any exception"
  ON public.exception_reports FOR UPDATE TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Coordinators can read exceptions"
  ON public.exception_reports FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'rota_coordinator'));

CREATE OR REPLACE FUNCTION public.set_exception_reports_updated_at()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END; $$;

CREATE TRIGGER exception_reports_updated_at
  BEFORE UPDATE ON public.exception_reports
  FOR EACH ROW EXECUTE FUNCTION public.set_exception_reports_updated_at();

CREATE TABLE public.exception_report_comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id uuid NOT NULL REFERENCES public.exception_reports(id) ON DELETE CASCADE,
  author_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 5000),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX exception_report_comments_report_idx
  ON public.exception_report_comments (report_id, created_at);

GRANT SELECT, INSERT, DELETE ON public.exception_report_comments TO authenticated;
GRANT ALL ON public.exception_report_comments TO service_role;

ALTER TABLE public.exception_report_comments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Read comments if you can read the report"
  ON public.exception_report_comments FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.exception_reports r
    WHERE r.id = report_id
      AND (
        r.trainee_id = auth.uid()
        OR public.has_role(auth.uid(), 'admin')
        OR public.has_role(auth.uid(), 'rota_coordinator')
      )
  ));

CREATE POLICY "Insert own comment on visible report"
  ON public.exception_report_comments FOR INSERT TO authenticated
  WITH CHECK (
    author_id = auth.uid()
    AND EXISTS (
      SELECT 1 FROM public.exception_reports r
      WHERE r.id = report_id
        AND (
          r.trainee_id = auth.uid()
          OR public.has_role(auth.uid(), 'admin')
        )
    )
  );

CREATE POLICY "Delete own comment"
  ON public.exception_report_comments FOR DELETE TO authenticated
  USING (author_id = auth.uid());
