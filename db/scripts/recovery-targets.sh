#!/bin/sh

validate_recovery_target() {
  target_name=$1
  target_value=$2
  if [ -z "$target_value" ]; then
    return 0
  fi
  if ! printf '%s' "$target_value" | grep -Eq '^[0-9]{1,10}$' \
    || ! printf '%s' "$target_value" | grep -Eq '[1-9]'; then
    echo "$target_name must be a positive whole number of up to 10 digits when set" >&2
    return 2
  fi
}

check_recovery_target() {
  target_name=$1
  target_value=$2
  observed_value=$3
  validate_recovery_target "$target_name" "$target_value" || return $?
  if [ -z "$target_value" ]; then
    return 0
  fi
  case "$observed_value" in
    ''|*[!0-9]*) echo "Observed value for $target_name must be a non-negative whole number of seconds" >&2; return 2 ;;
  esac
  if [ "$observed_value" -gt "$target_value" ]; then
    echo "Observed $target_name measurement $observed_value seconds exceeds target $target_value seconds" >&2
    return 1
  fi
}

recovery_elapsed_upper_seconds() {
  started_epoch=$1
  finished_epoch=$2
  case "$started_epoch" in
    ''|*[!0-9]*|???????????*) echo "Elapsed time endpoints must be whole Unix seconds" >&2; return 2 ;;
  esac
  case "$finished_epoch" in
    ''|*[!0-9]*|???????????*) echo "Elapsed time endpoints must be whole Unix seconds" >&2; return 2 ;;
  esac
  if [ "$finished_epoch" -lt "$started_epoch" ]; then
    echo "Elapsed time endpoint is earlier than its start" >&2
    return 2
  fi
  # Epoch timestamps have whole-second precision; add one to avoid rounding a
  # fractional duration down when evaluating a service target.
  printf '%s\n' "$((finished_epoch - started_epoch + 1))"
}
