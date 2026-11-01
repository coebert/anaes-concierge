#!/usr/bin/env bash
# Disposable harness for the SECURITY DEFINER caller-identity fix (0007).
# Reproduces the live trap: functions OWNED by a non-superuser postgres that
# is a MEMBER of service_role. Phase 1 loads the verbatim LIVE bodies and
# proves the bypass; phase 2 applies the reviewed migration and proves every
# allow/deny case by exact SQLSTATE / row content / stub-queue delta; phase 3
# repeats the key cases through a real PostgREST with synthetic JWTs.
# Synthetic data only. net.http_post is a stub queue; no HTTP is sent.
set -euo pipefail
if [ "$(id -u)" = 0 ]; then exec su nobody -s /bin/bash -c "PG=${PG:-} PGRST=${PGRST:-} bash $(readlink -f "$0")"; fi
PG=${PG:-$(nix build nixpkgs#postgresql_16 --no-link --print-out-paths | grep -v -- -man | head -1)}
PGRST=${PGRST:-$(nix build nixpkgs#postgrest --no-link --print-out-paths | head -1)}
export PATH="$PG/bin:$PGRST/bin:$PATH"
HERE=$(cd "$(dirname "$0")" && pwd); ROOT="$HERE/../../.."
MIG="$ROOT/drizzle/migrations/0007_definer_caller_identity.sql"; [ -f "$MIG" ] || MIG="$HERE/pending-0007.sql"
D=$(mktemp -d /tmp/pgdefiner.XXXX)
cleanup() { [ -n "${RPID:-}" ] && kill "$RPID" 2>/dev/null || true; pg_ctl -D "$D/data" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$D"; }
trap cleanup EXIT
LC_ALL=C LANG=C initdb --no-locale -E UTF8 -D "$D/data" -U harness -A trust >/dev/null
pg_ctl -D "$D/data" -o "-k $D -p 55450 -c listen_addresses=''" -l "$D/log" start >/dev/null
H="psql -h $D -p 55450 -d postgres -v ON_ERROR_STOP=1 -q"
$H -U harness -c "SET check_function_bodies = off" -f "$HERE/fixture.sql" >/dev/null
PGOPTIONS="-c check_function_bodies=off" $H -U postgres -f "$HERE/live-functions.sql" >/dev/null
$H -U postgres -f "$HERE/seed.sql" >/dev/null
$H -U harness -c "CREATE TABLE results (phase text, name text, expected text, actual text)"

A=00000000-0000-0000-0000-0000000000a1; B=00000000-0000-0000-0000-0000000000b2; C=00000000-0000-0000-0000-0000000000c3
DA=00000000-0000-0000-0000-0000000000d4; E=00000000-0000-0000-0000-0000000000e5; I=00000000-0000-0000-0000-0000000000e7
R=00000000-0000-0000-0000-0000000000f6; M=00000000-0000-0000-0000-0000000000e8
CA=60000000-0000-0000-0000-0000000000a1; CB=60000000-0000-0000-0000-0000000000b2; CI=60000000-0000-0000-0000-0000000000e7
PHASE=live

# Caller setups. "pgrst-*" connect as authenticator and do exactly what
# PostgREST does (claims GUC + SET LOCAL ROLE). "sched" is a no-claims
# postgres session = the verified pg_cron identity.
setup() { case "$1" in
  anon)        echo "authenticator|SELECT set_config('request.jwt.claims','{\"role\":\"anon\"}',true); SET LOCAL ROLE anon;";;
  user:*)      echo "authenticator|SELECT set_config('request.jwt.claims','{\"role\":\"authenticated\",\"sub\":\"${1#user:}\"}',true); SET LOCAL ROLE authenticated;";;
  service)     echo "authenticator|SELECT set_config('request.jwt.claims','{\"role\":\"service_role\"}',true); SET LOCAL ROLE service_role;";;
  noclaims)    echo "authenticator|SET LOCAL ROLE authenticated;";;
  forged-svc)  echo "authenticator|SELECT set_config('request.jwt.claims','{\"role\":\"service_role\",\"sub\":\"$A\"}',true); SET LOCAL ROLE authenticated;";;
  forged-sub)  echo "authenticator|SELECT set_config('request.jwt.claims','{\"role\":\"authenticated\",\"sub\":\"$DA\"}',true); SET LOCAL ROLE anon;";;
  authn-bare)  echo "authenticator|";;
  sched)       echo "postgres|";;
  pg-as-auth)  echo "postgres|SET LOCAL ROLE authenticated;";;
  pg-as-svc)   echo "postgres|SET LOCAL ROLE service_role;";;
  pg-claims)   echo "postgres|SELECT set_config('request.jwt.claims','{\"role\":\"authenticated\",\"sub\":\"$DA\"}',true);";;
