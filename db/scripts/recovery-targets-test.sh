#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$script_dir/recovery-targets.sh"

expect_success() {
  label=$1
  shift
  if ! "$@"; then
    echo "FAIL $label: expected success" >&2
    exit 1
  fi
  echo "PASS $label"
}

expect_failure() {
  label=$1
  shift
  if "$@" >/dev/null 2>&1; then
    echo "FAIL $label: expected rejection" >&2
    exit 1
  fi
  echo "PASS $label"
}

expect_success "unset recovery target stays informational" validate_recovery_target RPO_TARGET_SECONDS ""
expect_success "positive integer recovery target accepted" validate_recovery_target RTO_TARGET_SECONDS 3600
expect_failure "zero target rejected" validate_recovery_target RPO_TARGET_SECONDS 0
expect_failure "non-integer target rejected" validate_recovery_target RPO_TARGET_SECONDS 30s
expect_failure "overlong target rejected" validate_recovery_target RPO_TARGET_SECONDS 12345678901
expect_success "measurement below target passes" check_recovery_target RPO_TARGET_SECONDS 60 59
expect_success "measurement equal to target passes" check_recovery_target RTO_TARGET_SECONDS 60 60
expect_failure "RPO measurement above target fails" check_recovery_target RPO_TARGET_SECONDS 60 61
expect_failure "RTO measurement above target fails" check_recovery_target RTO_TARGET_SECONDS 60 61
elapsed=$(recovery_elapsed_upper_seconds 100 100)
[ "$elapsed" = "1" ] || { echo "FAIL same-second elapsed upper bound: got $elapsed" >&2; exit 1; }
echo "PASS same-second elapsed upper bound rounds up"
elapsed=$(recovery_elapsed_upper_seconds 100 101)
[ "$elapsed" = "2" ] || { echo "FAIL one-second elapsed upper bound: got $elapsed" >&2; exit 1; }
echo "PASS fractional elapsed time cannot round down"
expect_failure "reversed elapsed endpoints rejected" recovery_elapsed_upper_seconds 101 100
expect_failure "malformed elapsed endpoint rejected" recovery_elapsed_upper_seconds now 101
