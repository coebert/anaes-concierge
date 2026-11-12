#!/usr/bin/env bash
# Disposable harness for pending migration 0011 (restricted per-assignment
# CLWRota source details: titles, notes, place notes, typed times, collapsed
# same-half rows). Uses the definer fixture (a
# non-superuser postgres owner that is a service_role member, as live), the
# reviewed 0007 caller-identity helpers, then 0008. Proves privileges by exact
# SQLSTATE / row content in SQL and through a real PostgREST with synthetic
# JWTs. Synthetic data only; never point this at a real database.
set -euo pipefail
if [ "$(id -u)" = 0 ]; then exec su nobody -s /bin/bash -c "PG=${PG:-} PGRST=${PGRST:-} bash $(readlink -f "$0")"; fi
PG=${PG:-$(nix build nixpkgs#postgresql_16 --no-link --print-out-paths | grep -v -- -man | head -1)}
PGRST=${PGRST:-$(nix build nixpkgs#postgrest --no-link --print-out-paths | head -1)}
export PATH="$PG/bin:$PGRST/bin:$PATH"
HERE=$(cd "$(dirname "$0")" && pwd); ROOT="$HERE/../../.."; DEF="$HERE/../definer"
M7="$ROOT/drizzle/migrations/0007_definer_caller_identity.sql"
M11=$( (ls "$ROOT"/drizzle/migrations/*_rota_assignment_source_details.sql 2>/dev/null || ls "$ROOT"/drizzle/pending/0011_rota_assignment_source_details.sql) | head -1)
D=$(mktemp -d /tmp/pgdetails.XXXX)
cleanup() { [ -n "${RPID:-}" ] && kill "$RPID" 2>/dev/null || true; pg_ctl -D "$D/data" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$D"; }
trap cleanup EXIT
LC_ALL=C LANG=C initdb --no-locale -E UTF8 -D "$D/data" -U harness -A trust >/dev/null
pg_ctl -D "$D/data" -o "-k $D -p 55470 -c listen_addresses=''" -l "$D/log" start >/dev/null
H="psql -h $D -p 55470 -d postgres -v ON_ERROR_STOP=1 -q"
$H -U harness -c "SET check_function_bodies = off" -f "$DEF/fixture.sql" >/dev/null
PGOPTIONS="-c check_function_bodies=off" $H -U postgres -f "$DEF/live-functions.sql" >/dev/null
$H -U postgres -f "$DEF/seed.sql" >/dev/null
sed '/--> statement-breakpoint/d' "$M7" | $H -U postgres >/dev/null
$H -U postgres -f "$HERE/fixture-rota.sql" >/dev/null
sed '/--> statement-breakpoint/d' "$M11" | $H -U postgres >/dev/null
$H -U harness -c "CREATE TABLE results (phase text, name text, expected text, actual text)"

A=00000000-0000-0000-0000-0000000000a1; C=00000000-0000-0000-0000-0000000000c3
DA=00000000-0000-0000-0000-0000000000d4; E=00000000-0000-0000-0000-0000000000e5; I=00000000-0000-0000-0000-0000000000e7
R=00000000-0000-0000-0000-0000000000f6; M=00000000-0000-0000-0000-0000000000e8
RA1=90000000-0000-0000-0000-000000000001; RA3=90000000-0000-0000-0000-000000000003
T=public.rota_assignment_source_details
PHASE=sql

setup() { case "$1" in
  anon)        echo "authenticator|SELECT set_config('request.jwt.claims','{\"role\":\"anon\"}',true); SET LOCAL ROLE anon;";;
  user:*)      echo "authenticator|SELECT set_config('request.jwt.claims','{\"role\":\"authenticated\",\"sub\":\"${1#user:}\"}',true); SET LOCAL ROLE authenticated;";;
  service)     echo "authenticator|SELECT set_config('request.jwt.claims','{\"role\":\"service_role\"}',true); SET LOCAL ROLE service_role;";;
  noclaims)    echo "authenticator|SET LOCAL ROLE authenticated;";;
  forged-svc)  echo "authenticator|SELECT set_config('request.jwt.claims','{\"role\":\"service_role\",\"sub\":\"$A\"}',true); SET LOCAL ROLE authenticated;";;
  forged-sub)  echo "authenticator|SELECT set_config('request.jwt.claims','{\"role\":\"authenticated\",\"sub\":\"$DA\"}',true); SET LOCAL ROLE anon;";;
  sched)       echo "postgres|";;
esac; }
# c NAME CALLER SQL EXPECT  -> actual = ok:<value> | err:<SQLSTATE>
c() {
  local s; s=$(setup "$2"); local user=${s%%|*} pre=${s#*|}
  local out; out=$(psql -h "$D" -p 55470 -d postgres -U "$user" -At 2>&1 <<SQL || true
\set VERBOSITY sqlstate
BEGIN;
$pre
SELECT 'ok:' || coalesce(($3)::text, '');
COMMIT;
SQL
)
  local code; code=$(echo "$out" | grep -o 'ERROR:  [0-9A-Z]\{5\}' | head -1 | awk '{print $2}' || true)
  local actual
  if [ -n "$code" ]; then actual="err:$code"; else actual=$(echo "$out" | grep '^ok:' | head -1 || true); fi
  $H -U harness -c "INSERT INTO results VALUES ('$PHASE', \$a\$$1\$a\$, \$e\$$4\$e\$, \$v\$$actual\$v\$)"
}
# cw: like c, but $3 is a complete statement selecting 'ok:'||value (needed
# for data-modifying CTEs, which must be top level).
cw() {
  local s; s=$(setup "$2"); local user=${s%%|*} pre=${s#*|}
  local out; out=$(psql -h "$D" -p 55470 -d postgres -U "$user" -At 2>&1 <<SQL || true
\set VERBOSITY sqlstate
BEGIN;
$pre
$3;
COMMIT;
SQL
)
  local code; code=$(echo "$out" | grep -o 'ERROR:  [0-9A-Z]\{5\}' | head -1 | awk '{print $2}' || true)
  local actual
  if [ -n "$code" ]; then actual="err:$code"; else actual=$(echo "$out" | grep '^ok:' | head -1 || true); fi
  $H -U harness -c "INSERT INTO results VALUES ('$PHASE', \$a\$$1\$a\$, \$e\$$4\$e\$, \$v\$$actual\$v\$)"
}
INS="WITH i AS (INSERT INTO $T (clwrota_external_id, slot_titles, slot_notes, place_notes, place_name, start_time, end_time, duration, pa_value, collapsed_rows) VALUES
 ('k1', ARRAY['SYNTHSECRET ICU title'], ARRAY['SYNTHSECRET list note'], ARRAY['SYNTHSECRET place note'], 'Synthetic ICU', '2030-01-07T08:00:00+00', '2030-01-07T20:00:00+00', '12:00:00', 3,
   '[{\"duty_type\":\"theatre\",\"slot_titles\":[\"SYNTHSECRET lost list\"]}]'::jsonb),
 ('k2', '{}', '{}', '{}', NULL, NULL, NULL, NULL, NULL, '[]'),
 ('k3', ARRAY['SYNTHSECRET t3'], '{}', '{}', NULL, NULL, NULL, NULL, NULL, '[]') RETURNING 1) SELECT 'ok:' || count(*) FROM i"
cw "service inserts source details"             service "$INS"                                  "ok:3"
c "service reads typed values back"             service "(SELECT concat_ws(',', array_to_string(slot_titles,'+'), duration::text, pa_value::text, jsonb_array_length(collapsed_rows), extract(epoch from end_time - start_time)::int) FROM $T WHERE clwrota_external_id='k1')" "ok:SYNTHSECRET ICU title,12:00:00,3,1,43200"
c "staffA SELECT denied"                        user:$A "(SELECT count(*) FROM $T)"              "err:42501"
c "staffA SELECT title column denied"           user:$A "(SELECT string_agg(array_to_string(slot_titles,','),';') FROM $T)" "err:42501"
c "coordinator SELECT denied"                   user:$C "(SELECT count(*) FROM $T)"              "err:42501"
c "admin SELECT denied"                         user:$DA "(SELECT count(*) FROM $T)"             "err:42501"
c "anon SELECT denied"                          anon "(SELECT count(*) FROM $T)"                 "err:42501"
c "no-claims authenticated denied"              noclaims "(SELECT count(*) FROM $T)"             "err:42501"
c "forged service claim (role authenticated) denied" forged-svc "(SELECT count(*) FROM $T)"     "err:42501"
cw "coordinator INSERT denied"                  user:$C "WITH i AS (INSERT INTO $T (clwrota_external_id) VALUES ('k3') ON CONFLICT DO NOTHING RETURNING 1) SELECT 'ok:' || count(*) FROM i" "err:42501"
cw "admin UPDATE denied"                        user:$DA "WITH u AS (UPDATE $T SET slot_notes='{}' RETURNING 1) SELECT 'ok:' || count(*) FROM u" "err:42501"
cw "staffA DELETE denied"                       user:$A "WITH d AS (DELETE FROM $T RETURNING 1) SELECT 'ok:' || count(*) FROM d" "err:42501"
cw "blank value rejected"                       service "WITH u AS (UPDATE $T SET slot_titles=ARRAY['  '] WHERE clwrota_external_id='k2' RETURNING 1) SELECT 'ok:' || count(*) FROM u" "err:22023"
cw "oversize value rejected"                    service "WITH u AS (UPDATE $T SET place_notes=ARRAY[repeat('x',2001)] WHERE clwrota_external_id='k2' RETURNING 1) SELECT 'ok:' || count(*) FROM u" "err:22023"
cw "more than 20 values rejected"               service "WITH u AS (UPDATE $T SET slot_notes=ARRAY(SELECT 'n'||g FROM generate_series(1,21) g) WHERE clwrota_external_id='k2' RETURNING 1) SELECT 'ok:' || count(*) FROM u" "err:23514"
cw "collapsed rows must be an array"            service "WITH u AS (UPDATE $T SET collapsed_rows='{}'::jsonb WHERE clwrota_external_id='k2' RETURNING 1) SELECT 'ok:' || count(*) FROM u" "err:23514"
cw "collapsed row must be an object"            service "WITH u AS (UPDATE $T SET collapsed_rows='[1]'::jsonb WHERE clwrota_external_id='k2' RETURNING 1) SELECT 'ok:' || count(*) FROM u" "err:22023"
cw "end before start rejected"                  service "WITH u AS (UPDATE $T SET start_time='2030-01-07T10:00:00+00', end_time='2030-01-07T09:00:00+00' WHERE clwrota_external_id='k2' RETURNING 1) SELECT 'ok:' || count(*) FROM u" "err:23514"
cw "PA out of range rejected"                   service "WITH u AS (UPDATE $T SET pa_value=101 WHERE clwrota_external_id='k2' RETURNING 1) SELECT 'ok:' || count(*) FROM u" "err:23514"
cw "unknown assignment key rejected (FK)"       service "WITH i AS (INSERT INTO $T (clwrota_external_id) VALUES ('no-such-key') RETURNING 1) SELECT 'ok:' || count(*) FROM i" "err:23503"
cw "service upsert replaces values (re-import)" service "WITH u AS (INSERT INTO $T (clwrota_external_id, slot_titles) VALUES ('k3', ARRAY['SYNTHSECRET t3 v2']) ON CONFLICT (clwrota_external_id) DO UPDATE SET slot_titles=EXCLUDED.slot_titles RETURNING array_to_string(slot_titles,'+') AS v) SELECT 'ok:' || string_agg(v,',') FROM u" "ok:SYNTHSECRET t3 v2"
c "legacy assignment note untouched"            sched "(SELECT coalesce(notes,'-') FROM public.rota_assignments WHERE id='$RA1')" "ok:legacy note"
cw "coordinator deletes an assignment"          user:$C "WITH d AS (DELETE FROM public.rota_assignments WHERE id='$RA3' RETURNING 1) SELECT 'ok:' || count(*) FROM d" "ok:1"
c "cascade: its source details are gone"        sched "(SELECT count(*) FROM $T WHERE clwrota_external_id='k3')" "ok:0"
cw "coordinator re-keys an assignment"          user:$C "WITH u AS (UPDATE public.rota_assignments SET clwrota_external_id='k1b' WHERE id='$RA1' RETURNING 1) SELECT 'ok:' || count(*) FROM u" "ok:1"
c "cascade: details follow the new key"         sched "(SELECT string_agg(clwrota_external_id, ',' ORDER BY clwrota_external_id) FROM $T)" "ok:k1b,k2"

META="(SELECT concat_ws(',',
  has_table_privilege('authenticated','$T','SELECT'), has_table_privilege('authenticated','$T','INSERT'),
  has_table_privilege('authenticated','$T','UPDATE'), has_table_privilege('authenticated','$T','DELETE'),
  has_table_privilege('anon','$T','SELECT'), has_table_privilege('service_role','$T','SELECT'),
  (SELECT relrowsecurity FROM pg_class WHERE oid='$T'::regclass),
  (SELECT count(*) FROM pg_policy WHERE polrelid='$T'::regclass),
  has_function_privilege('authenticated','public._validate_rota_assignment_source_details()','EXECUTE'),
  has_function_privilege('anon','public._validate_rota_assignment_source_details()','EXECUTE')))"
c "metadata: privileges, RLS on, no policies"    sched "$META" "ok:f,f,f,f,f,t,t,0,f,f"

# ---------- real PostgREST, synthetic JWTs ----------
SECRET="harness-only-jwt-secret-0123456789abcdef"
jwt() { node -e '
const c=require("crypto");const b=(o)=>Buffer.from(JSON.stringify(o)).toString("base64url");
const p=JSON.parse(process.argv[1]);p.exp=Math.floor(Date.now()/1000)+600;
const h=b({alg:"HS256",typ:"JWT"}),q=b(p);
process.stdout.write(h+"."+q+"."+c.createHmac("sha256",process.argv[2]).update(h+"."+q).digest("base64url"));' "$1" "$2"; }
TA=$(jwt "{\"sub\":\"$A\",\"role\":\"authenticated\"}" "$SECRET"); TD=$(jwt "{\"sub\":\"$DA\",\"role\":\"authenticated\"}" "$SECRET")
TR=$(jwt "{\"sub\":\"$R\",\"role\":\"authenticated\"}" "$SECRET"); TS=$(jwt '{"role":"service_role"}' "$SECRET")
TBAD=$(jwt '{"role":"service_role"}' "wrong-secret")
PGRST_DB_URI="postgres://authenticator@/postgres?host=$D&port=55470" PGRST_DB_SCHEMAS=public PGRST_DB_ANON_ROLE=anon \
PGRST_JWT_SECRET="$SECRET" PGRST_SERVER_PORT=55471 PGRST_SERVER_HOST=127.0.0.1 PGRST_LOG_LEVEL=crit postgrest >"$D/pgrst.log" 2>&1 &
RPID=$!
for _ in $(seq 1 100); do [ "$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:55471/)" = 200 ] && break; sleep 0.2; done
h() { # name method token path body expect_code body_regex
  local auth=(); [ -n "$3" ] && auth=(-H "Authorization: Bearer $3")
  local out
  if [ "$2" = GET ]; then out=$(curl -s -w '\n%{http_code}' "${auth[@]}" "http://127.0.0.1:55471$4")
  else out=$(curl -s -w '\n%{http_code}' "${auth[@]}" -H 'Content-Type: application/json' -X POST -d "$5" "http://127.0.0.1:55471$4"); fi
  local code; code=$(echo "$out" | tail -1); local body; body=$(echo "$out" | sed '$d' | tr -d '\n')
  local m=no; echo "$body" | grep -Eq "$7" && m=yes; [ -n "${DEBUG:-}" ] && printf "[%s] %s %q\n" "$1" "$code" "$body" >&2
  $H -U harness -c "INSERT INTO results VALUES ('postgrest', \$a\$$1\$a\$, \$e\$$6|yes\$e\$, \$v\$$code|$m\$v\$)"
}
h "GET staffA raw table denied"           GET  "$TA" "/rota_assignment_source_details?select=slot_titles" "" 403 '42501'
h "GET admin raw table denied"            GET  "$TD" "/rota_assignment_source_details?select=slot_notes" "" 403 '42501'
h "GET roleless raw table denied"         GET  "$TR" "/rota_assignment_source_details" "" 403 '42501'
h "GET anon raw table denied"             GET  ""    "/rota_assignment_source_details" "" 401 '42501'
h "POST admin raw insert denied"          POST "$TD" "/rota_assignment_source_details" '{"clwrota_external_id":"k2"}' 403 '42501'
h "POST forged service JWT rejected"      GET  "$TBAD" "/rota_assignment_source_details" "" 401 'PGRST'
h "GET service reads raw table"           GET  "$TS" "/rota_assignment_source_details?select=slot_titles,duration&clwrota_external_id=eq.k1b" "" 200 'SYNTHSECRET ICU title.*12:00:00'
h "GET staffA assignments carry no source text" GET "$TA" "/rota_assignments?select=*" "" 200 '^[^S]*$'

$H -U harness -P pager=off -c "SELECT CASE WHEN expected=actual THEN 'PASS' ELSE 'FAIL' END AS result, phase, name, expected, actual FROM results ORDER BY phase DESC, 1, 3"
FAILS=$($H -U harness -At -c "SELECT count(*) FROM results WHERE expected<>actual")
TOTAL=$($H -U harness -At -c "SELECT count(*) FROM results")
echo "source-details harness ($(postgres --version), $(postgrest --version 2>/dev/null | head -1)): $TOTAL cases, $FAILS failures"
[ "$FAILS" = 0 ]