esac; }
qcount() { $H -U harness -At -c "select count(*) from net.http_request_queue"; }
# c NAME CALLER SQL EXPECT  -> actual = ok:<value>|q=<delta>  or  err:<SQLSTATE>|q=<delta>
c() {
  local s; s=$(setup "$2"); local user=${s%%|*} pre=${s#*|}
  local q0; q0=$(qcount)
  local out; out=$(psql -h "$D" -p 55450 -d postgres -U "$user" -At -v VERBOSITY=sqlstate 2>&1 <<SQL || true
\set VERBOSITY sqlstate
BEGIN;
$pre
SELECT 'ok:' || coalesce(($3)::text, '');
COMMIT;
SQL
)
  local q1; q1=$(qcount)
  local code; code=$(echo "$out" | grep -o 'ERROR:  [0-9A-Z]\{5\}' | head -1 | awk '{print $2}' || true)
  local actual
  if [ -n "$code" ]; then actual="err:$code"; else actual=$(echo "$out" | grep '^ok:' | head -1 || true); fi
  actual="$actual|q=$((q1-q0))"
  $H -U harness -c "INSERT INTO results VALUES ('$PHASE', \$a\$$1\$a\$, \$e\$$4\$e\$, \$v\$$actual\$v\$)"
}
MSG() { echo "(SELECT count(*)::text || ':' || coalesce(string_agg(parts->>'t', ',' ORDER BY parts->>'t'), '') FROM public.get_ai_messages_decrypted('$1'))"; }
RTW="(SELECT count(*)::text || ':' || coalesce(string_agg(notes, ',' ORDER BY notes), '') FROM public.get_rtw_interviews_decrypted())"
COMP="(SELECT count(*) FROM public.get_competency_eligibility('2026-11-01'))"

# ---------- Phase 1: verbatim LIVE bodies — prove the trap exists ----------
c "TRAP staffA reads staffB AI chat"            user:$A "$(MSG $CB)"                               "ok:1:B-secret|q=0"
c "TRAP staffA reads every RTW interview"       user:$A "$RTW"                                     "ok:3:A-rtw,B-rtw,I-rtw|q=0"
c "TRAP staffA triggers CLWRota sync"           user:$A "public.trigger_clwrota_sync('staff') IS NOT NULL" "ok:true|q=1"
# Live body passes the guard for staffA and then hits the pre-existing 42702
# (ambiguous OUT column); reaching 42702 instead of 42501 proves the bypass.
c "TRAP staffA passes cron-listing guard"       user:$A "(SELECT count(*) FROM public.list_clwrota_cron_runs(5))" "err:42702|q=0"
c "TRAP no-claims authenticated passes competency guard" noclaims "$COMP"                       "err:42702|q=0"
c "TRAP postgres-switched-authenticated sync"   pg-as-auth "public.trigger_clwrota_sync('rota') IS NOT NULL" "ok:true|q=1"
LAUD=$($H -U harness -At -c "SELECT string_agg(DISTINCT db_role, ',') FROM public.rpc_access_audit")
$H -U harness -c "INSERT INTO results VALUES ('live','TRAP audit logs definer owner as caller role','postgres','$LAUD')"

# ---------- Phase 2: apply the reviewed migration as postgres ----------
sed '/--> statement-breakpoint/d' "$MIG" | $H -U postgres >/dev/null
$H -U harness -c "TRUNCATE net.http_request_queue; TRUNCATE public.rpc_access_audit"
PHASE=fixed
# AI messages: owner or coordinator/admin; nothing else.
c "ai: staffA reads own chat"                    user:$A  "$(MSG $CA)" "ok:1:A-secret|q=0"
c "ai: staffA cannot read staffB chat"           user:$A  "$(MSG $CB)" "ok:0:|q=0"
c "ai: staffB reads own chat"                    user:$B  "$(MSG $CB)" "ok:1:B-secret|q=0"
c "ai: coordinator reads staffB chat"            user:$C  "$(MSG $CB)" "ok:1:B-secret|q=0"
c "ai: admin reads staffA chat"                  user:$DA "$(MSG $CA)" "ok:1:A-secret|q=0"
c "ai: inactive admin denied"                    user:$E  "$(MSG $CA)" "ok:0:|q=0"
c "ai: departed staff cannot read own chat"      user:$I  "$(MSG $CI)" "ok:0:|q=0"
c "ai: roleless denied"                          user:$R  "$(MSG $CA)" "ok:0:|q=0"
c "ai: role but missing profile denied"          user:$M  "$(MSG $CA)" "ok:0:|q=0"
c "ai: anonymous denied (no execute)"            anon     "$(MSG $CA)" "err:42501|q=0"
c "ai: no-claims authenticated denied"           noclaims "$(MSG $CA)" "ok:0:|q=0"
c "ai: forged service claim under authenticated" forged-svc "$(MSG $CB)" "ok:0:|q=0"
c "ai: forged admin sub under anon role"         forged-sub "$(MSG $CA)" "err:42501|q=0"
c "ai: authenticator without role switch"        authn-bare "$(MSG $CA)" "err:42501|q=0"
c "ai: scheduler session not a reader"           sched    "$(MSG $CB)" "ok:0:|q=0"
c "ai: postgres switched authenticated denied"   pg-as-auth "$(MSG $CB)" "ok:0:|q=0"
c "ai: postgres switched service_role, no claims" pg-as-svc "$(MSG $CB)" "ok:0:|q=0"
c "ai: signed service_role reads"                service  "$(MSG $CB)" "ok:1:B-secret|q=0"
c "ai: staffA direct decrypt_ai_message_parts"   user:$A  "public.decrypt_ai_message_parts(NULL, '$CB')" "err:42501|q=0"
c "ai: staffA direct decrypt_owner_or_coord"     user:$A  "public.decrypt_owner_or_coord(NULL, '$B')" "err:42501|q=0"
c "ai: staffA direct admin_decrypt_text"         user:$A  "public.admin_decrypt_text(NULL)" "err:42501|q=0"
c "helper: staffA cannot call _request_is_service_role" user:$A "public._request_is_service_role()" "err:42501|q=0"
# RTW: own, or coordinator/admin.
c "rtw: staffA sees own only"                    user:$A  "$RTW" "ok:1:A-rtw|q=0"
c "rtw: staffB sees own only"                    user:$B  "$RTW" "ok:1:B-rtw|q=0"
c "rtw: coordinator sees all"                    user:$C  "$RTW" "ok:3:A-rtw,B-rtw,I-rtw|q=0"
c "rtw: admin sees all"                          user:$DA "$RTW" "ok:3:A-rtw,B-rtw,I-rtw|q=0"
c "rtw: inactive admin sees none"                user:$E  "$RTW" "ok:0:|q=0"
c "rtw: departed staff sees none"                user:$I  "$RTW" "ok:0:|q=0"
c "rtw: roleless sees none"                      user:$R  "$RTW" "ok:0:|q=0"
c "rtw: no-claims authenticated sees none"       noclaims "$RTW" "ok:0:|q=0"
c "rtw: forged service claim sees none"          forged-svc "$RTW" "ok:0:|q=0"
c "rtw: anonymous denied"                        anon     "$RTW" "err:42501|q=0"
c "rtw: scheduler session sees none"             sched    "$RTW" "ok:0:|q=0"
c "rtw: service_role sees all"                   service  "$RTW" "ok:3:A-rtw,B-rtw,I-rtw|q=0"
# Competency: any active member.
c "comp: staffA allowed"                         user:$A  "$COMP" "ok:5|q=0"
c "comp: roleless denied"                        user:$R  "$COMP" "err:42501|q=0"
c "comp: inactive admin denied"                  user:$E  "$COMP" "err:42501|q=0"
c "comp: missing profile denied"                 user:$M  "$COMP" "err:42501|q=0"
c "comp: no-claims authenticated denied"         noclaims "$COMP" "err:42501|q=0"
c "comp: forged service claim denied"            forged-svc "$COMP" "err:42501|q=0"
c "comp: anonymous denied"                       anon     "$COMP" "err:42501|q=0"
c "comp: scheduler session denied"               sched    "$COMP" "err:42501|q=0"
c "comp: service_role allowed"                   service  "$COMP" "ok:5|q=0"
# Sync variants: admin or service; scheduler only for the scheduled ones.
for f in "trigger_clwrota_sync('staff')" "trigger_clwrota_sync_with_query('rota','from=2026-01-01')" "trigger_clwrota_sync_rate_limited('leave')"; do
  n=${f%%(*}
  for who in user:$A user:$B user:$C user:$E user:$R noclaims forged-svc pg-as-auth pg-as-svc pg-claims; do
    c "sync: $n denied for $who" "$who" "public.$f IS NOT NULL" "err:42501|q=0"
  done
  c "sync: $n denied for anon" anon "public.$f IS NOT NULL" "err:42501|q=0"
  c "sync: $n admin enqueues 1 stub" user:$DA "public.$f IS NOT NULL" "ok:true|q=1"
  c "sync: $n service enqueues 1 stub" service "public.$f IS NOT NULL" "ok:true|q=1"
done
c "sync: trigger_clwrota_sync scheduler enqueues 1"            sched "public.trigger_clwrota_sync('staff') IS NOT NULL" "ok:true|q=1"
c "sync: with_query scheduler enqueues 1"                      sched "public.trigger_clwrota_sync_with_query('rota','from=2026-01-01') IS NOT NULL" "ok:true|q=1"
c "sync: rate_limited NOT available to scheduler"              sched "public.trigger_clwrota_sync_rate_limited('leave') IS NOT NULL" "err:42501|q=0"
c "sync: all_rate_limited denied for staffA"                   user:$A "public.trigger_clwrota_sync_all_rate_limited() IS NOT NULL" "err:42501|q=0"
c "sync: all_rate_limited denied for coordinator"              user:$C "public.trigger_clwrota_sync_all_rate_limited() IS NOT NULL" "err:42501|q=0"
c "sync: all_rate_limited denied for no-claims"                noclaims "public.trigger_clwrota_sync_all_rate_limited() IS NOT NULL" "err:42501|q=0"
c "sync: all_rate_limited denied for scheduler"                sched "public.trigger_clwrota_sync_all_rate_limited() IS NOT NULL" "err:42501|q=0"
c "sync: all_rate_limited admin enqueues 3"                    user:$DA "public.trigger_clwrota_sync_all_rate_limited() IS NOT NULL" "ok:true|q=3"
c "sync: all_rate_limited service enqueues 3"                  service "public.trigger_clwrota_sync_all_rate_limited() IS NOT NULL" "ok:true|q=3"
# Cron listing and anomaly detection: admin or service only.
for who in user:$A user:$C user:$E noclaims forged-svc sched pg-as-auth anon; do
  c "cron: list denied for $who" "$who" "(SELECT count(*) FROM public.list_clwrota_cron_runs(5))" "err:42501|q=0"
  c "anomaly: detect denied for $who" "$who" "public.detect_rpc_access_anomalies(10, 0)" "err:42501|q=0"
done
c "cron: admin lists"            user:$DA "(SELECT count(*) FROM public.list_clwrota_cron_runs(5))" "ok:1|q=0"
c "cron: service lists"          service  "(SELECT count(*) FROM public.list_clwrota_cron_runs(5))" "ok:1|q=0"
c "anomaly: admin runs"          user:$DA "public.detect_rpc_access_anomalies(10, 1000000) >= 0" "ok:true|q=0"
c "anomaly: service runs"        service  "public.detect_rpc_access_anomalies(10, 1000000) >= 0" "ok:true|q=0"
# Audit metadata reflects the real caller.
$H -U harness -c "TRUNCATE public.rpc_access_audit"
c "audit: staffA call recorded as authenticated + uid" user:$A "(SELECT count(*) FROM public.get_rtw_interviews_decrypted())" "ok:1|q=0"
c "audit: service call recorded as service_role"       service "(SELECT count(*) FROM public.get_rtw_interviews_decrypted())" "ok:3|q=0"
c "audit: scheduler call recorded as scheduler"        sched "(SELECT count(*) FROM public.get_rtw_interviews_decrypted())" "ok:0|q=0"
AUD=$($H -U harness -At -c "SELECT string_agg(coalesce(called_by::text,'null') || '/' || db_role, ',' ORDER BY id) FROM public.rpc_access_audit")
$H -U harness -c "INSERT INTO results VALUES ('fixed','audit: caller rows', \$e\$$A/authenticated,null/service_role,null/scheduler:postgres\$e\$, \$v\$$AUD\$v\$)"
BAD=$($H -U harness -At -c "SELECT count(*) FROM net.http_request_queue WHERE url !~ '/api/public/hooks/clwrota-sync\?step=(staff|rota|leave)(&from=2026-01-01)?$' OR headers->>'x-webhook-secret' <> 'dummy-harness-secret'")
$H -U harness -c "INSERT INTO results VALUES ('fixed','queue: only expected stub rows (url+dummy secret)','0','$BAD')"
DEFS=$($H -U harness -At -c "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.prosecdef AND pg_get_functiondef(p.oid) ~* '(pg_has_role\(current_user|current_user\s*(=|<>))'")
$H -U harness -c "INSERT INTO results VALUES ('fixed','metadata: no definer body tests current_user','0','$DEFS')"

# ---------- Phase 3: real PostgREST, synthetic JWTs ----------
SECRET="harness-only-jwt-secret-0123456789abcdef"
jwt() { node -e '
const c=require("crypto");const b=(o)=>Buffer.from(JSON.stringify(o)).toString("base64url");
const p=JSON.parse(process.argv[1]);p.exp=Math.floor(Date.now()/1000)+600;
const h=b({alg:process.argv[3]||"HS256",typ:"JWT"}),q=b(p);
const sig=process.argv[3]==="none"?"":c.createHmac("sha256",process.argv[2]).update(h+"."+q).digest("base64url");
process.stdout.write(h+"."+q+"."+sig);' "$1" "$2" "${3:-}"; }
TA=$(jwt "{\"sub\":\"$A\",\"role\":\"authenticated\"}" "$SECRET"); TD=$(jwt "{\"sub\":\"$DA\",\"role\":\"authenticated\"}" "$SECRET")
TR=$(jwt "{\"sub\":\"$R\",\"role\":\"authenticated\"}" "$SECRET"); TS=$(jwt '{"role":"service_role"}' "$SECRET")
TBAD=$(jwt '{"role":"service_role"}' "wrong-secret"); TNONE=$(jwt "{\"sub\":\"$DA\",\"role\":\"authenticated\"}" "" none)
PGRST_DB_URI="postgres://authenticator@/postgres?host=$D&port=55450" PGRST_DB_SCHEMAS=public PGRST_DB_ANON_ROLE=anon \
PGRST_JWT_SECRET="$SECRET" PGRST_SERVER_PORT=55451 PGRST_SERVER_HOST=127.0.0.1 PGRST_LOG_LEVEL=crit postgrest >"$D/pgrst.log" 2>&1 &
RPID=$!
for _ in $(seq 1 100); do [ "$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:55451/)" = 200 ] && break; sleep 0.2; done
$H -U harness -c "TRUNCATE net.http_request_queue"
PHASE=postgrest
h() { # name method token path body expect_code body_regex expect_queue_delta
  local q0; q0=$(qcount); local auth=(); [ -n "$3" ] && auth=(-H "Authorization: Bearer $3")
  local out
  if [ "$2" = GET ]; then out=$(curl -s -w '\n%{http_code}' "${auth[@]}" "http://127.0.0.1:55451$4")
  else out=$(curl -s -w '\n%{http_code}' "${auth[@]}" -H 'Content-Type: application/json' -X POST -d "$5" "http://127.0.0.1:55451$4"); fi
  local code; code=$(echo "$out" | tail -1); local body; body=$(echo "$out" | sed '$d'); local q1; q1=$(qcount)
  local m=no; echo "$body" | grep -Eq "$7" && m=yes
  $H -U harness -c "INSERT INTO results VALUES ('postgrest', \$a\$$1\$a\$, \$e\$$6|yes|q=$8\$e\$, \$v\$$code|$m|q=$((q1-q0))\$v\$)"
}
h "POST staffA cannot read staffB chat"      POST "$TA" /rpc/get_ai_messages_decrypted "{\"p_conversation_id\":\"$CB\"}" 200 '^\[\]$' 0
h "GET staffA reads own chat"                GET  "$TA" "/rpc/get_ai_messages_decrypted?p_conversation_id=$CA" "" 200 'A-secret' 0
h "POST admin reads staffB chat"             POST "$TD" /rpc/get_ai_messages_decrypted "{\"p_conversation_id\":\"$CB\"}" 200 'B-secret' 0
h "POST service reads staffB chat"           POST "$TS" /rpc/get_ai_messages_decrypted "{\"p_conversation_id\":\"$CB\"}" 200 'B-secret' 0
h "GET anon chat denied"                     GET  ""    "/rpc/get_ai_messages_decrypted?p_conversation_id=$CB" "" 401 '42501' 0
h "GET staffA RTW own only"                  GET  "$TA" /rpc/get_rtw_interviews_decrypted "" 200 '^\[[^]]*A-rtw[^]]*\]$' 0
h "GET staffA RTW excludes B"                GET  "$TA" /rpc/get_rtw_interviews_decrypted "" 200 '^[^B]*$' 0
h "GET admin RTW includes B"                 GET  "$TD" /rpc/get_rtw_interviews_decrypted "" 200 'B-rtw' 0
h "POST staffA sync denied"                  POST "$TA" /rpc/trigger_clwrota_sync '{"p_step":"staff"}' 403 '42501' 0
h "POST staffA sync_with_query denied"       POST "$TA" /rpc/trigger_clwrota_sync_with_query '{"p_step":"rota","p_query":"x=1"}' 403 '42501' 0
h "POST staffA rate_limited denied"          POST "$TA" /rpc/trigger_clwrota_sync_rate_limited '{"p_step":"leave"}' 403 '42501' 0
h "POST staffA all_rate_limited denied"      POST "$TA" /rpc/trigger_clwrota_sync_all_rate_limited '{}' 403 '42501' 0
h "POST anon sync denied"                    POST ""    /rpc/trigger_clwrota_sync '{"p_step":"staff"}' 401 '42501' 0
h "POST forged service JWT (bad signature)"  POST "$TBAD" /rpc/trigger_clwrota_sync '{"p_step":"staff"}' 401 'PGRST' 0
h "POST alg=none admin JWT rejected"         POST "$TNONE" /rpc/trigger_clwrota_sync '{"p_step":"staff"}' 401 'PGRST' 0
h "POST admin sync enqueues 1 stub"          POST "$TD" /rpc/trigger_clwrota_sync '{"p_step":"staff"}' 200 '^[0-9]+$' 1
h "POST service all_rate_limited enqueues 3" POST "$TS" /rpc/trigger_clwrota_sync_all_rate_limited '{}' 200 'staff_request_id' 3
h "GET staffA cron runs denied"              GET  "$TA" "/rpc/list_clwrota_cron_runs?p_limit=5" "" 403 '42501' 0
h "GET admin cron runs"                      GET  "$TD" "/rpc/list_clwrota_cron_runs?p_limit=5" "" 200 'clwrota-sync-staff-daily' 0
h "POST staffA anomaly detection denied"     POST "$TA" /rpc/detect_rpc_access_anomalies '{"p_window_minutes":10,"p_threshold":0}' 403 '42501' 0
h "POST service anomaly detection"           POST "$TS" /rpc/detect_rpc_access_anomalies '{"p_window_minutes":10,"p_threshold":1000000}' 200 '^[0-9]+$' 0
h "GET roleless competency denied"           GET  "$TR" /rpc/get_competency_eligibility "" 403 '42501' 0
h "GET staffA competency"                    GET  "$TA" /rpc/get_competency_eligibility "" 200 'Synthetic ICU' 0
h "POST staffA direct decrypt helper denied" POST "$TA" /rpc/decrypt_owner_or_coord "{\"p_cipher\":null,\"p_owner\":\"$B\"}" 403 '42501' 0

$H -U harness -P pager=off -c "SELECT CASE WHEN expected=actual THEN 'PASS' ELSE 'FAIL' END AS result, phase, name, expected, actual FROM results ORDER BY phase DESC, 1, 3"
FAILS=$($H -U harness -At -c "SELECT count(*) FROM results WHERE expected<>actual")
TOTAL=$($H -U harness -At -c "SELECT count(*) FROM results")
echo "definer harness ($(postgres --version), $(postgrest --version 2>/dev/null | head -1)): $TOTAL cases, $FAILS failures"
[ "$FAILS" = 0 ]
