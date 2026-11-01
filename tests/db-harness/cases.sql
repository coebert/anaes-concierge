\set ON_ERROR_STOP on
CREATE TABLE IF NOT EXISTS results (name text, expected text, actual text, detail text);
CREATE OR REPLACE FUNCTION t(p_name text, p_uid text, p_sql text, p_expect text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_actual text; v_err text;
BEGIN
  BEGIN
    PERFORM set_config('request.jwt.claim.sub', coalesce(p_uid, ''), true);
    IF p_uid IS NULL THEN SET LOCAL ROLE service_role; ELSE SET LOCAL ROLE authenticated; END IF;
    EXECUTE p_sql;
    RAISE EXCEPTION 'HARNESS_ROLLBACK_OK';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM = 'HARNESS_ROLLBACK_OK' THEN v_actual := 'allowed'; ELSE v_actual := 'denied'; v_err := SQLERRM; END IF;
  END;
  PERFORM set_config('request.jwt.claim.sub', '', true);
  INSERT INTO results VALUES (p_name, p_expect, v_actual, v_err);
END $$;
-- Assertion helper usable inside p_sql: raise unless condition true
CREATE OR REPLACE FUNCTION assert_true(c boolean, msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF c IS NOT TRUE THEN RAISE EXCEPTION 'ASSERT FAILED: %', msg; END IF; END $$;
GRANT EXECUTE ON FUNCTION assert_true(boolean,text) TO authenticated, service_role;

\set S '''00000000-0000-0000-0000-000000000051'''
\set T '''00000000-0000-0000-0000-000000000052'''
\set C '''00000000-0000-0000-0000-00000000000c'''
\set A '''00000000-0000-0000-0000-00000000000a'''

-- 1. Leave requests
SELECT t('leave: staff inserts own pending', :S, $q$INSERT INTO leave_requests(staff_id,start_date,end_date) VALUES ('00000000-0000-0000-0000-000000000051','2027-05-01','2027-05-02')$q$, 'allowed');
SELECT t('leave: staff inserts pre-approved', :S, $q$INSERT INTO leave_requests(staff_id,start_date,end_date,status) VALUES ('00000000-0000-0000-0000-000000000051','2027-05-01','2027-05-02','approved')$q$, 'denied');
SELECT t('leave: staff forges decided_by on insert', :S, $q$INSERT INTO leave_requests(staff_id,start_date,end_date,decided_by,decided_at) VALUES ('00000000-0000-0000-0000-000000000051','2027-05-01','2027-05-02','00000000-0000-0000-0000-00000000000a',now())$q$, 'denied');
SELECT t('leave: staff inserts for another person', :S, $q$INSERT INTO leave_requests(staff_id,start_date,end_date) VALUES ('00000000-0000-0000-0000-000000000052','2027-05-01','2027-05-02')$q$, 'denied');
SELECT t('leave: coordinator inserts self-approved own leave', :C, $q$INSERT INTO leave_requests(staff_id,start_date,end_date,status) VALUES ('00000000-0000-0000-0000-00000000000c','2027-05-01','2027-05-02','approved')$q$, 'denied');
SELECT t('leave: coordinator inserts leave for another person (live INSERT policy is owner-only)', :C, $q$INSERT INTO leave_requests(id,staff_id,start_date,end_date,status,decided_by) VALUES ('10000000-0000-0000-0000-0000000000ff','00000000-0000-0000-0000-000000000051','2027-05-01','2027-05-02','approved','00000000-0000-0000-0000-00000000000a'); SELECT assert_true((SELECT decided_by FROM leave_requests WHERE id='10000000-0000-0000-0000-0000000000ff') = '00000000-0000-0000-0000-00000000000c', 'decided_by actor')$q$, 'denied');
SELECT t('leave: trusted import (service role) can insert approved', NULL, $q$INSERT INTO leave_requests(staff_id,start_date,end_date,status,clwrota_external_id) VALUES ('00000000-0000-0000-0000-000000000051','2027-05-01','2027-05-02','approved','ext-1')$q$, 'allowed');
SELECT t('leave: staff edits own pending dates', :S, $q$UPDATE leave_requests SET end_date='2027-01-09' WHERE id='10000000-0000-0000-0000-000000000001'; SELECT assert_true((SELECT end_date FROM leave_requests WHERE id='10000000-0000-0000-0000-000000000001')='2027-01-09','updated')$q$, 'allowed');
SELECT t('leave: staff cancels own pending', :S, $q$UPDATE leave_requests SET status='cancelled' WHERE id='10000000-0000-0000-0000-000000000001'; SELECT assert_true((SELECT status FROM leave_requests WHERE id='10000000-0000-0000-0000-000000000001')='cancelled','cancelled')$q$, 'allowed');
SELECT t('leave: staff self-approves pending', :S, $q$UPDATE leave_requests SET status='approved' WHERE id='10000000-0000-0000-0000-000000000001'$q$, 'denied');
SELECT t('leave: staff rewrites approved leave dates (RLS no-op => assert unchanged)', :S, $q$UPDATE leave_requests SET end_date='2027-02-20' WHERE id='10000000-0000-0000-0000-000000000002'; SELECT assert_true((SELECT end_date FROM leave_requests WHERE id='10000000-0000-0000-0000-000000000002')='2027-02-20','changed')$q$, 'denied');
SELECT t('leave: coordinator-owner rewrites own APPROVED dates', :C, $q$UPDATE leave_requests SET end_date='2027-03-20' WHERE id='10000000-0000-0000-0000-000000000003'$q$, 'denied');
SELECT t('leave: coordinator-owner cancels own approved leave', :C, $q$UPDATE leave_requests SET status='cancelled' WHERE id='10000000-0000-0000-0000-000000000003'$q$, 'allowed');
SELECT t('leave: coordinator approves staff leave; decided_by forced', :C, $q$UPDATE leave_requests SET status='approved', decided_by='00000000-0000-0000-0000-00000000000a' WHERE id='10000000-0000-0000-0000-000000000001'; SELECT assert_true((SELECT decided_by FROM leave_requests WHERE id='10000000-0000-0000-0000-000000000001')='00000000-0000-0000-0000-00000000000c','actor')$q$, 'allowed');
SELECT t('leave: coordinator forges decided_by without status change', :C, $q$UPDATE leave_requests SET decided_by='00000000-0000-0000-0000-00000000000a' WHERE id='10000000-0000-0000-0000-000000000002'$q$, 'denied');

-- 2. Profiles
SELECT t('profile: staff changes own display name', :S, $q$UPDATE profiles SET full_name='Dr S' WHERE id='00000000-0000-0000-0000-000000000051'; SELECT assert_true((SELECT full_name FROM profiles WHERE id='00000000-0000-0000-0000-000000000051')='Dr S','name')$q$, 'allowed');
SELECT t('profile: staff sets own calendar token (server-owned)', :S, $q$UPDATE profiles SET calendar_feed_token='x' WHERE id='00000000-0000-0000-0000-000000000051'$q$, 'denied');
SELECT t('profile: staff changes own grade', :S, $q$UPDATE profiles SET grade='consultant' WHERE id='00000000-0000-0000-0000-000000000051'$q$, 'denied');
SELECT t('profile: staff reactivates/changes active', :S, $q$UPDATE profiles SET active=false WHERE id='00000000-0000-0000-0000-000000000051'$q$, 'denied');
SELECT t('profile: staff changes rotation_end_date', :S, $q$UPDATE profiles SET rotation_end_date='2030-01-01' WHERE id='00000000-0000-0000-0000-000000000051'$q$, 'denied');
SELECT t('profile: staff changes clwrota_external_id', :S, $q$UPDATE profiles SET clwrota_external_id='hijack' WHERE id='00000000-0000-0000-0000-000000000051'$q$, 'denied');
SELECT t('profile: staff changes email (identity merge key)', :S, $q$UPDATE profiles SET email='victim@example.invalid' WHERE id='00000000-0000-0000-0000-000000000051'$q$, 'denied');
SELECT t('profile: coordinator changes own grade', :C, $q$UPDATE profiles SET grade='sas' WHERE id='00000000-0000-0000-0000-00000000000c'$q$, 'denied');
SELECT t('profile: staff edits another profile (RLS no-op => assert unchanged)', :S, $q$UPDATE profiles SET full_name='X' WHERE id='00000000-0000-0000-0000-000000000052'; SET LOCAL ROLE service_role; SELECT assert_true((SELECT full_name FROM profiles WHERE id='00000000-0000-0000-0000-000000000052')='X','changed')$q$, 'denied');
SELECT t('profile: admin edits staff employment fields', :A, $q$UPDATE profiles SET grade='sas', active=false, rotation_end_date='2027-08-01' WHERE id='00000000-0000-0000-0000-000000000051'; SELECT assert_true((SELECT grade FROM profiles WHERE id='00000000-0000-0000-0000-000000000051')='sas','admin edit')$q$, 'allowed');
SELECT t('profile: CLWRota sync (service role) updates import fields', NULL, $q$UPDATE profiles SET clwrota_external_id='ext-9', start_date='2025-09-01' WHERE id='00000000-0000-0000-0000-000000000051'$q$, 'allowed');

-- 3. Exception reports
SELECT t('exception: trainee submits; due_by computed server-side', :S, $q$INSERT INTO exception_reports(id,trainee_id,event_date,category,description,due_by) VALUES ('20000000-0000-0000-0000-0000000000ff','00000000-0000-0000-0000-000000000051','2026-10-02','hours','synthetic','2099-01-01'); SELECT assert_true((SELECT due_by FROM exception_reports WHERE id='20000000-0000-0000-0000-0000000000ff') < now() + interval '8 days','due_by')$q$, 'allowed');
SELECT t('exception: trainee submits pre-resolved', :S, $q$INSERT INTO exception_reports(trainee_id,event_date,category,description,status,outcome,resolved_at) VALUES ('00000000-0000-0000-0000-000000000051','2026-10-02','hours','synthetic','resolved','payment',now())$q$, 'denied');
SELECT t('exception: trainee forges responder on insert', :S, $q$INSERT INTO exception_reports(trainee_id,event_date,category,description,responder_id) VALUES ('00000000-0000-0000-0000-000000000051','2026-10-02','hours','synthetic','00000000-0000-0000-0000-00000000000a')$q$, 'denied');
SELECT t('exception: trainee withdraws own submitted', :S, $q$UPDATE exception_reports SET status='withdrawn' WHERE id='20000000-0000-0000-0000-000000000001'; SELECT assert_true((SELECT status FROM exception_reports WHERE id='20000000-0000-0000-0000-000000000001')='withdrawn','withdrawn')$q$, 'allowed');
SELECT t('exception: trainee sets acknowledged_at/outcome on own', :S, $q$UPDATE exception_reports SET acknowledged_at=now(), outcome='payment' WHERE id='20000000-0000-0000-0000-000000000001'$q$, 'denied');
SELECT t('exception: trainee extends own due_by', :S, $q$UPDATE exception_reports SET due_by=now()+interval '1 year' WHERE id='20000000-0000-0000-0000-000000000001'$q$, 'denied');
SELECT t('exception: admin acknowledges; responder & time server-derived', :A, $q$UPDATE exception_reports SET status='acknowledged', acknowledged_at='2000-01-01', responder_id='00000000-0000-0000-0000-00000000000a' WHERE id='20000000-0000-0000-0000-000000000001'; SELECT assert_true((SELECT acknowledged_at > now() - interval '1 minute' FROM exception_reports WHERE id='20000000-0000-0000-0000-000000000001'),'ack now')$q$, 'allowed');
SELECT t('exception: admin resolves with outcome', :A, $q$UPDATE exception_reports SET status='resolved', outcome='toil' WHERE id='20000000-0000-0000-0000-000000000001'; SELECT assert_true((SELECT resolved_at IS NOT NULL FROM exception_reports WHERE id='20000000-0000-0000-0000-000000000001'),'resolved_at')$q$, 'allowed');
SELECT t('exception: admin resolves without outcome', :A, $q$UPDATE exception_reports SET status='resolved' WHERE id='20000000-0000-0000-0000-000000000001'$q$, 'denied');
SELECT t('exception: admin sets responder to someone else', :A, $q$UPDATE exception_reports SET responder_id='00000000-0000-0000-0000-00000000000c' WHERE id='20000000-0000-0000-0000-000000000001'$q$, 'denied');
SELECT t('exception: admin rewrites trainee description', :A, $q$UPDATE exception_reports SET description='edited by reviewer' WHERE id='20000000-0000-0000-0000-000000000001'$q$, 'denied');
SELECT t('exception: admin self-reviews own report', :A, $q$UPDATE exception_reports SET status='resolved', outcome='payment' WHERE id='20000000-0000-0000-0000-000000000002'$q$, 'denied');
SELECT t('exception: coordinator (read-only role) updates (RLS no-op => assert unchanged)', :C, $q$UPDATE exception_reports SET status='acknowledged' WHERE id='20000000-0000-0000-0000-000000000001'; SELECT assert_true((SELECT status FROM exception_reports WHERE id='20000000-0000-0000-0000-000000000001')='acknowledged','changed')$q$, 'denied');

-- 5. Push subscriptions (direct REST-equivalent writes)
\set K '''Baaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'''
SELECT t('push: valid FCM endpoint', :S, format($q$INSERT INTO push_subscriptions(user_id,endpoint,p256dh,auth) VALUES ('00000000-0000-0000-0000-000000000051','https://fcm.googleapis.com/fcm/send/abc',%s,'cccccccccccccccccccccc')$q$, quote_literal(:K)), 'allowed');
SELECT t('push: valid Apple endpoint', :S, format($q$INSERT INTO push_subscriptions(user_id,endpoint,p256dh,auth) VALUES ('00000000-0000-0000-0000-000000000051','https://web.push.apple.com/QGd9',%s,'cccccccccccccccccccccc')$q$, quote_literal(:K)), 'allowed');
SELECT t('push: internal metadata IP endpoint', :S, format($q$INSERT INTO push_subscriptions(user_id,endpoint,p256dh,auth) VALUES ('00000000-0000-0000-0000-000000000051','https://169.254.169.254/latest',%s,'cccccccccccccccccccccc')$q$, quote_literal(:K)), 'denied');
SELECT t('push: userinfo pivot', :S, format($q$INSERT INTO push_subscriptions(user_id,endpoint,p256dh,auth) VALUES ('00000000-0000-0000-0000-000000000051','https://fcm.googleapis.com@evil.example/x',%s,'cccccccccccccccccccccc')$q$, quote_literal(:K)), 'denied');
SELECT t('push: custom port', :S, format($q$INSERT INTO push_subscriptions(user_id,endpoint,p256dh,auth) VALUES ('00000000-0000-0000-0000-000000000051','https://fcm.googleapis.com:8443/x',%s,'cccccccccccccccccccccc')$q$, quote_literal(:K)), 'denied');
SELECT t('push: http scheme', :S, format($q$INSERT INTO push_subscriptions(user_id,endpoint,p256dh,auth) VALUES ('00000000-0000-0000-0000-000000000051','http://fcm.googleapis.com/x',%s,'cccccccccccccccccccccc')$q$, quote_literal(:K)), 'denied');
SELECT t('push: lookalike host', :S, format($q$INSERT INTO push_subscriptions(user_id,endpoint,p256dh,auth) VALUES ('00000000-0000-0000-0000-000000000051','https://fcm.googleapis.com.evil.example/x',%s,'cccccccccccccccccccccc')$q$, quote_literal(:K)), 'denied');
SELECT t('push: oversized auth key', :S, format($q$INSERT INTO push_subscriptions(user_id,endpoint,p256dh,auth) VALUES ('00000000-0000-0000-0000-000000000051','https://fcm.googleapis.com/fcm/send/abc',%s,repeat('c',500))$q$, quote_literal(:K)), 'denied');
SELECT t('push: service role cannot bypass endpoint check', NULL, format($q$INSERT INTO push_subscriptions(user_id,endpoint,p256dh,auth) VALUES ('00000000-0000-0000-0000-000000000051','https://127.0.0.1/x',%s,'cccccccccccccccccccccc')$q$, quote_literal(:K)), 'denied');

-- 6. Follow-up: trigger ordering vs encryption, shadow fields, view path
SELECT t('leave-enc: guard trigger sorts before encryption trigger', NULL, $q$SELECT assert_true((SELECT array_agg(tgname::text ORDER BY tgname) FROM pg_trigger WHERE tgrelid='leave_requests'::regclass AND NOT tgisinternal AND tgname IN ('a10_enforce_leave_request_update_rules','leave_requests_sync_encryption')) = ARRAY['a10_enforce_leave_request_update_rules','leave_requests_sync_encryption'],'order')$q$, 'allowed');
SELECT t('leave-enc: staff forges conflict_notes on own pending (plaintext)', :S, $q$UPDATE leave_requests SET conflict_notes='forged' WHERE id='10000000-0000-0000-0000-000000000001'$q$, 'denied');
SELECT t('leave-enc: staff forges conflict ciphertext only stays unchanged', :S, $q$UPDATE leave_requests SET conflict_notes_enc=convert_to('ENC:forged','UTF8') WHERE id='10000000-0000-0000-0000-000000000001'$q$, 'denied');
SELECT t('leave-enc: staff writes reason_enc directly', :S, $q$UPDATE leave_requests SET reason_enc=convert_to('x','UTF8') WHERE id='10000000-0000-0000-0000-000000000001'$q$, 'denied');
SELECT t('leave-enc: staff inserts with decision_notes_enc', :S, $q$INSERT INTO leave_requests(staff_id,start_date,end_date,decision_notes_enc) VALUES ('00000000-0000-0000-0000-000000000051','2027-06-01','2027-06-02',convert_to('ENC:approved by admin','UTF8'))$q$, 'denied');
SELECT t('leave-enc: staff edits own pending reason, ciphertext re-encrypted', :S, $q$UPDATE leave_requests SET reason='new reason' WHERE id='10000000-0000-0000-0000-000000000001'; SELECT assert_true((SELECT convert_from(reason_enc,'UTF8') FROM leave_requests WHERE id='10000000-0000-0000-0000-000000000001')='ENC:new reason','re-encrypted')$q$, 'allowed');
SELECT t('leave-enc: insert encrypts reason and conflict notes', :S, $q$INSERT INTO leave_requests(id,staff_id,start_date,end_date,reason,conflict_notes) VALUES ('10000000-0000-0000-0000-0000000000ee','00000000-0000-0000-0000-000000000051','2027-06-01','2027-06-02','r1','c1'); SELECT assert_true((SELECT convert_from(conflict_notes_enc,'UTF8') FROM leave_requests WHERE id='10000000-0000-0000-0000-0000000000ee')='ENC:c1','enc')$q$, 'allowed');
SELECT t('leave-enc: staff backdates created_at', :S, $q$UPDATE leave_requests SET created_at='2020-01-01' WHERE id='10000000-0000-0000-0000-000000000001'$q$, 'denied');
SELECT t('leave-enc: insert created_at forced to now', :S, $q$INSERT INTO leave_requests(id,staff_id,start_date,end_date,created_at) VALUES ('10000000-0000-0000-0000-0000000000ed','00000000-0000-0000-0000-000000000051','2027-06-01','2027-06-02','2020-01-01'); SELECT assert_true((SELECT created_at > now() - interval '1 minute' FROM leave_requests WHERE id='10000000-0000-0000-0000-0000000000ed'),'now')$q$, 'allowed');
SELECT t('leave-enc: staff sets own study_cost_gbp', :S, $q$UPDATE leave_requests SET study_cost_gbp=1 WHERE id='10000000-0000-0000-0000-000000000001'$q$, 'denied');
SELECT t('leave-enc: coordinator sets study cost on staff leave', :C, $q$UPDATE leave_requests SET study_cost_gbp=250 WHERE id='10000000-0000-0000-0000-000000000002'$q$, 'allowed');
SELECT t('leave-enc: coordinator edits conflict notes, re-encrypted', :C, $q$UPDATE leave_requests SET conflict_notes='coord note' WHERE id='10000000-0000-0000-0000-000000000002'; SELECT assert_true((SELECT convert_from(conflict_notes_enc,'UTF8') FROM leave_requests WHERE id='10000000-0000-0000-0000-000000000002')='ENC:coord note','enc')$q$, 'allowed');
SELECT t('leave-enc: coordinator changes clwrota_external_id', :C, $q$UPDATE leave_requests SET clwrota_external_id='hijack' WHERE id='10000000-0000-0000-0000-000000000002'$q$, 'denied');
SELECT t('leave-enc: coordinator reassigns leave owner', :C, $q$UPDATE leave_requests SET staff_id='00000000-0000-0000-0000-000000000052' WHERE id='10000000-0000-0000-0000-000000000002'$q$, 'denied');
SELECT t('leave-view: staff self-approves via leave_requests_v', :S, $q$UPDATE leave_requests_v SET status='approved' WHERE id='10000000-0000-0000-0000-000000000001'$q$, 'denied');
SELECT t('leave-view: staff forges conflict notes via view', :S, $q$UPDATE leave_requests_v SET conflict_notes='via view' WHERE id='10000000-0000-0000-0000-000000000001'$q$, 'denied');
SELECT t('leave-view: staff cancels own pending via view', :S, $q$UPDATE leave_requests_v SET status='cancelled' WHERE id='10000000-0000-0000-0000-000000000001'; SELECT assert_true((SELECT status FROM leave_requests WHERE id='10000000-0000-0000-0000-000000000001')='cancelled','c')$q$, 'allowed');
SELECT t('leave: sync (service role) still sets import id', NULL, $q$UPDATE leave_requests SET clwrota_external_id='ext-2' WHERE id='10000000-0000-0000-0000-000000000002'$q$, 'allowed');
SELECT t('profile: admin/server path rotates calendar token', NULL, $q$UPDATE profiles SET calendar_feed_token='server-random' WHERE id='00000000-0000-0000-0000-000000000051'$q$, 'allowed');

-- 7. Passkey ceremony binding
SELECT t('passkey: consume discoverable challenge by exact id once', NULL, $q$SELECT assert_true((SELECT count(*) FROM consume_passkey_challenge_by_id('30000000-0000-0000-0000-000000000001','authentication'))=1,'first'); SELECT assert_true((SELECT count(*) FROM consume_passkey_challenge_by_id('30000000-0000-0000-0000-000000000001','authentication'))=0,'replay')$q$, 'allowed');
SELECT t('passkey: expired challenge not consumable', NULL, $q$SELECT assert_true((SELECT count(*) FROM consume_passkey_challenge_by_id('30000000-0000-0000-0000-000000000003','authentication'))=0,'expired')$q$, 'allowed');
SELECT t('passkey: wrong purpose not consumable', NULL, $q$SELECT assert_true((SELECT count(*) FROM consume_passkey_challenge_by_id('30000000-0000-0000-0000-000000000002','registration'))=0,'purpose')$q$, 'allowed');
SELECT t('passkey: bound challenge returns its user for cross-user check', NULL, $q$SELECT assert_true((SELECT user_id FROM consume_passkey_challenge_by_id('30000000-0000-0000-0000-000000000002','authentication'))='00000000-0000-0000-0000-000000000052','user')$q$, 'allowed');
SELECT t('passkey: authenticated cannot call consume rpc', :S, $q$SELECT * FROM consume_passkey_challenge_by_id('30000000-0000-0000-0000-000000000002','authentication')$q$, 'denied');
SELECT t('passkey: user cannot insert own credential directly', :S, $q$INSERT INTO passkey_credentials(user_id,credential_id,public_key) VALUES ('00000000-0000-0000-0000-000000000051','attacker','pk')$q$, 'denied');
SELECT t('passkey: user cannot reset counter directly', :S, $q$UPDATE passkey_credentials SET counter=0 WHERE credential_id='cred-s'$q$, 'denied');

-- 8. Quotas
SELECT t('quota: within limits allowed', NULL, $q$SELECT assert_true(take_request_quota(ARRAY['h:a|3600|2|','h:g|3600|10|'],0),'ok')$q$, 'allowed');
SELECT t('quota: third hit in window refused and nothing counted', NULL, $q$SELECT take_request_quota(ARRAY['q:a|3600|2|','q:g|3600|10|'],0); SELECT take_request_quota(ARRAY['q:a|3600|2|','q:g|3600|10|'],0); SELECT assert_true(NOT take_request_quota(ARRAY['q:a|3600|2|','q:g|3600|10|'],0),'refused'); SELECT assert_true((SELECT hits FROM request_quota_buckets WHERE bucket='q:g')=2,'atomic')$q$, 'allowed');
SELECT t('quota: byte cap enforced', NULL, $q$SELECT assert_true(NOT take_request_quota(ARRAY['b:a|3600|100|1000'],5000),'bytes')$q$, 'allowed');
SELECT t('quota: authenticated cannot call', :S, $q$SELECT take_request_quota(ARRAY['x|60|1|'],0)$q$, 'denied');
