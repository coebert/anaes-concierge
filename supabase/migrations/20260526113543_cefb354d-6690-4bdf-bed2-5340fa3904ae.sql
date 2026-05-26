
-- Drop FK so CLWRota-imported staff can be pre-created before signup
ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_id_fkey;

-- Replace handle_new_user to reconcile by email if a placeholder profile exists
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
declare
  v_existing_id uuid;
begin
  select id into v_existing_id from public.profiles where email = new.email limit 1;

  if v_existing_id is not null and v_existing_id <> new.id then
    -- Re-point dependent rows to the auth user's id, then update the profile id
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
  elsif v_existing_id is null then
    insert into public.profiles (id, email, full_name)
    values (new.id, new.email, coalesce(new.raw_user_meta_data->>'full_name', ''));
  end if;

  insert into public.user_roles (user_id, role)
  values (new.id, 'staff')
  on conflict do nothing;

  return new;
end;
$function$;
