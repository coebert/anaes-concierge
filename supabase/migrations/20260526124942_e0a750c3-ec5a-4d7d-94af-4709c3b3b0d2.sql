
CREATE TYPE public.access_request_status AS ENUM ('pending', 'approved', 'declined');

CREATE TABLE public.access_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  full_name text NOT NULL,
  message text,
  status public.access_request_status NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  decided_by uuid,
  decision_notes text
);

CREATE INDEX idx_access_requests_email_status ON public.access_requests (lower(email), status);
CREATE INDEX idx_access_requests_status_created ON public.access_requests (status, created_at DESC);

ALTER TABLE public.access_requests ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins manage access requests"
ON public.access_requests
FOR ALL TO authenticated
USING (has_role(auth.uid(), 'admin'::app_role))
WITH CHECK (has_role(auth.uid(), 'admin'::app_role));

CREATE TRIGGER access_requests_set_updated_at
BEFORE UPDATE ON public.access_requests
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Replace handle_new_user so signups only get a staff role if pre-approved.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
declare
  v_existing_id uuid;
  v_pre_approved boolean := false;
begin
  select id into v_existing_id from public.profiles where email = new.email limit 1;

  if v_existing_id is not null and v_existing_id <> new.id then
    -- Admin previously created this profile (invite flow). Re-point dependent rows.
    update public.rota_assignments set staff_id = new.id where staff_id = v_existing_id;
    update public.rota_assignments set supervisor_id = new.id where supervisor_id = v_existing_id;
    update public.fixed_sessions set staff_id = new.id where staff_id = v_existing_id;
    update public.leave_requests set staff_id = new.id where staff_id = v_existing_id;
    update public.leave_allowances set staff_id = new.id where staff_id = v_existing_id;
    update public.job_plans set staff_id = new.id where staff_id = v_existing_id;

    update public.profiles
      set id = new.id,
          full_name = coalesce(nullif(full_name,''), new.raw_user_meta_data->>'full_name', ''),
          updated_at = now()
      where id = v_existing_id;

    v_pre_approved := true;
  elsif v_existing_id is null then
    -- No admin-created profile. Only create a profile if the email has an approved request.
    select exists (
      select 1 from public.access_requests
      where lower(email) = lower(new.email) and status = 'approved'
    ) into v_pre_approved;

    if v_pre_approved then
      insert into public.profiles (id, email, full_name)
      values (new.id, new.email, coalesce(new.raw_user_meta_data->>'full_name', ''));
    end if;
  else
    v_pre_approved := true;
  end if;

  if v_pre_approved then
    insert into public.user_roles (user_id, role)
    values (new.id, 'staff')
    on conflict do nothing;
  end if;

  return new;
end;
$function$;

REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;
