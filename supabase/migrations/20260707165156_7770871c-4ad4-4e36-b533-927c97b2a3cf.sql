
-- 1. Extend leave_type enum (idempotent)
ALTER TYPE public.leave_type ADD VALUE IF NOT EXISTS 'carers';
ALTER TYPE public.leave_type ADD VALUE IF NOT EXISTS 'jury';
ALTER TYPE public.leave_type ADD VALUE IF NOT EXISTS 'industrial';
ALTER TYPE public.leave_type ADD VALUE IF NOT EXISTS 'toil';

-- 2. Extend leave_allowances
ALTER TABLE public.leave_allowances
  ADD COLUMN IF NOT EXISTS carers_days numeric(6,2) NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS parental_days numeric(6,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS compassionate_days numeric(6,2) NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS ltft_fraction numeric(4,3) NOT NULL DEFAULT 1.000,
  ADD COLUMN IF NOT EXISTS carry_over_days numeric(6,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS sla_target_days smallint NOT NULL DEFAULT 14;

-- 3. Create leave_ledger_entries (TOIL / banked hours)
CREATE TABLE public.leave_ledger_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  entry_date date NOT NULL,
  kind text NOT NULL CHECK (kind IN ('accrual','spend','adjustment')),
  hours numeric(6,2) NOT NULL,
  reason text,
  reason_enc bytea,
  related_leave_request_id uuid REFERENCES public.leave_requests(id) ON DELETE SET NULL,
  created_by uuid REFERENCES public.profiles(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX leave_ledger_entries_staff_idx ON public.leave_ledger_entries (staff_id, entry_date DESC);

-- 4. GRANTs (before RLS)
GRANT SELECT, INSERT, UPDATE, DELETE ON public.leave_ledger_entries TO authenticated;
GRANT ALL ON public.leave_ledger_entries TO service_role;

-- 5. RLS
ALTER TABLE public.leave_ledger_entries ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff view own ledger, coords/admins view all"
  ON public.leave_ledger_entries FOR SELECT
  TO authenticated
  USING (auth.uid() = staff_id OR public.current_user_is_coordinator_or_admin());

CREATE POLICY "Admins insert ledger"
  ON public.leave_ledger_entries FOR INSERT
  TO authenticated
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Admins update ledger"
  ON public.leave_ledger_entries FOR UPDATE
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Admins delete ledger"
  ON public.leave_ledger_entries FOR DELETE
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

-- 6. Encryption sync trigger for reason
CREATE OR REPLACE FUNCTION public._sync_leave_ledger_encryption()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.reason IS DISTINCT FROM OLD.reason THEN
    NEW.reason_enc := public.encrypt_text(NEW.reason);
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER leave_ledger_encrypt
  BEFORE INSERT OR UPDATE ON public.leave_ledger_entries
  FOR EACH ROW EXECUTE FUNCTION public._sync_leave_ledger_encryption();

CREATE TRIGGER leave_ledger_updated_at
  BEFORE UPDATE ON public.leave_ledger_entries
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- 7. Decrypted RPC
CREATE OR REPLACE FUNCTION public.get_leave_ledger_decrypted()
RETURNS TABLE(
  id uuid, staff_id uuid, entry_date date, kind text, hours numeric,
  reason text, related_leave_request_id uuid, created_by uuid,
  created_at timestamptz, updated_at timestamptz
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_rows integer;
BEGIN
  RETURN QUERY
  SELECT l.id, l.staff_id, l.entry_date, l.kind, l.hours,
    public.decrypt_owner_or_coord(l.reason_enc, l.staff_id),
    l.related_leave_request_id, l.created_by, l.created_at, l.updated_at
  FROM public.leave_ledger_entries l
  WHERE l.staff_id = auth.uid()
     OR public.current_user_is_coordinator_or_admin();
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  PERFORM public.log_rpc_access('get_leave_ledger_decrypted', v_rows, NULL);
END $$;

GRANT EXECUTE ON FUNCTION public.get_leave_ledger_decrypted() TO authenticated;
