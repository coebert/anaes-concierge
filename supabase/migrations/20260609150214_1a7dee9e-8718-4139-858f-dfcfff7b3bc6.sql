-- Add 'private' kind for off-site theatres (e.g. New Hall Hospital) and
-- 'nhh_oncall' duty type for the NHH 1st On-call consultant slot.
ALTER TYPE public.theatre_kind ADD VALUE IF NOT EXISTS 'private';
ALTER TYPE public.duty_type ADD VALUE IF NOT EXISTS 'nhh_oncall';