#!/bin/sh
set -eu

target_database="${1:-}"
if [ -z "$target_database" ] || ! printf '%s' "$target_database" | grep -Eq '^[a-z][a-z0-9_]{2,62}$'; then
  echo "Usage: restore-offsite.sh <new_database_name>" >&2
  exit 2
fi
if [ -z "${OFFSITE_RESTIC_REPOSITORY:-}" ] || [ -z "${RESTIC_PASSWORD:-}" ]; then
  echo "OFFSITE_RESTIC_REPOSITORY and RESTIC_PASSWORD are required" >&2
  exit 2
fi

export RESTIC_REPOSITORY="$OFFSITE_RESTIC_REPOSITORY"
restore_directory="$(mktemp -d /tmp/station-platform-offsite-restore.XXXXXX)"
trap 'rm -rf "$restore_directory"' EXIT HUP INT TERM

RESTIC_PASSWORD="$RESTIC_PASSWORD" restic dump --tag station-platform latest /backups/station_platform-latest.dump \
  > "$restore_directory/station_platform-latest.dump"
RESTIC_PASSWORD="$RESTIC_PASSWORD" restic dump --tag station-platform latest /backups/station_platform-latest.success \
  > "$restore_directory/station_platform-latest.success"
if [ ! -s "$restore_directory/station_platform-latest.dump" ]; then
  echo "Latest off-site snapshot has no database dump" >&2
  exit 1
fi
case "$(cat "$restore_directory/station_platform-latest.success")" in
  ''|*[!0-9]*) echo "Latest off-site snapshot has no valid completion marker" >&2; exit 1 ;;
esac

RESTORE_BACKUP_PATH="$restore_directory/station_platform-latest.dump" \
RESTORE_SUCCESS_MARKER="$restore_directory/station_platform-latest.success" \
  /scripts/restore-latest.sh "$target_database"
