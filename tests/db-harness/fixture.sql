-- Disposable synthetic fixture mirroring the LIVE policies/columns relevant to
-- the security remediation. Never run against a real database.
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA auth; GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
CREATE TYPE app_role AS ENUM ('admin','rota_coordinator','staff');
CREATE TYPE staff_grade AS ENUM ('consultant','sas','trainee');
CREATE TYPE leave_status AS ENUM ('pending','approved','rejected','cancelled');
CREATE TYPE leave_type AS ENUM ('annual','study','compassionate','sick','parental','other','professional','carers','jury','industrial','toil');
CREATE TYPE session_half AS ENUM ('am','pm','eve','night');

CREATE TABLE profiles (id uuid PRIMARY KEY, email text, full_name text, grade staff_grade, training_level text,
  gmc_number text, start_date date, active boolean DEFAULT true, clwrota_external_id text,
  created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(), rotation_end_date date,
  ltft_days_off smallint[], left_at date, calendar_feed_token text, email_enc bytea, email_hash bytea, gmc_number_enc bytea);
CREATE TABLE user_roles (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, role app_role, UNIQUE(user_id, role));
CREATE TABLE leave_requests (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), staff_id uuid, type leave_type DEFAULT 'annual',
  start_date date, end_date date, half_day_start session_half, half_day_end session_half, reason text,
  status leave_status DEFAULT 'pending', decided_by uuid, decided_at timestamptz, decision_notes text, conflict_notes text,
  reserve_listed_at timestamptz, clwrota_external_id text, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());
CREATE TABLE exception_reports (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), trainee_id uuid, event_date date, event_session session_half,
  category text, immediate_safety_concern boolean DEFAULT false, description text, hours_worked_extra numeric, rest_missed_hours numeric,
  status text DEFAULT 'submitted', outcome text, outcome_note text, responder_id uuid, acknowledged_at timestamptz, resolved_at timestamptz,
  due_by timestamptz, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());
CREATE TABLE push_subscriptions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, endpoint text UNIQUE, p256dh text, auth text,
  user_agent text, created_at timestamptz DEFAULT now(), last_used_at timestamptz);
CREATE TABLE rota_assignments (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), staff_id uuid, session_date date);

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO authenticated, service_role;

CREATE FUNCTION has_role(_user_id uuid, _role app_role) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$ SELECT EXISTS (SELECT 1 FROM user_roles WHERE user_id = _user_id AND role = _role) $$;
CREATE FUNCTION current_user_is_coordinator_or_admin() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$ SELECT EXISTS (SELECT 1 FROM user_roles WHERE user_id = auth.uid() AND role IN ('admin','rota_coordinator')) $$;

