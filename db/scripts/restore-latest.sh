#!/bin/sh
set -eu

. /scripts/recovery-targets.sh

target_database="${1:-}"
if [ -z "$target_database" ] || ! printf '%s' "$target_database" | grep -Eq '^[a-z][a-z0-9_]{2,62}$'; then
  echo "Usage: restore-latest.sh <new_database_name>" >&2
  exit 2
fi

validate_recovery_target RPO_TARGET_SECONDS "${RPO_TARGET_SECONDS:-}" || exit $?
validate_recovery_target RTO_TARGET_SECONDS "${RTO_TARGET_SECONDS:-}" || exit $?

backup="${RESTORE_BACKUP_PATH:-/backups/station_platform-latest.dump}"
if [ ! -s "$backup" ]; then
  echo "No completed backup exists at $backup" >&2
  exit 1
fi

success_marker="${RESTORE_SUCCESS_MARKER:-/backups/station_platform-latest.success}"
if [ ! -s "$success_marker" ]; then
  echo "Backup has no successful completion marker; refusing to claim a verified restore" >&2
  exit 1
fi

restore_started="$(date -u +%s)"
backup_completed="$(cat "$success_marker")"
case "$backup_completed" in ''|*[!0-9]*) echo "Invalid backup success marker" >&2; exit 1 ;; esac
if [ "$backup_completed" -gt "$restore_started" ]; then
  echo "Backup success marker is in the future" >&2
  exit 1
fi
backup_age_seconds=$(recovery_elapsed_upper_seconds "$backup_completed" "$restore_started")
createdb --host "$PGHOST" --username "$PGUSER" --owner station_owner "$target_database"
pg_restore --host "$PGHOST" --username "$PGUSER" --role station_owner --no-owner \
  --dbname "$target_database" "$backup"

migration_summary="$(psql --no-psqlrc --tuples-only --no-align --set=ON_ERROR_STOP=1 \
  --host "$PGHOST" --username "$PGUSER" --dbname "$target_database" \
  --command "SELECT count(*)::text || '|' || COALESCE(max(version),'') FROM schema_migrations")"
