#!/bin/sh
set -eu

interval="${BACKUP_INTERVAL_SECONDS:-86400}"
case "$interval" in
  ''|*[!0-9]*) echo "BACKUP_INTERVAL_SECONDS must be a positive integer" >&2; exit 1 ;;
esac
if [ "$interval" -lt 60 ]; then
  echo "BACKUP_INTERVAL_SECONDS must be at least 60" >&2
  exit 1
fi

while :; do
  temporary=/backups/station_platform-latest.dump.tmp
  if pg_dump --format=custom --no-owner --file="$temporary"; then
    mv -f "$temporary" /backups/station_platform-latest.dump
    echo "Database backup completed at $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  else
    rm -f "$temporary"
    echo "Database backup failed; previous completed backup was kept" >&2
  fi
  sleep "$interval"
done
