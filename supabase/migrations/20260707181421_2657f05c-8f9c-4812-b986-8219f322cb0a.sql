
ALTER TABLE public.leave_allowances
  ADD COLUMN IF NOT EXISTS study_budget_gbp numeric(8,2) NOT NULL DEFAULT 0;

ALTER TABLE public.leave_requests
  ADD COLUMN IF NOT EXISTS study_cost_gbp numeric(8,2);

COMMENT ON COLUMN public.leave_allowances.study_budget_gbp IS
  'Annual study-leave budget in £ (e.g. HEE trainee allowance, typically £800/year).';
COMMENT ON COLUMN public.leave_requests.study_cost_gbp IS
  'Estimated / claimed £ cost of a study-leave request (course fees, travel, accommodation).';
