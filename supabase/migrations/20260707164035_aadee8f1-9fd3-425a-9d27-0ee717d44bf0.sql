
CREATE TABLE public.return_to_work_interviews (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  leave_request_id UUID NOT NULL REFERENCES public.leave_requests(id) ON DELETE CASCADE,
  staff_id UUID NOT NULL,
  conducted_by UUID,
  conducted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  fitness_confirmed BOOLEAN NOT NULL DEFAULT true,
  reasonable_adjustments TEXT,
  reasonable_adjustments_enc BYTEA,
  follow_up_required BOOLEAN NOT NULL DEFAULT false,
  follow_up_date DATE,
  notes TEXT,
  notes_enc BYTEA,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT return_to_work_interviews_unique_per_spell UNIQUE (leave_request_id)
);

CREATE INDEX idx_rtw_staff ON public.return_to_work_interviews(staff_id);
CREATE INDEX idx_rtw_leave ON public.return_to_work_interviews(leave_request_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.return_to_work_interviews TO authenticated;
GRANT ALL ON public.return_to_work_interviews TO service_role;

ALTER TABLE public.return_to_work_interviews ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff can read own RTW"
  ON public.return_to_work_interviews
  FOR SELECT TO authenticated
  USING (staff_id = auth.uid());

CREATE POLICY "Coordinators can read all RTW"
  ON public.return_to_work_interviews
  FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'rota_coordinator'));

CREATE POLICY "Admins can read all RTW"
  ON public.return_to_work_interviews
  FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Admins can insert RTW"
  ON public.return_to_work_interviews
  FOR INSERT TO authenticated
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Admins can update RTW"
  ON public.return_to_work_interviews
  FOR UPDATE TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Admins can delete RTW"
  ON public.return_to_work_interviews
  FOR DELETE TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

-- Encryption sync trigger, mirroring _sync_leave_requests_encryption pattern.
CREATE OR REPLACE FUNCTION public._sync_rtw_encryption()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.reasonable_adjustments IS DISTINCT FROM OLD.reasonable_adjustments THEN
    NEW.reasonable_adjustments_enc := public.encrypt_text(NEW.reasonable_adjustments);
  END IF;
  IF TG_OP = 'INSERT' OR NEW.notes IS DISTINCT FROM OLD.notes THEN
    NEW.notes_enc := public.encrypt_text(NEW.notes);
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_rtw_encryption
BEFORE INSERT OR UPDATE ON public.return_to_work_interviews
FOR EACH ROW EXECUTE FUNCTION public._sync_rtw_encryption();

CREATE TRIGGER trg_rtw_updated_at
BEFORE UPDATE ON public.return_to_work_interviews
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Decrypted read RPC: owner or coordinator/admin gets plaintext; anyone else NULL.
CREATE OR REPLACE FUNCTION public.get_rtw_interviews_decrypted()
RETURNS TABLE (
  id UUID,
  leave_request_id UUID,
  staff_id UUID,
  conducted_by UUID,
  conducted_at TIMESTAMPTZ,
  fitness_confirmed BOOLEAN,
  reasonable_adjustments TEXT,
  follow_up_required BOOLEAN,
  follow_up_date DATE,
  notes TEXT,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_rows INTEGER;
BEGIN
  RETURN QUERY
  SELECT r.id, r.leave_request_id, r.staff_id, r.conducted_by, r.conducted_at,
    r.fitness_confirmed,
    public.decrypt_owner_or_coord(r.reasonable_adjustments_enc, r.staff_id),
    r.follow_up_required, r.follow_up_date,
    public.decrypt_owner_or_coord(r.notes_enc, r.staff_id),
    r.created_at, r.updated_at
  FROM public.return_to_work_interviews r;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  PERFORM public.log_rpc_access('get_rtw_interviews_decrypted', v_rows, NULL);
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_rtw_interviews_decrypted() TO authenticated, service_role;
