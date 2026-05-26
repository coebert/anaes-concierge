
-- =========================================================
-- ENUMS
-- =========================================================
create type public.app_role as enum ('admin', 'rota_coordinator', 'staff');
create type public.staff_grade as enum ('consultant', 'sas', 'trainee');
create type public.session_half as enum ('am', 'pm');
create type public.rota_role as enum ('solo', 'supervised', 'supervising', 'on_call', 'non_clinical', 'teaching', 'admin_session');
create type public.rota_source as enum ('manual', 'clwrota');
create type public.leave_type as enum ('annual', 'study', 'compassionate', 'sick', 'parental', 'other');
create type public.leave_status as enum ('pending', 'approved', 'rejected', 'cancelled');
create type public.theatre_kind as enum ('main', 'day_surgery');
create type public.chat_role as enum ('user', 'assistant', 'system');

-- =========================================================
-- PROFILES
-- =========================================================
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  full_name text not null default '',
  grade public.staff_grade,
  training_level text, -- e.g. ST4, ST5 (free text for trainees)
  gmc_number text,
  start_date date,
  active boolean not null default true,
  clwrota_external_id text unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

-- =========================================================
-- USER ROLES (separate table - critical for security)
-- =========================================================
create table public.user_roles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  role public.app_role not null,
  created_at timestamptz not null default now(),
  unique (user_id, role)
);

alter table public.user_roles enable row level security;

-- SECURITY DEFINER role check (avoids recursive RLS)
create or replace function public.has_role(_user_id uuid, _role public.app_role)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.user_roles where user_id = _user_id and role = _role)
$$;

-- Convenience: is_staff_or_above (any authenticated profile)
create or replace function public.current_user_is_coordinator_or_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.user_roles
    where user_id = auth.uid()
      and role in ('admin', 'rota_coordinator')
  )
$$;

-- =========================================================
-- updated_at trigger helper
-- =========================================================
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger profiles_updated_at before update on public.profiles
  for each row execute function public.set_updated_at();

-- =========================================================
-- New user trigger: create profile + default staff role
-- =========================================================
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, full_name)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'full_name', '')
  );
  insert into public.user_roles (user_id, role) values (new.id, 'staff');
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- =========================================================
-- PROFILES RLS
-- =========================================================
create policy "Authenticated can read profiles"
  on public.profiles for select
  to authenticated
  using (true);

create policy "Users can update own profile basic fields"
  on public.profiles for update
  to authenticated
  using (auth.uid() = id)
  with check (auth.uid() = id);

create policy "Admins can insert profiles"
  on public.profiles for insert
  to authenticated
  with check (public.has_role(auth.uid(), 'admin'));

create policy "Admins can update any profile"
  on public.profiles for update
  to authenticated
  using (public.has_role(auth.uid(), 'admin'))
  with check (public.has_role(auth.uid(), 'admin'));

create policy "Admins can delete profiles"
  on public.profiles for delete
  to authenticated
  using (public.has_role(auth.uid(), 'admin'));

-- =========================================================
-- USER_ROLES RLS
-- =========================================================
create policy "Users can view own roles"
  on public.user_roles for select
  to authenticated
  using (auth.uid() = user_id or public.has_role(auth.uid(), 'admin'));

create policy "Only admins can manage roles"
  on public.user_roles for insert
  to authenticated
  with check (public.has_role(auth.uid(), 'admin'));

create policy "Only admins can update roles"
  on public.user_roles for update
  to authenticated
  using (public.has_role(auth.uid(), 'admin'));

create policy "Only admins can delete roles"
  on public.user_roles for delete
  to authenticated
  using (public.has_role(auth.uid(), 'admin'));

