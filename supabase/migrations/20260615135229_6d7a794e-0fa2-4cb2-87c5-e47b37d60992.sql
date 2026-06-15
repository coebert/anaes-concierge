CREATE OR REPLACE FUNCTION public.list_clwrota_cron_runs(p_limit integer DEFAULT 50)
RETURNS TABLE (
  jobname text,
  schedule text,
  active boolean,
  runid bigint,
  start_time timestamptz,
  end_time timestamptz,
  status text,
  return_message text,
  command text
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = 'public', 'cron'
AS $$
  SELECT
    j.jobname::text,
    j.schedule::text,
    j.active,
    r.runid,
    r.start_time,
    r.end_time,
    r.status::text,
    r.return_message::text,
    j.command::text
  FROM cron.job j
  LEFT JOIN LATERAL (
    SELECT runid, start_time, end_time, status, return_message
    FROM cron.job_run_details d
    WHERE d.jobid = j.jobid
    ORDER BY d.start_time DESC
    LIMIT LEAST(GREATEST(p_limit, 1), 200)
  ) r ON TRUE
  WHERE j.jobname LIKE 'clwrota%'
  ORDER BY j.jobname, r.start_time DESC NULLS LAST;
$$;

REVOKE ALL ON FUNCTION public.list_clwrota_cron_runs(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.list_clwrota_cron_runs(integer) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_clwrota_cron_runs(integer) TO service_role;