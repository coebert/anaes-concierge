-- Disposable synthetic fixture reproducing the LIVE "definer owner is a
-- service_role member" trap. Run as the harness superuser; objects are created
-- under SET ROLE postgres so postgres OWNS them exactly as live.
-- Never run against a real database. All people/data are synthetic.

-- Live role graph (metadata-verified): postgres is NOT superuser, BYPASSRLS,
-- and a member of anon, authenticated and service_role; authenticator is a
-- NOINHERIT login member of anon/authenticated/service_role.
CREATE ROLE anon NOLOGIN NOINHERIT;
CREATE ROLE authenticated NOLOGIN NOINHERIT;
CREATE ROLE service_role NOLOGIN NOINHERIT BYPASSRLS;
CREATE ROLE postgres LOGIN NOSUPERUSER CREATEROLE BYPASSRLS;
GRANT anon, authenticated, service_role TO postgres;
CREATE ROLE authenticator LOGIN NOINHERIT;
GRANT anon, authenticated, service_role TO authenticator;

CREATE SCHEMA extensions; CREATE EXTENSION pgcrypto SCHEMA extensions;
GRANT USAGE ON SCHEMA extensions TO PUBLIC;
GRANT ALL ON SCHEMA public TO postgres;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

-- auth.uid()/auth.role(): same bodies as Supabase (claim GUC or claims JSON).
CREATE SCHEMA auth; GRANT USAGE ON SCHEMA auth TO PUBLIC;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''),
                  (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid $$;
CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$
  SELECT coalesce(nullif(current_setting('request.jwt.claim.role', true), ''),
                  (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'))::text $$;

-- vault with a DUMMY webhook secret + synthetic column key.
CREATE SCHEMA vault; CREATE TABLE vault.decrypted_secrets (name text, decrypted_secret text);
INSERT INTO vault.decrypted_secrets VALUES ('CLWROTA_WEBHOOK_SECRET', 'dummy-harness-secret'), ('COLUMN_ENCRYPTION_KEY', 'synthetic-key');
GRANT USAGE ON SCHEMA vault TO postgres; GRANT SELECT ON vault.decrypted_secrets TO postgres;

-- STUB net queue: http_post only records the call. No real HTTP.
CREATE SCHEMA net; GRANT USAGE ON SCHEMA net TO postgres;
CREATE TABLE net.http_request_queue (id bigserial PRIMARY KEY, url text, headers jsonb);
CREATE FUNCTION net.http_post(url text, body jsonb DEFAULT '{}', params jsonb DEFAULT '{}', headers jsonb DEFAULT '{}', timeout_milliseconds int DEFAULT 5000)
RETURNS bigint LANGUAGE sql AS $$ INSERT INTO net.http_request_queue(url, headers) VALUES (url, headers) RETURNING id $$;
GRANT ALL ON net.http_request_queue TO postgres; GRANT USAGE ON SEQUENCE net.http_request_queue_id_seq TO postgres;
REVOKE ALL ON FUNCTION net.http_post(text,jsonb,jsonb,jsonb,int) FROM PUBLIC; GRANT EXECUTE ON FUNCTION net.http_post(text,jsonb,jsonb,jsonb,int) TO postgres;

-- Synthetic cron catalog (live shape; username postgres).
CREATE SCHEMA cron; GRANT USAGE ON SCHEMA cron TO postgres;
CREATE TABLE cron.job (jobid bigint, jobname text, schedule text, active boolean, command text, username text);
CREATE TABLE cron.job_run_details (runid bigint, jobid bigint, start_time timestamptz, end_time timestamptz, status text, return_message text);
INSERT INTO cron.job VALUES (9, 'clwrota-sync-staff-daily', '10 3 * * *', true, $$select public.trigger_clwrota_sync('staff')$$, 'postgres');
INSERT INTO cron.job_run_details VALUES (1, 9, now() - interval '1 day', now() - interval '1 day', 'succeeded', '1 row');
GRANT SELECT ON cron.job, cron.job_run_details TO postgres;

SET ROLE postgres;
CREATE TYPE public.app_role AS ENUM ('admin','rota_coordinator','staff');
CREATE TYPE public.staff_grade AS ENUM ('consultant','sas','trainee');
CREATE TYPE public.chat_role AS ENUM ('user','assistant','system','tool');
CREATE TABLE public.profiles (id uuid PRIMARY KEY, full_name text, grade staff_grade, active boolean DEFAULT true, left_at date);
CREATE TABLE public.user_roles (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, role app_role, UNIQUE (user_id, role));
CREATE TABLE public.ai_conversations (id uuid PRIMARY KEY, user_id uuid);
CREATE TABLE public.ai_messages (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), conversation_id uuid, user_id uuid, role chat_role, parts_enc bytea, created_at timestamptz DEFAULT now());
CREATE TABLE public.return_to_work_interviews (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), leave_request_id uuid, staff_id uuid, conducted_by uuid,
  conducted_at timestamptz DEFAULT now(), fitness_confirmed boolean, reasonable_adjustments_enc bytea, follow_up_required boolean DEFAULT false,
  follow_up_date date, notes_enc bytea, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());
CREATE TABLE public.rpc_access_audit (id bigserial PRIMARY KEY, rpc_name text NOT NULL, called_by uuid, db_role text NOT NULL DEFAULT current_user,
  row_count int, args jsonb, called_at timestamptz DEFAULT now());
CREATE TABLE public.rpc_access_alerts (id bigserial PRIMARY KEY, alert_type text, rpc_name text, subject_user uuid, window_start timestamptz,
  window_end timestamptz, call_count int, threshold int, details jsonb);
CREATE UNIQUE INDEX ON public.rpc_access_alerts (alert_type, rpc_name, COALESCE(subject_user, '00000000-0000-0000-0000-000000000000'::uuid), window_start);
CREATE TABLE public.clwrota_sync_rate_limit (step text PRIMARY KEY, min_interval_seconds int, last_attempt_at timestamptz, last_request_id bigint, updated_at timestamptz);
INSERT INTO public.clwrota_sync_rate_limit (step, min_interval_seconds) VALUES ('staff', 0), ('rota', 0), ('leave', 0);
CREATE TABLE public.specialties (id uuid PRIMARY KEY, name text);
CREATE TABLE public.staff_competencies (staff_id uuid, competency_id uuid, level text, granted_at date, revoked_at date, expires_at date);
CREATE TABLE public.specialty_competency_requirements (specialty_id uuid, competency_id uuid, requirement text, applies_to_role text);
INSERT INTO public.specialties VALUES ('50000000-0000-0000-0000-000000000001', 'Synthetic ICU');
ALTER TABLE public.ai_messages ENABLE ROW LEVEL SECURITY; ALTER TABLE public.ai_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.return_to_work_interviews ENABLE ROW LEVEL SECURITY; ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;

-- Encryption helpers (live shape; synthetic key).
CREATE FUNCTION public._enc_key() RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, vault
AS $$ SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'COLUMN_ENCRYPTION_KEY' LIMIT 1 $$;
REVOKE ALL ON FUNCTION public._enc_key() FROM PUBLIC; GRANT EXECUTE ON FUNCTION public._enc_key() TO service_role;

-- Live membership helpers (verbatim bodies from migration 0006 as live).
CREATE FUNCTION public.has_role(_user_id uuid, _role app_role) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role)
     AND public._is_active_member_profile(_user_id) $$;
CREATE FUNCTION public.current_user_is_coordinator_or_admin() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = auth.uid() AND role IN ('admin', 'rota_coordinator'))
     AND public._is_active_member_profile(auth.uid()) $$;
CREATE FUNCTION public.is_app_member(_user_id uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public AS $$
  SELECT _user_id IS NOT NULL AND _user_id = auth.uid()
     AND EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id)
     AND EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = _user_id AND p.active IS TRUE AND p.left_at IS NULL) $$;
RESET ROLE;