-- =========================================================
-- JOB PLANS
-- =========================================================
create table public.job_plans (
  id uuid primary key default gen_random_uuid(),
  staff_id uuid not null references public.profiles(id) on delete cascade,
  total_pas numeric(4,2) not null default 10,
  dcc_pas numeric(4,2) not null default 7.5,
  spa_pas numeric(4,2) not null default 2.5,
  ltft boolean not null default false,
  ltft_percentage numeric(5,2),
  on_call_commitment text,
  notes text,
  valid_from date not null default current_date,
  valid_to date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.job_plans enable row level security;
create trigger job_plans_updated_at before update on public.job_plans
  for each row execute function public.set_updated_at();

create policy "Staff view own job plan, coords/admins view all"
  on public.job_plans for select to authenticated
  using (auth.uid() = staff_id or public.current_user_is_coordinator_or_admin());

create policy "Admins manage job plans"
  on public.job_plans for all to authenticated
  using (public.has_role(auth.uid(), 'admin'))
  with check (public.has_role(auth.uid(), 'admin'));

-- =========================================================
-- FIXED WEEKLY SESSIONS (part of job plan)
-- e.g. "Mon AM Theatre 3"
-- =========================================================
create table public.fixed_sessions (
  id uuid primary key default gen_random_uuid(),
  staff_id uuid not null references public.profiles(id) on delete cascade,
  day_of_week smallint not null check (day_of_week between 0 and 6), -- 0=Sunday
  session public.session_half not null,
  theatre_id uuid, -- optional FK below
  description text,
  created_at timestamptz not null default now()
);

alter table public.fixed_sessions enable row level security;

create policy "Authenticated can read fixed sessions"
  on public.fixed_sessions for select to authenticated using (true);

create policy "Admins manage fixed sessions"
  on public.fixed_sessions for all to authenticated
  using (public.has_role(auth.uid(), 'admin'))
  with check (public.has_role(auth.uid(), 'admin'));

-- =========================================================
-- THEATRES
-- =========================================================
create table public.theatres (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  kind public.theatre_kind not null,
  sort_order smallint not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

alter table public.theatres enable row level security;

create policy "Authenticated can read theatres"
  on public.theatres for select to authenticated using (true);

create policy "Admins manage theatres"
  on public.theatres for all to authenticated
  using (public.has_role(auth.uid(), 'admin'))
  with check (public.has_role(auth.uid(), 'admin'));

-- Seed theatres
insert into public.theatres (name, kind, sort_order) values
  ('Theatre 1', 'main', 1),
  ('Theatre 2', 'main', 2),
  ('Theatre 3', 'main', 3),
  ('Theatre 4', 'main', 4),
  ('Theatre 5', 'main', 5),
  ('Theatre 6', 'main', 6),
  ('Theatre 7', 'main', 7),
  ('Theatre 8', 'main', 8),
  ('Theatre 9', 'main', 9),
  ('Theatre 10', 'main', 10),
  ('Day Surgery A', 'day_surgery', 11),
  ('Day Surgery B', 'day_surgery', 12),
  ('Day Surgery F', 'day_surgery', 13);

-- Add FK for fixed_sessions.theatre_id
alter table public.fixed_sessions
  add constraint fixed_sessions_theatre_fk
  foreign key (theatre_id) references public.theatres(id) on delete set null;

-- =========================================================
-- SURGICAL SPECIALTIES (lookup)
-- =========================================================
create table public.specialties (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  is_trainee_bucket boolean not null default true,
  created_at timestamptz not null default now()
);

alter table public.specialties enable row level security;

create policy "Authenticated can read specialties"
  on public.specialties for select to authenticated using (true);

create policy "Admins manage specialties"
  on public.specialties for all to authenticated
  using (public.has_role(auth.uid(), 'admin'))
  with check (public.has_role(auth.uid(), 'admin'));

insert into public.specialties (name) values
  ('General Surgery'),
  ('Orthopaedics'),
  ('Obstetrics'),
  ('Gynaecology'),
  ('Paediatrics'),
  ('ENT'),
  ('Urology'),
  ('Vascular'),
  ('Cardiac'),
  ('Neurosurgery'),
  ('Regional'),
  ('ICM'),
  ('Pain'),
  ('Ophthalmology'),
  ('Plastics'),
  ('Maxillofacial'),
  ('Endoscopy');

-- =========================================================
-- THEATRE SESSIONS (per date/theatre/session)
-- =========================================================
create table public.theatre_sessions (
  id uuid primary key default gen_random_uuid(),
  session_date date not null,
  theatre_id uuid not null references public.theatres(id) on delete cascade,
  session public.session_half not null,
  specialty_id uuid references public.specialties(id),
  surgical_consultant text,
  notes text,
  clwrota_external_id text unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (session_date, theatre_id, session)
);

alter table public.theatre_sessions enable row level security;
create trigger theatre_sessions_updated_at before update on public.theatre_sessions
  for each row execute function public.set_updated_at();

create index theatre_sessions_date_idx on public.theatre_sessions(session_date);

create policy "Authenticated can read theatre sessions"
  on public.theatre_sessions for select to authenticated using (true);

create policy "Coords/admins manage theatre sessions"
  on public.theatre_sessions for all to authenticated
  using (public.current_user_is_coordinator_or_admin())
  with check (public.current_user_is_coordinator_or_admin());

-- =========================================================
-- ROTA ASSIGNMENTS
-- =========================================================
create table public.rota_assignments (
  id uuid primary key default gen_random_uuid(),
  session_date date not null,
  session public.session_half not null,
  staff_id uuid not null references public.profiles(id) on delete cascade,
  theatre_session_id uuid references public.theatre_sessions(id) on delete set null,
  role_on_list public.rota_role not null default 'solo',
  supervisor_id uuid references public.profiles(id) on delete set null,
  notes text,
  source public.rota_source not null default 'manual',
  clwrota_external_id text unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.rota_assignments enable row level security;
create trigger rota_assignments_updated_at before update on public.rota_assignments
  for each row execute function public.set_updated_at();

create index rota_assignments_date_idx on public.rota_assignments(session_date);
create index rota_assignments_staff_date_idx on public.rota_assignments(staff_id, session_date);

create policy "Authenticated can read rota"
  on public.rota_assignments for select to authenticated using (true);

create policy "Coords/admins manage rota"
  on public.rota_assignments for all to authenticated
  using (public.current_user_is_coordinator_or_admin())
  with check (public.current_user_is_coordinator_or_admin());

-- =========================================================
-- LEAVE ALLOWANCES
-- =========================================================
create table public.leave_allowances (
  id uuid primary key default gen_random_uuid(),
  staff_id uuid not null references public.profiles(id) on delete cascade,
  leave_year_start date not null, -- e.g. 2025-04-01
  annual_days numeric(6,2) not null default 27,
  study_days numeric(6,2) not null default 10,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (staff_id, leave_year_start)
);

alter table public.leave_allowances enable row level security;
create trigger leave_allowances_updated_at before update on public.leave_allowances
  for each row execute function public.set_updated_at();

create policy "Staff view own allowance, coords/admins view all"
  on public.leave_allowances for select to authenticated
  using (auth.uid() = staff_id or public.current_user_is_coordinator_or_admin());

create policy "Admins manage allowances"
  on public.leave_allowances for all to authenticated
  using (public.has_role(auth.uid(), 'admin'))
  with check (public.has_role(auth.uid(), 'admin'));

-- =========================================================
-- LEAVE REQUESTS
-- =========================================================
create table public.leave_requests (
  id uuid primary key default gen_random_uuid(),
  staff_id uuid not null references public.profiles(id) on delete cascade,
  type public.leave_type not null,
  start_date date not null,
  end_date date not null,
  half_day_start public.session_half,
  half_day_end public.session_half,
  reason text,
  status public.leave_status not null default 'pending',
  decided_by uuid references public.profiles(id),
  decided_at timestamptz,
  decision_notes text,
  conflict_notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (end_date >= start_date)
);

alter table public.leave_requests enable row level security;
create trigger leave_requests_updated_at before update on public.leave_requests
  for each row execute function public.set_updated_at();

create policy "Staff view own leave, coords/admins view all"
  on public.leave_requests for select to authenticated
  using (auth.uid() = staff_id or public.current_user_is_coordinator_or_admin());

create policy "Staff create own leave requests"
  on public.leave_requests for insert to authenticated
  with check (auth.uid() = staff_id);

create policy "Staff update own pending leave requests"
  on public.leave_requests for update to authenticated
  using (auth.uid() = staff_id and status = 'pending')
  with check (auth.uid() = staff_id);

create policy "Coords/admins update any leave request"
  on public.leave_requests for update to authenticated
  using (public.current_user_is_coordinator_or_admin())
  with check (public.current_user_is_coordinator_or_admin());

create policy "Coords/admins delete leave"
  on public.leave_requests for delete to authenticated
  using (public.current_user_is_coordinator_or_admin());

-- =========================================================
-- TRAINEE CURRICULUM TARGETS
-- =========================================================
create table public.trainee_targets (
  id uuid primary key default gen_random_uuid(),
  training_level text not null, -- e.g. 'ST4'
  specialty_id uuid not null references public.specialties(id) on delete cascade,
  required_sessions int not null default 0,
  required_solo int not null default 0,
  required_supervised int not null default 0,
  notes text,
  created_at timestamptz not null default now(),
  unique (training_level, specialty_id)
);

alter table public.trainee_targets enable row level security;

create policy "Authenticated can read trainee targets"
  on public.trainee_targets for select to authenticated using (true);

create policy "Admins manage trainee targets"
  on public.trainee_targets for all to authenticated
  using (public.has_role(auth.uid(), 'admin'))
  with check (public.has_role(auth.uid(), 'admin'));

-- =========================================================
-- AI CHAT
-- =========================================================
create table public.ai_conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null default 'New conversation',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.ai_conversations enable row level security;
create trigger ai_conversations_updated_at before update on public.ai_conversations
  for each row execute function public.set_updated_at();

create policy "Users manage own conversations - select"
  on public.ai_conversations for select to authenticated using (auth.uid() = user_id);
create policy "Users manage own conversations - insert"
  on public.ai_conversations for insert to authenticated with check (auth.uid() = user_id);
create policy "Users manage own conversations - update"
  on public.ai_conversations for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "Users manage own conversations - delete"
  on public.ai_conversations for delete to authenticated using (auth.uid() = user_id);

create table public.ai_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.ai_conversations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role public.chat_role not null,
  parts jsonb not null,
  created_at timestamptz not null default now()
);

alter table public.ai_messages enable row level security;
create index ai_messages_conv_idx on public.ai_messages(conversation_id, created_at);

create policy "Users see own messages"
  on public.ai_messages for select to authenticated using (auth.uid() = user_id);
create policy "Users insert own messages"
  on public.ai_messages for insert to authenticated with check (auth.uid() = user_id);
create policy "Users delete own messages"
  on public.ai_messages for delete to authenticated using (auth.uid() = user_id);

-- =========================================================
-- INBOUND EMAIL LOG
-- =========================================================
create table public.email_inbound_log (
  id uuid primary key default gen_random_uuid(),
  from_email text not null,
  matched_user_id uuid references auth.users(id) on delete set null,
  subject text,
  body_text text,
  reply_text text,
  status text not null default 'received',
  error text,
  received_at timestamptz not null default now()
);

alter table public.email_inbound_log enable row level security;

create policy "Users see own inbound email log"
  on public.email_inbound_log for select to authenticated
  using (auth.uid() = matched_user_id or public.has_role(auth.uid(), 'admin'));

-- =========================================================
-- CLWROTA SYNC STATE
-- =========================================================
create table public.clwrota_sync_state (
  id int primary key default 1,
  last_sync_at timestamptz,
  last_status text,
  last_error text,
  check (id = 1)
);

alter table public.clwrota_sync_state enable row level security;

create policy "Admins read sync state"
  on public.clwrota_sync_state for select to authenticated
  using (public.has_role(auth.uid(), 'admin'));

create policy "Admins write sync state"
  on public.clwrota_sync_state for all to authenticated
  using (public.has_role(auth.uid(), 'admin'))
  with check (public.has_role(auth.uid(), 'admin'));

insert into public.clwrota_sync_state (id) values (1);