migration_count=${migration_summary%%|*}
latest_migration=${migration_summary#*|}
if [ "$migration_count" -lt 1 ] || [ -z "$latest_migration" ]; then
  echo "Restored database has no recorded migrations" >&2
  exit 1
fi
source_latest_migration="$(psql --no-psqlrc --tuples-only --no-align --set=ON_ERROR_STOP=1 \
  --host "$PGHOST" --username "$PGUSER" --dbname "$PGDATABASE" \
  --command "SELECT COALESCE(max(version),'') FROM schema_migrations")"
if [ "$latest_migration" != "$source_latest_migration" ]; then
  echo "Restored snapshot migration $latest_migration does not match source $source_latest_migration" >&2
  exit 1
fi

role_flags="$(psql --no-psqlrc --tuples-only --no-align --set=ON_ERROR_STOP=1 \
  --host "$PGHOST" --username "$PGUSER" --dbname "$target_database" \
  --command "SELECT rolsuper::text || ',' || rolbypassrls::text FROM pg_roles WHERE rolname='station_app'")"
if [ "$role_flags" != "false,false" ]; then
  echo "Restored station_app role is missing or has elevated privileges: $role_flags" >&2
  exit 1
fi

rls_enabled_count="$(psql --no-psqlrc --tuples-only --no-align --set=ON_ERROR_STOP=1 \
  --host "$PGHOST" --username "$PGUSER" --dbname "$target_database" \
  --command "SELECT count(*) FROM pg_class WHERE oid IN (
    to_regclass('public.app_users'),to_regclass('public.vouchers'),to_regclass('public.voucher_movements'),
    to_regclass('public.customer_credit_movements'),to_regclass('public.station_fuel_variance_thresholds'),
    to_regclass('public.station_cash_card_variance_thresholds'),to_regclass('public.sales_transactions')) AND relrowsecurity")"
forced_rls_count="$(psql --no-psqlrc --tuples-only --no-align --set=ON_ERROR_STOP=1 \
  --host "$PGHOST" --username "$PGUSER" --dbname "$target_database" \
  --command "SELECT count(*) FROM pg_class WHERE oid IN (
    to_regclass('public.vouchers'),to_regclass('public.voucher_movements'),
    to_regclass('public.customer_credit_movements'),to_regclass('public.station_fuel_variance_thresholds'),
    to_regclass('public.station_cash_card_variance_thresholds'),to_regclass('public.sales_transactions')) AND relrowsecurity AND relforcerowsecurity")"
app_users_owner="$(psql --no-psqlrc --tuples-only --no-align --set=ON_ERROR_STOP=1 \
  --host "$PGHOST" --username "$PGUSER" --dbname "$target_database" \
  --command "SELECT owner.rolname FROM pg_class table_row JOIN pg_roles owner ON owner.oid=table_row.relowner WHERE table_row.oid='public.app_users'::regclass")"
if [ "$rls_enabled_count" -ne 7 ] || [ "$forced_rls_count" -ne 6 ] || [ "$app_users_owner" != "station_owner" ]; then
  echo "Restored RLS posture is unexpected (enabled=$rls_enabled_count/7 forced=$forced_rls_count/6 app_users_owner=$app_users_owner)" >&2
  exit 1
fi

if ! psql --no-psqlrc --tuples-only --no-align --set=ON_ERROR_STOP=1 \
  --host "$PGHOST" --username "$PGUSER" --dbname "$target_database" \
  --command "SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='sales_transactions' AND column_name='credit_schedule_snapshot') AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='customer_payment_allocations' AND column_name='installment_number') AND has_table_privilege('station_app','public.sales_transactions','SELECT')" | grep -qx t; then
  echo "Restored database is missing M3 credit schedule/allocation fields or app read access" >&2
  exit 1
fi

if ! psql --no-psqlrc --tuples-only --no-align --set=ON_ERROR_STOP=1 \
  --host "$PGHOST" --username "$PGUSER" --dbname "$target_database" \
  --command "SELECT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname='meter_reading_batches_validated_history_idx')" | grep -qx t; then
  echo "Restored database is missing the validated meter-history lookup index" >&2
  exit 1
fi

if ! psql --no-psqlrc --tuples-only --no-align --set=ON_ERROR_STOP=1 \
  --host "$PGHOST" --username "$PGUSER" --dbname "$target_database" \
  --command "SELECT has_table_privilege('station_app','public.station_cash_card_variance_thresholds','SELECT')" | grep -qx t; then
  echo "Restored app role is missing cash/card policy read access" >&2
  exit 1
fi

if ! psql --no-psqlrc --tuples-only --no-align --set=ON_ERROR_STOP=1 \
  --host "$PGHOST" --username "$PGUSER" --dbname "$target_database" \
  --command "SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='station_day_inputs' AND column_name='currency_code') AND has_table_privilege('station_app','public.station_day_inputs','SELECT')" | grep -qx t; then
  echo "Restored database is missing the M2 daily-collection currency field or app read access" >&2
  exit 1
fi

restore_finished="$(date -u +%s)"
restore_seconds=$(recovery_elapsed_upper_seconds "$restore_started" "$restore_finished")
check_recovery_target RPO_TARGET_SECONDS "${RPO_TARGET_SECONDS:-}" "$backup_age_seconds" || exit $?
check_recovery_target RTO_TARGET_SECONDS "${RTO_TARGET_SECONDS:-}" "$restore_seconds" || exit $?
echo "Restore verified in $target_database; source database was not changed"
echo "migrations=$migration_count latest=$latest_migration rls_enabled=$rls_enabled_count forced_rls=$forced_rls_count app_users_owner=$app_users_owner app_role=$role_flags credit_schedule=verified installment_allocation=verified meter_history_index=verified daily_collection_currency=verified"
echo "observed_snapshot_age_upper_seconds=$backup_age_seconds rpo_target_seconds=${RPO_TARGET_SECONDS:-unset} observed_restore_duration_upper_seconds=$restore_seconds rto_target_seconds=${RTO_TARGET_SECONDS:-unset}"
