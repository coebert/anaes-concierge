
CREATE TABLE public.rota_rules (
  id integer PRIMARY KEY DEFAULT 1,
  sessions_per_pa numeric NOT NULL DEFAULT 1,
  default_dcc_pas numeric NOT NULL DEFAULT 7.5,
  default_spa_pas numeric NOT NULL DEFAULT 2.5,
  default_total_pas numeric NOT NULL DEFAULT 10,
  max_sessions_per_week numeric NOT NULL DEFAULT 10,
  max_consecutive_days integer NOT NULL DEFAULT 7,
  min_rest_hours integer NOT NULL DEFAULT 11,
  oncall_pa_credit numeric NOT NULL DEFAULT 1.5,
  weekend_pa_credit numeric NOT NULL DEFAULT 3,
  ltft_round_to numeric NOT NULL DEFAULT 0.5,
  honour_fixed_sessions boolean NOT NULL DEFAULT true,
  allow_back_to_back_oncall boolean NOT NULL DEFAULT false,
  post_nights_off_days integer NOT NULL DEFAULT 2,
  notes text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  CONSTRAINT rota_rules_singleton CHECK (id = 1)
);

ALTER TABLE public.rota_rules ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated read rota rules" ON public.rota_rules
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "Admins manage rota rules" ON public.rota_rules
  FOR ALL TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role));

CREATE TRIGGER rota_rules_updated_at
  BEFORE UPDATE ON public.rota_rules
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

INSERT INTO public.rota_rules (id) VALUES (1) ON CONFLICT DO NOTHING;
