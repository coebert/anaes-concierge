-- Audit SQL tool: replace the computed column DENYLIST (which let new or
-- unforeseen columns such as source_row / details / *_report_url through) with
-- an explicit, reviewed table+column ALLOWLIST. Anything not listed is
-- unreadable by audit_reader, including future columns.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM audit_reader;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM audit_reader;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM audit_reader;

CREATE TABLE IF NOT EXISTS audit_ro.column_allowlist (
  table_name text NOT NULL,
  column_name text NOT NULL,
  PRIMARY KEY (table_name, column_name)
);
REVOKE ALL ON audit_ro.column_allowlist FROM PUBLIC;

INSERT INTO audit_ro.column_allowlist (table_name, column_name)
SELECT t, unnest(c) FROM (VALUES
 ('profiles', ARRAY['id','full_name','grade','training_level','start_date','active','rotation_end_date','ltft_days_off','left_at','created_at','updated_at']),
 ('user_roles', ARRAY['id','user_id','role','created_at']),
 ('rota_assignments', ARRAY['id','session_date','session','staff_id','theatre_session_id','role_on_list','supervisor_id','source','duty_type','locally_modified','is_non_sag','extra_type','pa_credit','attending_consultant_ids','created_at','updated_at']),
 ('theatre_sessions', ARRAY['id','session_date','theatre_id','session','specialty_id','surgical_consultant','is_non_sag','non_sag_override','created_at','updated_at']),
 ('theatres', ARRAY['id','name','kind','sort_order','active','created_at']),
 ('theatre_name_aliases', ARRAY['id','alias','theatre_id','active','created_at','updated_at']),
 ('specialties', ARRAY['id','name','is_trainee_bucket','created_at']),
 ('leave_requests', ARRAY['id','staff_id','type','start_date','end_date','half_day_start','half_day_end','status','decided_by','decided_at','created_at','updated_at','reserve_listed_at','study_cost_gbp']),
 ('leave_allowances', ARRAY['id','staff_id','leave_year_start','annual_days','study_days','professional_days','carers_days','parental_days','compassionate_days','ltft_fraction','carry_over_days','sla_target_days','study_budget_gbp','created_at','updated_at']),
 ('leave_change_log', ARRAY['id','leave_request_id','staff_id','action','prev_status','new_status','prev_start_date','new_start_date','prev_end_date','new_end_date','prev_type','new_type','changed_by','changed_at']),
 ('leave_ledger_entries', ARRAY['id','staff_id','entry_date','kind','hours','related_leave_request_id','created_by','created_at','updated_at']),
 ('job_plans', ARRAY['id','staff_id','total_pas','dcc_pas','spa_pas','ltft','ltft_percentage','on_call_commitment','valid_from','valid_to','created_at','updated_at']),
 ('fixed_sessions', ARRAY['id','staff_id','day_of_week','session','theatre_id','created_at']),
 ('rota_rules', ARRAY['id','sessions_per_pa','default_dcc_pas','default_spa_pas','default_total_pas','max_sessions_per_week','max_consecutive_days','min_rest_hours','oncall_pa_credit','weekend_pa_credit','ltft_round_to','honour_fixed_sessions','allow_back_to_back_oncall','post_nights_off_days','trainee_at_risk_pct','trainee_behind_pct','updated_at','updated_by']),
 ('rota_change_log', ARRAY['id','assignment_id','action','session_date','session','staff_id','session_start_ts','changed_at','hours_before_session','changed_by','prev_theatre_session_id','new_theatre_session_id','prev_staff_id']),
 ('rota_reclassification_log', ARRAY['id','sync_run_id','assignment_id','from_role','to_role','created_at']),
 ('exception_reports', ARRAY['id','trainee_id','event_date','event_session','category','immediate_safety_concern','hours_worked_extra','rest_missed_hours','status','outcome','responder_id','acknowledged_at','resolved_at','due_by','created_at','updated_at']),
 ('competencies', ARRAY['id','code','name','category','applies_to_grades','active','sort_order','created_at','updated_at']),
 ('staff_competencies', ARRAY['id','staff_id','competency_id','level','granted_at','expires_at','granted_by','revoked_at','created_at','updated_at']),
 ('specialty_competency_requirements', ARRAY['id','specialty_id','competency_id','requirement','applies_to_role','created_at','updated_at']),
 ('staff_specialty_preferences', ARRAY['id','staff_id','specialty_id','preference','created_at','updated_at']),
 ('staff_practice_preferences', ARRAY['staff_id','covers_obstetrics','covers_paediatrics','covers_cleft_palate','created_at','updated_at']),
 ('educational_supervisor_assignments', ARRAY['id','trainee_id','supervisor_id','valid_from','valid_to','created_at','updated_at']),
 ('trainee_targets', ARRAY['id','training_level','specialty_id','required_sessions','required_solo','required_supervised','created_at']),
 ('arcp_requirements', ARRAY['id','training_level','code','label','category','target_value','unit','sort_order','active','created_at','updated_at']),
 ('arcp_progress', ARRAY['id','trainee_id','requirement_id','current_value','arcp_date','last_reviewed_at','updated_by','created_at','updated_at']),
 ('duty_type_mappings', ARRAY['id','duty_type','pattern','match_type','grade_filter','trainee_seniority_filter','priority','active','created_at','updated_at']),
 ('duty_type_pool_rules', ARRAY['duty_type','category','created_at','updated_at']),
 ('icu_detection_matches', ARRAY['id','assignment_id','staff_id','session_date','session','duty_type','matched_field','pa_credit','attending_consultant_ids','detected_by','detected_at','created_at','updated_at']),
 ('tutorial_detection_matches', ARRAY['id','assignment_id','staff_id','session_date','session','matched_field','detected_by','detected_at','created_at','updated_at']),
 ('icu_sync_runs', ARRAY['id','window_start','window_end','source_count','audit_count','traces_written','diverged','ok','duration_ms','created_at']),
 ('tutorial_audit_runs', ARRAY['id','window_start','window_end','source_count','audit_count','promoted_to_teaching','notes_updated','diverged','ok','created_at']),
 ('icu_audit_alerts', ARRAY['id','run_id','window_start','window_end','source_count','audit_count','acknowledged_at','acknowledged_by','created_at']),
 ('tutorial_audit_alerts', ARRAY['id','run_id','window_start','window_end','source_count','audit_count','acknowledged_at','acknowledged_by','created_at']),
 ('clwrota_sync_metrics', ARRAY['id','sync_kind','run_at','ok','duration_ms','rows_pulled','rows_drafted','rows_upserted','rows_failed','rows_skipped_validation','chunks_total','chunks_succeeded_first_try','chunks_succeeded_after_retry','chunks_fell_back_to_per_row','per_row_attempts','per_row_succeeded','per_row_failed','upsert_attempts_total','upsert_retries_total','errors_count','is_backfill','rows_deleted','non_working_cleaned']),
 ('clwrota_sync_state', ARRAY['id','last_sync_at','last_status','last_pulled_rows','sync_days_back','sync_days_ahead','auto_reclassify_trainee_solo','last_successful_rota_sync_at','incremental_days_back','incremental_days_ahead']),
 ('pulse_survey_cycles', ARRAY['id','opens_at','closes_at','question_1','question_2','question_3','active','created_at','updated_at']),
 ('daily_digest_log', ARRAY['id','staff_id','digest_date','status','created_at'])
) AS v(t, c)
ON CONFLICT DO NOTHING;