-- Secrets surface the audit SQL tool must never reach.
CREATE SCHEMA vault; CREATE TABLE vault.decrypted_secrets (name text, decrypted_secret text);
INSERT INTO vault.decrypted_secrets VALUES ('COLUMN_ENCRYPTION_KEY', 'synthetic-key');
GRANT USAGE ON SCHEMA vault TO service_role; GRANT SELECT ON vault.decrypted_secrets TO service_role;
CREATE FUNCTION _enc_key() RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, vault
AS $$ SELECT decrypted_secret FROM vault.decrypted_secrets LIMIT 1 $$;
CREATE FUNCTION decrypt_text(p bytea) RETURNS text LANGUAGE sql STABLE SECURITY DEFINER AS $$ SELECT 'PLAINTEXT' $$;
CREATE FUNCTION upsert_vault_secret(p_name text, p_secret text, p_description text) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER
AS $$ BEGIN INSERT INTO vault.decrypted_secrets VALUES (p_name, p_secret); RETURN gen_random_uuid(); END $$;
REVOKE ALL ON FUNCTION _enc_key(), decrypt_text(bytea), upsert_vault_secret(text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION _enc_key(), decrypt_text(bytea), upsert_vault_secret(text,text,text) TO service_role;
-- pg_net-like surface that IS executable by PUBLIC (as on the live project).
CREATE SCHEMA net; GRANT USAGE ON SCHEMA net TO PUBLIC;
CREATE TABLE net.http_request_queue (id bigserial, url text); GRANT INSERT ON net.http_request_queue TO PUBLIC; GRANT USAGE ON SEQUENCE net.http_request_queue_id_seq TO PUBLIC;
CREATE FUNCTION net.http_post(url text) RETURNS bigint LANGUAGE sql AS $$ INSERT INTO net.http_request_queue(url) VALUES (url) RETURNING id $$;

ALTER TABLE profiles ENABLE ROW LEVEL SECURITY; ALTER TABLE user_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE leave_requests ENABLE ROW LEVEL SECURITY; ALTER TABLE exception_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE push_subscriptions ENABLE ROW LEVEL SECURITY; ALTER TABLE rota_assignments ENABLE ROW LEVEL SECURITY;
-- Live policies (copied from pg_policies 2026-11-01)
CREATE POLICY "Coords/admins delete leave" ON leave_requests FOR DELETE TO authenticated USING (current_user_is_coordinator_or_admin());
CREATE POLICY "Coords/admins update any leave request" ON leave_requests FOR UPDATE TO authenticated USING (current_user_is_coordinator_or_admin()) WITH CHECK (current_user_is_coordinator_or_admin());
CREATE POLICY "Staff create own leave requests" ON leave_requests FOR INSERT TO authenticated WITH CHECK (auth.uid() = staff_id);
CREATE POLICY "Staff update own pending leave requests" ON leave_requests FOR UPDATE TO authenticated USING (auth.uid() = staff_id AND status = 'pending') WITH CHECK (auth.uid() = staff_id AND status IN ('pending','cancelled'));
CREATE POLICY "Staff view own leave, coords/admins view all" ON leave_requests FOR SELECT TO authenticated USING (auth.uid() = staff_id OR current_user_is_coordinator_or_admin());
CREATE POLICY "Admins can update any profile" ON profiles FOR UPDATE TO authenticated USING (has_role(auth.uid(),'admin')) WITH CHECK (has_role(auth.uid(),'admin'));
CREATE POLICY "Coords/admins read all profiles, staff read own" ON profiles FOR SELECT TO authenticated USING (auth.uid() = id OR current_user_is_coordinator_or_admin());
CREATE POLICY "Users can update own profile basic fields" ON profiles FOR UPDATE TO authenticated USING (auth.uid() = id) WITH CHECK (auth.uid() = id);
CREATE POLICY "Users can view own roles" ON user_roles FOR SELECT TO authenticated USING (auth.uid() = user_id OR has_role(auth.uid(),'admin'));
CREATE POLICY "Admins can read all exceptions" ON exception_reports FOR SELECT TO authenticated USING (has_role(auth.uid(),'admin'));
CREATE POLICY "Admins can update any exception" ON exception_reports FOR UPDATE TO authenticated USING (has_role(auth.uid(),'admin')) WITH CHECK (has_role(auth.uid(),'admin'));
CREATE POLICY "Coordinators can read exceptions" ON exception_reports FOR SELECT TO authenticated USING (has_role(auth.uid(),'rota_coordinator'));
CREATE POLICY "Trainees can insert own exceptions" ON exception_reports FOR INSERT TO authenticated WITH CHECK (trainee_id = auth.uid());
CREATE POLICY "Trainees can read own exceptions" ON exception_reports FOR SELECT TO authenticated USING (trainee_id = auth.uid());
CREATE POLICY "Trainees can withdraw own submitted exceptions" ON exception_reports FOR UPDATE TO authenticated USING (trainee_id = auth.uid() AND status = 'submitted') WITH CHECK (trainee_id = auth.uid() AND status IN ('submitted','withdrawn'));
CREATE POLICY "Users manage own push subscriptions" ON push_subscriptions FOR ALL TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- Synthetic people (fixed UUIDs, no real data)
INSERT INTO profiles (id, full_name, grade, active, start_date) VALUES
 ('00000000-0000-0000-0000-00000000000a','Admin A','consultant',true,'2020-01-01'),
 ('00000000-0000-0000-0000-00000000000c','Coord C','consultant',true,'2020-01-01'),
 ('00000000-0000-0000-0000-000000000051','Staff S','trainee',true,'2025-08-01'),
 ('00000000-0000-0000-0000-000000000052','Staff T','trainee',true,'2025-08-01');
INSERT INTO user_roles (user_id, role) VALUES
 ('00000000-0000-0000-0000-00000000000a','admin'),('00000000-0000-0000-0000-00000000000c','rota_coordinator'),
 ('00000000-0000-0000-0000-000000000051','staff'),('00000000-0000-0000-0000-000000000052','staff');
INSERT INTO leave_requests (id, staff_id, start_date, end_date, status) VALUES
 ('10000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000051','2027-01-04','2027-01-08','pending'),
 ('10000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000051','2027-02-01','2027-02-05','approved'),
 ('10000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-00000000000c','2027-03-01','2027-03-05','approved');
INSERT INTO exception_reports (id, trainee_id, event_date, category, description, status, due_by) VALUES
 ('20000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000051','2026-10-01','hours','synthetic description','submitted', now() + interval '7 days'),
 ('20000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-00000000000a','2026-10-01','hours','admin own report','submitted', now() + interval '7 days');
CREATE ROLE postgres SUPERUSER NOLOGIN;
-- Live pre-existing BEFORE UPDATE trigger (function body replaced by migration 0000).
CREATE FUNCTION enforce_leave_request_update_rules() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
CREATE TRIGGER trg_enforce_leave_request_update_rules BEFORE UPDATE ON leave_requests FOR EACH ROW EXECUTE FUNCTION enforce_leave_request_update_rules();
