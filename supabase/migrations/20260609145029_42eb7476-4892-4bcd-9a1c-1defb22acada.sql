CREATE OR REPLACE FUNCTION public.admin_run_readonly_sql(p_query text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_result jsonb;
  v_lower text;
  v_wrapped text;
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'Admin role required' USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_query IS NULL OR btrim(p_query) = '' THEN
    RAISE EXCEPTION 'Empty query';
  END IF;

  v_lower := lower(btrim(p_query));
  -- strip trailing semicolon(s) and whitespace
  v_lower := regexp_replace(v_lower, '[;\s]+$', '');

  IF v_lower !~ '^(select|with)\s' THEN
    RAISE EXCEPTION 'Only SELECT or WITH queries are permitted';
  END IF;

  IF position(';' in v_lower) > 0 THEN
    RAISE EXCEPTION 'Multiple statements are not permitted';
  END IF;

  IF v_lower ~ '\m(insert|update|delete|drop|alter|truncate|grant|revoke|comment|copy|vacuum|analyze|reindex|cluster|listen|notify|do|call|merge|refresh)\M'
     OR v_lower ~ '\mcreate\s+(table|function|view|index|materialized|trigger|role|policy|schema|extension)\M'
     OR v_lower ~ '\mset\s+(role|session|local)\M'
     OR v_lower ~ '\mreset\s+role\M'
     OR v_lower ~ '\msecurity\s+definer\M'
     OR v_lower ~ '\mpg_(read_server_files|write_server_files|execute_server_program|sleep)\M'
  THEN
    RAISE EXCEPTION 'Forbidden keyword detected in query';
  END IF;

  -- Cap runtime to 15 seconds for this transaction
  PERFORM set_config('statement_timeout', '15000', true);

  -- Wrap with a 5000-row cap to protect the browser/UI
  v_wrapped := 'SELECT coalesce(jsonb_agg(t), ''[]''::jsonb) FROM (SELECT * FROM ('
    || p_query
    || ') _q LIMIT 5000) t';

  EXECUTE v_wrapped INTO v_result;
  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_run_readonly_sql(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_run_readonly_sql(text) TO authenticated;