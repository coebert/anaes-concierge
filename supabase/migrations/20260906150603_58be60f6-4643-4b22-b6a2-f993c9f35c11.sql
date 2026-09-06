ALTER TABLE public.rota_assignments ADD COLUMN IF NOT EXISTS pa_credit numeric;
ALTER TABLE public.rota_assignments ADD COLUMN IF NOT EXISTS attending_consultant_ids uuid[] NOT NULL DEFAULT '{}';
COMMENT ON COLUMN public.rota_assignments.pa_credit IS 'PA value recorded by CLWRota for this session; NULL means derive from rota rules.';
COMMENT ON COLUMN public.rota_assignments.attending_consultant_ids IS 'All consultant/SAS profiles attached to this session (e.g. ICU rows naming multiple consultants). Empty means only staff_id.';