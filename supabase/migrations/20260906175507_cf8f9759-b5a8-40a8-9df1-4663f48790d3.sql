create or replace function public.enforce_recognition_update_rules()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if has_role(auth.uid(), 'admin'::app_role) then
    return new;
  end if;
  if new.staff_id is distinct from old.staff_id
     or new.from_user_id is distinct from old.from_user_id
     or new.is_public is distinct from old.is_public
     or new.created_at is distinct from old.created_at then
    raise exception 'Recipient, sender and visibility cannot be changed after sending';
  end if;
  return new;
end;
$$;

drop trigger if exists enforce_recognition_update_rules on public.recognition_entries;
create trigger enforce_recognition_update_rules
before update on public.recognition_entries
for each row execute function public.enforce_recognition_update_rules();