
-- Fix mutable search_path on set_updated_at
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- Revoke public/anon execute on security definer functions, keep authenticated.
revoke execute on function public.has_role(uuid, public.app_role) from public, anon;
revoke execute on function public.current_user_is_coordinator_or_admin() from public, anon;
revoke execute on function public.handle_new_user() from public, anon, authenticated;
revoke execute on function public.set_updated_at() from public, anon, authenticated;

grant execute on function public.has_role(uuid, public.app_role) to authenticated;
grant execute on function public.current_user_is_coordinator_or_admin() to authenticated;
