CREATE OR REPLACE FUNCTION public.take_request_quota(p_buckets text[], p_bytes bigint DEFAULT 0)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  b text; parts text[]; v_key text; v_win int; v_max int; v_maxb bigint; v_start timestamptz; v_hits int; v_bytes bigint;
BEGIN
  IF p_buckets IS NULL OR array_length(p_buckets, 1) IS NULL OR array_length(p_buckets, 1) > 8 THEN
    RAISE EXCEPTION 'invalid buckets' USING ERRCODE = '22023';
  END IF;
  IF p_bytes IS NULL OR p_bytes < 0 OR p_bytes > 10000000 THEN
    RAISE EXCEPTION 'invalid byte count' USING ERRCODE = '22023';
  END IF;
  FOREACH b IN ARRAY p_buckets LOOP
    -- Strict spec: key|window_seconds|max_hits|max_bytes(optional)
    IF b IS NULL OR b !~ '^[a-z0-9:._-]{1,128}\|[0-9]{1,6}\|[0-9]{1,7}\|[0-9]{0,12}$' THEN
      RAISE EXCEPTION 'invalid bucket spec' USING ERRCODE = '22023';
    END IF;
    parts := string_to_array(b, '|');
    v_key := parts[1]; v_win := parts[2]::int; v_max := parts[3]::int; v_maxb := coalesce(nullif(parts[4], '')::bigint, 0);
    IF v_win < 1 OR v_win > 604800 OR v_max < 1 THEN
      RAISE EXCEPTION 'invalid bucket limits' USING ERRCODE = '22023';
    END IF;
    v_start := to_timestamp(floor(extract(epoch FROM now()) / v_win) * v_win);
    INSERT INTO request_quota_buckets(bucket, window_start) VALUES (v_key, v_start) ON CONFLICT DO NOTHING;
    SELECT hits, bytes INTO v_hits, v_bytes FROM request_quota_buckets WHERE bucket = v_key AND window_start = v_start FOR UPDATE;
    IF v_hits + 1 > v_max OR (v_maxb > 0 AND v_bytes + p_bytes > v_maxb) THEN
      RAISE EXCEPTION 'quota_exceeded' USING ERRCODE = 'P0429';
    END IF;
    UPDATE request_quota_buckets SET hits = hits + 1, bytes = bytes + p_bytes WHERE bucket = v_key AND window_start = v_start;
  END LOOP;
  DELETE FROM request_quota_buckets WHERE window_start < now() - interval '8 days';
  RETURN true;
EXCEPTION WHEN SQLSTATE 'P0429' THEN
  RETURN false;
END $$;
REVOKE ALL ON FUNCTION public.take_request_quota(text[], bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.take_request_quota(text[], bigint) TO service_role;