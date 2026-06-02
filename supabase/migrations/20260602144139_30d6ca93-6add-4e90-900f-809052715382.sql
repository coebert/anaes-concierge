create table public.validation_custom_non_working_labels (
  id uuid primary key default gen_random_uuid(),
  token text not null unique,
  source text,
  created_at timestamptz not null default now(),
  created_by uuid
);

grant select on public.validation_custom_non_working_labels to authenticated;
grant all on public.validation_custom_non_working_labels to service_role;

alter table public.validation_custom_non_working_labels enable row level security;

create policy "Authenticated can read custom non-working labels"
  on public.validation_custom_non_working_labels
  for select
  to authenticated
  using (true);

create policy "Coords/admins manage custom non-working labels"
  on public.validation_custom_non_working_labels
  for all
  to authenticated
  using (public.current_user_is_coordinator_or_admin())
  with check (public.current_user_is_coordinator_or_admin());