-- Grant exactly the allowlisted columns that exist. A listed column that is
-- absent is skipped (the list can only narrow access, never widen it).
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT a.table_name, string_agg(quote_ident(a.column_name), ', ') AS cols
      FROM audit_ro.column_allowlist a
      JOIN information_schema.columns c
        ON c.table_schema = 'public' AND c.table_name = a.table_name AND c.column_name = a.column_name
     GROUP BY a.table_name
  LOOP
    EXECUTE format('GRANT SELECT (%s) ON public.%I TO audit_reader', r.cols, r.table_name);
  END LOOP;
END $$;

-- Wrapper: defense-in-depth screen also rejects Unicode-escaped identifiers
-- (U&"..."), which could otherwise disguise blocked function names. The real
-- boundary is still: restricted role + forced read-only transaction + the
-- caller role's statement_timeout (authenticated = 8s), which a mid-statement
-- set_config cannot disarm.
CREATE OR REPLACE FUNCTION public.admin_run_readonly_sql(p_query text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_q text;
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'Admin role required' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM set_config('transaction_read_only', 'on', true);
  PERFORM set_config('statement_timeout', '8000', true);
  PERFORM set_config('lock_timeout', '1000', true);
  PERFORM set_config('idle_in_transaction_session_timeout', '10000', true);
  IF current_setting('transaction_read_only') <> 'on' THEN
    RAISE EXCEPTION 'admin_run_readonly_sql must run in a read-only transaction' USING ERRCODE = 'read_only_sql_transaction';
  END IF;
  v_q := regexp_replace(btrim(coalesce(p_query, '')), '[;\s]+$', '');
  IF v_q = '' THEN RAISE EXCEPTION 'Empty query'; END IF;
  IF length(v_q) > 8000 THEN RAISE EXCEPTION 'Query too long'; END IF;
  IF position(';' in v_q) > 0 THEN RAISE EXCEPTION 'Multiple statements are not permitted'; END IF;
  IF v_q ~* '(\mu&|set_config|pg_sleep|dblink|lo_import|lo_export|pg_notify|"?net"?\s*\.|worker_restart|\mwake\M|pg_terminate|pg_cancel|pg_reload|exec_select|admin_run_readonly_sql|audit_ro)' THEN
    RAISE EXCEPTION 'Query uses a function that is not available to audit reports';
  END IF;
  RETURN audit_ro.exec_select(v_q);
END $$;
REVOKE ALL ON FUNCTION public.admin_run_readonly_sql(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_run_readonly_sql(text) TO authenticated, service_role;
