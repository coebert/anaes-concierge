
CREATE TABLE public.inbox_dismissals (
  item_id text PRIMARY KEY,
  kind text NOT NULL,
  dismissed_by uuid NOT NULL,
  dismissed_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.inbox_dismissals TO authenticated;
GRANT ALL ON public.inbox_dismissals TO service_role;

ALTER TABLE public.inbox_dismissals ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Coordinators can view dismissals"
  ON public.inbox_dismissals FOR SELECT TO authenticated
  USING (public.current_user_is_coordinator_or_admin());

CREATE POLICY "Coordinators can insert dismissals"
  ON public.inbox_dismissals FOR INSERT TO authenticated
  WITH CHECK (public.current_user_is_coordinator_or_admin() AND dismissed_by = auth.uid());

CREATE POLICY "Coordinators can delete dismissals"
  ON public.inbox_dismissals FOR DELETE TO authenticated
  USING (public.current_user_is_coordinator_or_admin());
