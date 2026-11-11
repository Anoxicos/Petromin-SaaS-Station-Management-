#!/bin/sh
set -eu

interval="${BACKUP_INTERVAL_SECONDS:-86400}"
case "$interval" in
  ''|*[!0-9]*) exit 1 ;;
esac
if [ "$interval" -lt 60 ] || [ ! -s /backups/station_platform-latest.dump ] \
  || [ ! -s /backups/station_platform-latest.success ]; then
  exit 1
fi

local_epoch="$(sed -n '1p' /backups/station_platform-latest.success)"
case "$local_epoch" in ''|*[!0-9]*) exit 1 ;; esac
now="$(date -u +%s)"
if [ "$local_epoch" -gt "$now" ] || [ "$((now - local_epoch))" -ge "$((interval * 2))" ]; then
  exit 1
fi

repository="${OFFSITE_RESTIC_REPOSITORY:-}"
if [ -z "$repository" ]; then
  exit 0
fi
if [ ! -s /backups/station_platform-offsite.success ]; then
  exit 1
fi

offsite_epoch="$(sed -n '1p' /backups/station_platform-offsite.success)"
saved_fingerprint="$(sed -n '2p' /backups/station_platform-offsite.success)"
case "$offsite_epoch" in ''|*[!0-9]*) exit 1 ;; esac
case "$saved_fingerprint" in ''|*[!0123456789abcdef]*) exit 1 ;; esac
if [ "${#saved_fingerprint}" -ne 64 ]; then
  exit 1
fi
expected_fingerprint="$(printf '%s' "$repository" | sha256sum | cut -d ' ' -f 1)"
if [ "$saved_fingerprint" != "$expected_fingerprint" ] \
  || [ "$offsite_epoch" -gt "$now" ] \
  || [ "$((now - offsite_epoch))" -ge "$((interval * 2))" ]; then
  exit 1
fi
