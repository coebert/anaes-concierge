DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'audit_reader') THEN
    CREATE ROLE audit_reader NOLOGIN NOINHERIT BYPASSRLS;
  END IF;
END $$;
GRANT audit_reader TO postgres;

CREATE SCHEMA IF NOT EXISTS audit_ro;
REVOKE ALL ON SCHEMA audit_ro FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA audit_ro TO audit_reader;
GRANT USAGE ON SCHEMA public TO audit_reader;

-- Column-level allowlist: every public table except secret/PII/system tables,
-- and never free-text, encrypted, hashed, token or key columns.
DO $$
DECLARE r record; v_cols text;
BEGIN
  EXECUTE 'REVOKE ALL ON ALL TABLES IN SCHEMA public FROM audit_reader';
  FOR r IN
    SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'r'
       AND c.relname NOT IN ('passkey_challenges','passkey_credentials','push_subscriptions',
         'push_notification_log','ai_conversations','ai_messages','audit_assistant_memories',
         'access_requests','rpc_access_audit','rpc_access_alerts','email_inbound_log',
         'clwrota_sync_rate_limit')
  LOOP
    SELECT string_agg(quote_ident(a.attname), ', ') INTO v_cols
      FROM pg_attribute a
     WHERE a.attrelid = ('public.' || quote_ident(r.relname))::regclass
       AND a.attnum > 0 AND NOT a.attisdropped
       AND a.attname NOT IN ('email','gmc_number','reason','decision_notes','conflict_notes','notes',
         'reasonable_adjustments','comment','message','description','outcome_note','body',
         'endpoint','p256dh','auth','user_agent','content','parts','raw','raw_row','raw_source')
       AND a.attname !~ '(_enc$|_hash$|token|secret|password|key$|^key)';
    IF v_cols IS NOT NULL THEN
      EXECUTE format('GRANT SELECT (%s) ON public.%I TO audit_reader', v_cols, r.relname);
    END IF;
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION audit_ro.exec_select(p_query text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_catalog AS $$
DECLARE v jsonb;
BEGIN
  PERFORM set_config('statement_timeout', '15000', true);
  EXECUTE 'SELECT coalesce(jsonb_agg(t), ''[]''::jsonb) FROM (SELECT * FROM ('
    || p_query || ') _q LIMIT 5000) t' INTO v;
  RETURN v;
END $$;
ALTER FUNCTION audit_ro.exec_select(text) OWNER TO audit_reader;
REVOKE ALL ON FUNCTION audit_ro.exec_select(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION audit_ro.exec_select(text) TO postgres;
REVOKE CREATE ON SCHEMA audit_ro FROM audit_reader;

CREATE OR REPLACE FUNCTION public.admin_run_readonly_sql(p_query text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_q text;
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'Admin role required' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- Must be called through a read-only transaction (PostgREST GET).
  IF current_setting('transaction_read_only') <> 'on' THEN
    RAISE EXCEPTION 'admin_run_readonly_sql must run in a read-only transaction'
      USING ERRCODE = 'read_only_sql_transaction';
  END IF;
  v_q := regexp_replace(btrim(coalesce(p_query, '')), '[;\s]+$', '');
  IF v_q = '' THEN RAISE EXCEPTION 'Empty query'; END IF;
  IF position(';' in v_q) > 0 THEN RAISE EXCEPTION 'Multiple statements are not permitted'; END IF;
  -- Executes as the restricted audit_reader role: no secrets, vault, auth,
  -- extensions, decrypt/encrypt helpers or write privileges.
  RETURN audit_ro.exec_select(v_q);
END $$;
REVOKE ALL ON FUNCTION public.admin_run_readonly_sql(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_run_readonly_sql(text) TO authenticated, service_role;
