#!/usr/bin/env bash
# Disposable harness for the PENDING migration 0008 (restricted CLWRota list
# title/note storage + derived-only signals). Uses the definer fixture (a
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
M8="$ROOT/drizzle/pending/0008_theatre_session_source_labels.sql"
[ -f "$M8" ] || M8=$(ls "$ROOT"/drizzle/migrations/*_theatre_session_source_labels.sql | head -1)
D=$(mktemp -d /tmp/pglabels.XXXX)
cleanup() { [ -n "${RPID:-}" ] && kill "$RPID" 2>/dev/null || true; pg_ctl -D "$D/data" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$D"; }
trap cleanup EXIT
LC_ALL=C LANG=C initdb --no-locale -E UTF8 -D "$D/data" -U harness -A trust >/dev/null
pg_ctl -D "$D/data" -o "-k $D -p 55460 -c listen_addresses=''" -l "$D/log" start >/dev/null
H="psql -h $D -p 55460 -d postgres -v ON_ERROR_STOP=1 -q"
$H -U harness -c "SET check_function_bodies = off" -f "$DEF/fixture.sql" >/dev/null
PGOPTIONS="-c check_function_bodies=off" $H -U postgres -f "$DEF/live-functions.sql" >/dev/null
$H -U postgres -f "$DEF/seed.sql" >/dev/null
sed '/--> statement-breakpoint/d' "$M7" | $H -U postgres >/dev/null
$H -U postgres -f "$HERE/fixture-theatre.sql" >/dev/null
sed '/--> statement-breakpoint/d' "$M8" | $H -U postgres >/dev/null
$H -U harness -c "CREATE TABLE results (phase text, name text, expected text, actual text)"

A=00000000-0000-0000-0000-0000000000a1; C=00000000-0000-0000-0000-0000000000c3
DA=00000000-0000-0000-0000-0000000000d4; E=00000000-0000-0000-0000-0000000000e5; I=00000000-0000-0000-0000-0000000000e7
R=00000000-0000-0000-0000-0000000000f6; M=00000000-0000-0000-0000-0000000000e8
S1=80000000-0000-0000-0000-000000000001; S2=80000000-0000-0000-0000-000000000002
S3=80000000-0000-0000-0000-000000000003; S4=80000000-0000-0000-0000-000000000004; S5=80000000-0000-0000-0000-000000000005
T=public.theatre_session_source_labels
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
  local out; out=$(psql -h "$D" -p 55460 -d postgres -U "$user" -At 2>&1 <<SQL || true
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
  local out; out=$(psql -h "$D" -p 55460 -d postgres -U "$user" -At 2>&1 <<SQL || true
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
# Raw values: the secret marker must never reach a non-service caller.
INS="WITH i AS (INSERT INTO $T (theatre_session_id, list_titles, list_notes, place_notes, title_tags, note_tags, source_rows_seen, evidence_complete) VALUES
 ('$S1', ARRAY['SYNTHSECRET VRAM list'], ARRAY['SYNTHSECRET note DIEP'], '{}', ARRAY['VRAM'], ARRAY['DIEP'], 3, true),
 ('$S2', ARRAY['synthsecret  vram LIST'], '{}', '{}', ARRAY['VRAM'], '{}', 2, true),
 ('$S3', '{}', '{}', '{}', '{}', '{}', 1, true),
 ('$S4', '{}', '{}', ARRAY['SYNTHSECRET off site'], '{}', '{}', 1, false),
 ('$S5', ARRAY['SYNTHSECRET out of window'], '{}', '{}', '{}', '{}', 1, true) RETURNING 1) SELECT 'ok:' || count(*) FROM i"
SIG="(SELECT string_agg(concat_ws(',', right(theatre_session_id::text,1), has_title, has_note, has_place_note, array_to_string(title_tags,'+'), array_to_string(note_tags,'+'), coalesce(title_group::text,'-'), source_rows_seen, evidence_complete), ';' ORDER BY theatre_session_id) FROM public.get_theatre_session_label_signals('2030-01-01','2030-01-31'))"
SIGROWS="ok:1,true,true,false,VRAM,DIEP,1,3,true;2,true,false,false,VRAM,,1,2,true;3,false,false,false,,,-,1,true;4,false,false,true,,,-,1,false"
NOLEAK="(SELECT bool_and(r::text NOT ILIKE '%synthsecret%') FROM public.get_theatre_session_label_signals('2030-01-01','2030-01-31') r)"
CNT="(SELECT count(*) FROM public.get_theatre_session_label_signals('2030-01-01','2030-01-31'))"

cw "service inserts raw labels"                service "$INS"                         "ok:5"
c "staffA derived signals (tags, groups, completeness)" user:$A "$SIG"                "$SIGROWS"
c "staffA signals contain no raw text"         user:$A "$NOLEAK"                      "ok:true"
c "coordinator signals"                        user:$C "$CNT"                         "ok:4"
c "admin signals"                              user:$DA "$CNT"                        "ok:4"
c "service signals"                            service "$CNT"                         "ok:4"
c "out-of-window session excluded"             user:$A "(SELECT count(*) FROM public.get_theatre_session_label_signals('2031-06-01','2031-06-30'))" "ok:1"
c "staffA SELECT raw denied"                   user:$A "(SELECT count(*) FROM $T)"    "err:42501"
c "staffA SELECT raw title column denied"      user:$A "(SELECT string_agg(array_to_string(list_titles,','),';') FROM $T)" "err:42501"
cw "staffA INSERT raw denied"                   user:$A "WITH i AS (INSERT INTO $T (theatre_session_id) VALUES ('$S5') ON CONFLICT DO NOTHING RETURNING 1) SELECT 'ok:' || count(*) FROM i" "err:42501"
cw "staffA UPDATE raw denied"                   user:$A "WITH u AS (UPDATE $T SET list_titles='{}' RETURNING 1) SELECT 'ok:' || count(*) FROM u" "err:42501"
cw "staffA DELETE raw denied"                   user:$A "WITH d AS (DELETE FROM $T RETURNING 1) SELECT 'ok:' || count(*) FROM d" "err:42501"
c "admin SELECT raw denied"                    user:$DA "(SELECT count(*) FROM $T)"   "err:42501"
c "anon SELECT raw denied"                     anon "(SELECT count(*) FROM $T)"       "err:42501"
c "anon signals denied"                        anon "$CNT"                            "err:42501"
c "roleless signals denied"                    user:$R "$CNT"                         "err:42501"
c "inactive admin signals denied"              user:$E "$CNT"                         "err:42501"
c "departed staff signals denied"              user:$I "$CNT"                         "err:42501"
c "missing-profile signals denied"             user:$M "$CNT"                         "err:42501"
c "no-claims authenticated denied"             noclaims "$CNT"                        "err:42501"
c "forged service claim (role authenticated) denied" forged-svc "$CNT"               "err:42501"
c "forged admin sub as anon denied"            forged-sub "$CNT"                      "err:42501"
c "no-claims postgres session not exempt"      sched "$CNT"                           "err:42501"
c "window to<from rejected"                    user:$A "(SELECT count(*) FROM public.get_theatre_session_label_signals('2030-02-01','2030-01-01'))" "err:22023"
c "window >400 days rejected"                  user:$A "(SELECT count(*) FROM public.get_theatre_session_label_signals('2030-01-01','2031-03-01'))" "err:22023"
c "null window rejected"                       user:$A "(SELECT count(*) FROM public.get_theatre_session_label_signals(NULL,'2030-01-01'))" "err:22023"
cw "blank value rejected"                       service "WITH u AS (UPDATE $T SET list_titles=ARRAY['  '] WHERE theatre_session_id='$S3' RETURNING 1) SELECT 'ok:' || count(*) FROM u" "err:22023"
cw "oversize value rejected"                    service "WITH u AS (UPDATE $T SET list_notes=ARRAY[repeat('x',2001)] WHERE theatre_session_id='$S3' RETURNING 1) SELECT 'ok:' || count(*) FROM u" "err:22023"
cw "more than 20 values rejected"               service "WITH u AS (UPDATE $T SET list_titles=ARRAY(SELECT 't'||g FROM generate_series(1,21) g) WHERE theatre_session_id='$S3' RETURNING 1) SELECT 'ok:' || count(*) FROM u" "err:23514"
cw "unknown tag rejected"                       service "WITH u AS (UPDATE $T SET title_tags=ARRAY['Laser'] WHERE theatre_session_id='$S3' RETURNING 1) SELECT 'ok:' || count(*) FROM u" "err:23514"
cw "service upsert replaces (confirmed removal)" service "WITH u AS (INSERT INTO $T (theatre_session_id, list_titles, evidence_complete, source_rows_seen) VALUES ('$S2','{}',true,1) ON CONFLICT (theatre_session_id) DO UPDATE SET list_titles=EXCLUDED.list_titles, title_tags='{}' RETURNING cardinality(list_titles)) SELECT 'ok:' || string_agg(cardinality::text,',') FROM u" "ok:0"
c "staffA sees removal as blank"               user:$A "(SELECT has_title::text || ',' || coalesce(title_group::text,'-') FROM public.get_theatre_session_label_signals('2030-01-07','2030-01-07') WHERE theatre_session_id='$S2')" "ok:f,-"
c "legacy title/coordinator note untouched"    user:$A "(SELECT string_agg(coalesce(surgical_consultant,'-')||'/'||coalesce(notes,'-'), ';' ORDER BY id) FROM public.theatre_sessions WHERE id IN ('$S1','$S2'))" "ok:legacy title/-;-/coordinator note"

# Metadata: least privilege on the relation and function.
META="(SELECT concat_ws(',',
  has_table_privilege('authenticated','$T','SELECT'), has_table_privilege('authenticated','$T','INSERT'),
  has_table_privilege('authenticated','$T','UPDATE'), has_table_privilege('authenticated','$T','DELETE'),
  has_table_privilege('anon','$T','SELECT'), has_table_privilege('service_role','$T','SELECT'),
  (SELECT relrowsecurity FROM pg_class WHERE oid='$T'::regclass),
  (SELECT count(*) FROM pg_policy WHERE polrelid='$T'::regclass),
  has_function_privilege('anon','public.get_theatre_session_label_signals(date,date)','EXECUTE'),
  has_function_privilege('authenticated','public.get_theatre_session_label_signals(date,date)','EXECUTE'),
  (SELECT prosecdef FROM pg_proc WHERE oid='public.get_theatre_session_label_signals(date,date)'::regprocedure),
  (SELECT array_to_string(proconfig,';') FROM pg_proc WHERE oid='public.get_theatre_session_label_signals(date,date)'::regprocedure),
  has_function_privilege('authenticated','public._validate_theatre_session_source_labels()','EXECUTE')))"
c "metadata: privileges, RLS, no policies, definer config" sched "$META" "ok:f,f,f,f,f,t,t,0,f,t,t,search_path=public,f"

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
PGRST_DB_URI="postgres://authenticator@/postgres?host=$D&port=55460" PGRST_DB_SCHEMAS=public PGRST_DB_ANON_ROLE=anon \
PGRST_JWT_SECRET="$SECRET" PGRST_SERVER_PORT=55461 PGRST_SERVER_HOST=127.0.0.1 PGRST_LOG_LEVEL=crit postgrest >"$D/pgrst.log" 2>&1 &
RPID=$!
for _ in $(seq 1 100); do [ "$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:55461/)" = 200 ] && break; sleep 0.2; done
h() { # name method token path body expect_code body_regex
  local auth=(); [ -n "$3" ] && auth=(-H "Authorization: Bearer $3")
  local out
  if [ "$2" = GET ]; then out=$(curl -s -w '\n%{http_code}' "${auth[@]}" "http://127.0.0.1:55461$4")
  else out=$(curl -s -w '\n%{http_code}' "${auth[@]}" -H 'Content-Type: application/json' -X POST -d "$5" "http://127.0.0.1:55461$4"); fi
  local code; code=$(echo "$out" | tail -1); local body; body=$(echo "$out" | sed '$d')
  local m=no; echo "$body" | grep -Eq "$7" && m=yes
  $H -U harness -c "INSERT INTO results VALUES ('postgrest', \$a\$$1\$a\$, \$e\$$6|yes\$e\$, \$v\$$code|$m\$v\$)"
}
W='{"p_from":"2030-01-01","p_to":"2030-01-31"}'
h "GET staffA raw table denied"           GET  "$TA" "/theatre_session_source_labels?select=list_titles" "" 403 '42501'
h "GET admin raw table denied"            GET  "$TD" "/theatre_session_source_labels?select=list_titles" "" 403 '42501'
h "GET anon raw table denied"             GET  ""    "/theatre_session_source_labels" "" 401 '42501'
h "POST staffA raw insert denied"         POST "$TA" "/theatre_session_source_labels" "{\"theatre_session_id\":\"$S5\"}" 403 '42501'
h "GET service reads raw table"           GET  "$TS" "/theatre_session_source_labels?select=list_titles&theatre_session_id=eq.$S1" "" 200 'SYNTHSECRET VRAM list'
h "POST staffA signals (derived)"         POST "$TA" "/rpc/get_theatre_session_label_signals" "$W" 200 '"title_tags":\["VRAM"\]'
h "POST staffA signals have no raw text"  POST "$TA" "/rpc/get_theatre_session_label_signals" "$W" 200 '^[^S]*$'
h "GET staffA signals paged (limit/offset)" GET "$TA" "/rpc/get_theatre_session_label_signals?p_from=2030-01-01&p_to=2030-01-31&select=has_title&order=theatre_session_id&limit=2&offset=2" "" 200 '^\[\{"has_title":false\}, ?\{"has_title":false\}\]$'
h "POST roleless signals denied"          POST "$TR" "/rpc/get_theatre_session_label_signals" "$W" 403 '42501'
h "POST anon signals denied"              POST ""    "/rpc/get_theatre_session_label_signals" "$W" 401 '42501'
h "POST forged service JWT rejected"      POST "$TBAD" "/rpc/get_theatre_session_label_signals" "$W" 401 'PGRST'
h "POST service signals"                  POST "$TS" "/rpc/get_theatre_session_label_signals" "$W" 200 '"evidence_complete":false'

PHASE=sql
cw "cascade: deleting a session removes its labels" sched "WITH d AS (DELETE FROM public.theatre_sessions WHERE id='$S4' RETURNING 1) SELECT 'ok:' || (SELECT count(*) FROM d)::text || ',' || (SELECT count(*) FROM $T WHERE theatre_session_id='$S4')" "ok:1,0"

$H -U harness -P pager=off -c "SELECT CASE WHEN expected=actual THEN 'PASS' ELSE 'FAIL' END AS result, phase, name, expected, actual FROM results ORDER BY phase DESC, 1, 3"
FAILS=$($H -U harness -At -c "SELECT count(*) FROM results WHERE expected<>actual")
TOTAL=$($H -U harness -At -c "SELECT count(*) FROM results")
echo "source-labels harness ($(postgres --version), $(postgrest --version 2>/dev/null | head -1)): $TOTAL cases, $FAILS failures"
[ "$FAILS" = 0 ]
