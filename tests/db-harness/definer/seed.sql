-- Synthetic people and encrypted rows (no real data). Run as postgres.
-- Live ACLs for the functions loaded from live-functions.sql.
REVOKE ALL ON FUNCTION public._is_active_member_profile(uuid), public.decrypt_text(bytea), public.decrypt_jsonb(bytea),
  public.log_rpc_access(text,integer,jsonb), public.decrypt_ai_message_parts(bytea,uuid), public.decrypt_owner_or_coord(bytea,uuid),
  public.decrypt_coord_only(bytea), public.admin_decrypt_text(bytea), public.admin_decrypt_jsonb(bytea),
  public.detect_rpc_access_anomalies(integer,integer), public.get_ai_messages_decrypted(uuid), public.get_competency_eligibility(date),
  public.get_rtw_interviews_decrypted(), public.list_clwrota_cron_runs(integer), public.trigger_clwrota_sync(text),
  public.trigger_clwrota_sync_rate_limited(text), public.trigger_clwrota_sync_with_query(text,text),
  public.trigger_clwrota_sync_all_rate_limited(), public.has_role(uuid,app_role), public.current_user_is_coordinator_or_admin() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public._is_active_member_profile(uuid), public.decrypt_text(bytea), public.decrypt_jsonb(bytea),
  public.log_rpc_access(text,integer,jsonb), public.decrypt_ai_message_parts(bytea,uuid), public.decrypt_owner_or_coord(bytea,uuid),
  public.decrypt_coord_only(bytea), public.admin_decrypt_text(bytea), public.admin_decrypt_jsonb(bytea) TO service_role;
GRANT EXECUTE ON FUNCTION public.detect_rpc_access_anomalies(integer,integer), public.get_ai_messages_decrypted(uuid),
  public.get_competency_eligibility(date), public.get_rtw_interviews_decrypted(), public.list_clwrota_cron_runs(integer),
  public.trigger_clwrota_sync(text), public.trigger_clwrota_sync_rate_limited(text), public.trigger_clwrota_sync_with_query(text,text),
  public.trigger_clwrota_sync_all_rate_limited(), public.has_role(uuid,app_role), public.current_user_is_coordinator_or_admin()
  TO authenticated, service_role;

-- A/B staff, C coordinator, D admin, E inactive admin, I inactive staff,
-- R roleless (active profile, no role), M role but missing profile.
INSERT INTO public.profiles (id, full_name, grade, active, left_at) VALUES
 ('00000000-0000-0000-0000-0000000000a1','Synthetic Staff A','trainee',true,NULL),
 ('00000000-0000-0000-0000-0000000000b2','Synthetic Staff B','trainee',true,NULL),
 ('00000000-0000-0000-0000-0000000000c3','Synthetic Coord C','consultant',true,NULL),
 ('00000000-0000-0000-0000-0000000000d4','Synthetic Admin D','consultant',true,NULL),
 ('00000000-0000-0000-0000-0000000000e5','Synthetic Inactive Admin E','consultant',false,NULL),
 ('00000000-0000-0000-0000-0000000000e7','Synthetic Inactive Staff I','trainee',true,'2026-01-01'),
 ('00000000-0000-0000-0000-0000000000f6','Synthetic Roleless R','trainee',true,NULL);
INSERT INTO public.user_roles (user_id, role) VALUES
 ('00000000-0000-0000-0000-0000000000a1','staff'), ('00000000-0000-0000-0000-0000000000b2','staff'),
 ('00000000-0000-0000-0000-0000000000c3','rota_coordinator'), ('00000000-0000-0000-0000-0000000000d4','admin'),
 ('00000000-0000-0000-0000-0000000000e5','admin'), ('00000000-0000-0000-0000-0000000000e7','staff'),
 ('00000000-0000-0000-0000-0000000000e8','staff');
INSERT INTO public.ai_conversations VALUES
 ('60000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000a1'),
 ('60000000-0000-0000-0000-0000000000b2','00000000-0000-0000-0000-0000000000b2'),
 ('60000000-0000-0000-0000-0000000000e7','00000000-0000-0000-0000-0000000000e7');
INSERT INTO public.ai_messages (conversation_id, user_id, role, parts_enc) VALUES
 ('60000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000a1','user', extensions.pgp_sym_encrypt('{"t":"A-secret"}','synthetic-key')),
 ('60000000-0000-0000-0000-0000000000b2','00000000-0000-0000-0000-0000000000b2','user', extensions.pgp_sym_encrypt('{"t":"B-secret"}','synthetic-key')),
 ('60000000-0000-0000-0000-0000000000e7','00000000-0000-0000-0000-0000000000e7','user', extensions.pgp_sym_encrypt('{"t":"I-secret"}','synthetic-key'));
INSERT INTO public.return_to_work_interviews (staff_id, notes_enc) VALUES
 ('00000000-0000-0000-0000-0000000000a1', extensions.pgp_sym_encrypt('A-rtw','synthetic-key')),
 ('00000000-0000-0000-0000-0000000000b2', extensions.pgp_sym_encrypt('B-rtw','synthetic-key')),
 ('00000000-0000-0000-0000-0000000000e7', extensions.pgp_sym_encrypt('I-rtw','synthetic-key'));
