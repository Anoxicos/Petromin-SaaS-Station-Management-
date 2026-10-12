#!/bin/sh
set -eu

target_database="${1:-}"
if [ -z "$target_database" ] || ! printf '%s' "$target_database" | grep -Eq '^[a-z][a-z0-9_]{2,62}$'; then
  echo "Usage: restore-latest.sh <new_database_name>" >&2
  exit 2
fi

backup=/backups/station_platform-latest.dump
if [ ! -s "$backup" ]; then
  echo "No completed backup exists at $backup" >&2
  exit 1
fi

createdb --host "$PGHOST" --username "$PGUSER" --owner station_owner "$target_database"
pg_restore --host "$PGHOST" --username "$PGUSER" --role station_owner --no-owner \
  --dbname "$target_database" "$backup"
echo "Restored the latest snapshot into $target_database; source database was not changed"
