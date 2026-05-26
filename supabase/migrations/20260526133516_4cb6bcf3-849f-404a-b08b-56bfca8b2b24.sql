
CREATE TYPE public.custom_rule_scope AS ENUM ('staff', 'grade', 'department');

CREATE TABLE public.custom_rota_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope public.custom_rule_scope NOT NULL DEFAULT 'staff',
  staff_id uuid,
  grade text,
  rule_text text NOT NULL,
  summary text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_custom_rota_rules_staff ON public.custom_rota_rules(staff_id) WHERE staff_id IS NOT NULL;
CREATE INDEX idx_custom_rota_rules_active ON public.custom_rota_rules(active);

GRANT SELECT ON public.custom_rota_rules TO authenticated;
GRANT INSERT, UPDATE, DELETE ON public.custom_rota_rules TO authenticated;
GRANT ALL ON public.custom_rota_rules TO service_role;

ALTER TABLE public.custom_rota_rules ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated read custom rules"
  ON public.custom_rota_rules FOR SELECT
  TO authenticated USING (true);

CREATE POLICY "Admins manage custom rules"
  ON public.custom_rota_rules FOR ALL
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

CREATE TRIGGER set_custom_rota_rules_updated_at
  BEFORE UPDATE ON public.custom_rota_rules
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
