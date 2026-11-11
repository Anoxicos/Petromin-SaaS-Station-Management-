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

offsite_repository="${OFFSITE_RESTIC_REPOSITORY:-}"
offsite_repository_fingerprint=
if [ -n "$offsite_repository" ]; then
  if [ -z "${RESTIC_PASSWORD:-}" ]; then
    echo "RESTIC_PASSWORD is required when OFFSITE_RESTIC_REPOSITORY is configured" >&2
    exit 1
  fi
  export RESTIC_REPOSITORY="$offsite_repository"
  offsite_repository_fingerprint="$(printf '%s' "$offsite_repository" | sha256sum | cut -d ' ' -f 1)"
fi

validate_retention() {
  name=$1
  value=$2
  if [ -n "$value" ] && { ! printf '%s' "$value" | grep -Eq '^[0-9]{1,6}$' || [ "$value" -lt 1 ]; }; then
    echo "$name must be a positive whole number when set" >&2
    exit 1
  fi
}

validate_retention OFFSITE_KEEP_LAST "${OFFSITE_KEEP_LAST:-}"
validate_retention OFFSITE_KEEP_DAILY "${OFFSITE_KEEP_DAILY:-}"
validate_retention OFFSITE_KEEP_WEEKLY "${OFFSITE_KEEP_WEEKLY:-}"
validate_retention OFFSITE_KEEP_MONTHLY "${OFFSITE_KEEP_MONTHLY:-}"
validate_retention OFFSITE_KEEP_YEARLY "${OFFSITE_KEEP_YEARLY:-}"

backup_once() {
  temporary=/backups/station_platform-latest.dump.tmp
  if ! pg_dump --format=custom --no-owner --file="$temporary"; then
    rm -f "$temporary"
    echo "Database backup failed; previous completed backup was kept" >&2
    return 1
  fi

  if ! mv -f "$temporary" /backups/station_platform-latest.dump; then
    echo "Could not promote the completed local database dump" >&2
    return 1
  fi
  completed_epoch="$(date -u +%s)"
  if ! printf '%s\n' "$completed_epoch" > /backups/station_platform-latest.success.tmp \
    || ! mv -f /backups/station_platform-latest.success.tmp /backups/station_platform-latest.success; then
    rm -f /backups/station_platform-latest.success.tmp
    echo "Could not write the local database backup completion marker" >&2
    return 1
  fi

  if [ -n "$offsite_repository" ]; then
    if ! restic cat config >/dev/null 2>&1; then
      if ! restic init; then
        echo "Could not initialize or access the off-site Restic repository" >&2
        return 1
      fi
    fi
    if ! restic backup --tag station-platform \
      /backups/station_platform-latest.dump /backups/station_platform-latest.success; then
      echo "Off-site Restic backup failed; the prior off-site success marker was kept" >&2
      return 1
    fi

    retention_args=
    set --
    if [ -n "${OFFSITE_KEEP_LAST:-}" ]; then set -- "$@" --keep-last "$OFFSITE_KEEP_LAST"; retention_args=1; fi
    if [ -n "${OFFSITE_KEEP_DAILY:-}" ]; then set -- "$@" --keep-daily "$OFFSITE_KEEP_DAILY"; retention_args=1; fi
    if [ -n "${OFFSITE_KEEP_WEEKLY:-}" ]; then set -- "$@" --keep-weekly "$OFFSITE_KEEP_WEEKLY"; retention_args=1; fi
    if [ -n "${OFFSITE_KEEP_MONTHLY:-}" ]; then set -- "$@" --keep-monthly "$OFFSITE_KEEP_MONTHLY"; retention_args=1; fi
    if [ -n "${OFFSITE_KEEP_YEARLY:-}" ]; then set -- "$@" --keep-yearly "$OFFSITE_KEEP_YEARLY"; retention_args=1; fi
    if [ -n "$retention_args" ]; then
      if ! restic forget --tag station-platform --prune "$@"; then
        echo "Off-site backup succeeded but configured retention pruning failed" >&2
        return 1
      fi
    fi

    if ! printf '%s\n%s\n' "$completed_epoch" "$offsite_repository_fingerprint" \
      > /backups/station_platform-offsite.success.tmp \
      || ! mv -f /backups/station_platform-offsite.success.tmp /backups/station_platform-offsite.success; then
      rm -f /backups/station_platform-offsite.success.tmp
      echo "Off-site backup succeeded but its completion marker could not be updated" >&2
      return 1
    fi
    echo "Encrypted off-site backup completed at $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  fi

  echo "Database backup completed at $(date -u +%Y-%m-%dT%H:%M:%SZ)"
}

run_once="${BACKUP_RUN_ONCE:-0}"
case "$run_once" in
  0|1) ;;
  *) echo "BACKUP_RUN_ONCE must be 0 or 1" >&2; exit 1 ;;
esac

while :; do
  if backup_once; then
    backup_status=0
  else
    backup_status=$?
  fi
  if [ "$run_once" = 1 ]; then
    exit "$backup_status"
  fi
  sleep "$interval"
done
