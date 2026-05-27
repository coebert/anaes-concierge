ALTER TABLE public.rota_rules
ADD COLUMN IF NOT EXISTS trainee_at_risk_pct integer NOT NULL DEFAULT 50,
ADD COLUMN IF NOT EXISTS trainee_behind_pct integer NOT NULL DEFAULT 75;