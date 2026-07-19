-- Add medical_examiner as a recognised duty type so CLWRota rows tagged as
-- medical examiner sessions are classified, stored on rota_assignments, and
-- surfaced on the global calendar / "staff in work" panels.
ALTER TYPE public.duty_type ADD VALUE IF NOT EXISTS 'medical_examiner';
