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
SELECT t('leave: coordinator records approved leave for staff; decided_by forced to actor', :C, $q$INSERT INTO leave_requests(id,staff_id,start_date,end_date,status,decided_by) VALUES ('10000000-0000-0000-0000-0000000000ff','00000000-0000-0000-0000-000000000051','2027-05-01','2027-05-02','approved','00000000-0000-0000-0000-00000000000a'); SELECT assert_true((SELECT decided_by FROM leave_requests WHERE id='10000000-0000-0000-0000-0000000000ff') = '00000000-0000-0000-0000-00000000000c', 'decided_by actor')$q$, 'allowed');
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
SELECT t('profile: staff rotates own calendar token', :S, $q$UPDATE profiles SET calendar_feed_token='x' WHERE id='00000000-0000-0000-0000-000000000051'$q$, 'allowed');
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
