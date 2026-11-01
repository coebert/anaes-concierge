-- Defense in depth for the audit SQL tool: force the transaction read-only
-- inside the wrapper itself instead of trusting the HTTP verb, so side-effect
-- functions reachable by PUBLIC (e.g. net.http_post) can never write.
CREATE OR REPLACE FUNCTION public.admin_run_readonly_sql(p_query text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_q text;
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'Admin role required' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM set_config('transaction_read_only', 'on', true);
  IF current_setting('transaction_read_only') <> 'on' THEN
    RAISE EXCEPTION 'admin_run_readonly_sql must run in a read-only transaction'
      USING ERRCODE = 'read_only_sql_transaction';
  END IF;
  v_q := regexp_replace(btrim(coalesce(p_query, '')), '[;\s]+$', '');
  IF v_q = '' THEN RAISE EXCEPTION 'Empty query'; END IF;
  IF position(';' in v_q) > 0 THEN RAISE EXCEPTION 'Multiple statements are not permitted'; END IF;
  RETURN audit_ro.exec_select(v_q);
END $$;
REVOKE ALL ON FUNCTION public.admin_run_readonly_sql(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_run_readonly_sql(text) TO authenticated, service_role;