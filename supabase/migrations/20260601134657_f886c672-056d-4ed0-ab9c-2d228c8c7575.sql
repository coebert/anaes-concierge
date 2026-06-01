ALTER TYPE leave_type ADD VALUE IF NOT EXISTS 'professional';
ALTER TABLE public.leave_allowances ADD COLUMN IF NOT EXISTS professional_days numeric NOT NULL DEFAULT 5;