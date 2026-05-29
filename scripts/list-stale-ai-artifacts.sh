#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
FORTIOS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ROOT_DIR="$(cd "$FORTIOS_DIR/../.." && pwd)"

MODE="${1:-list}"
QUARANTINE_DIR="${QUARANTINE_DIR:-$ROOT_DIR/.tmp/archive/fortios-ai-artifacts}"

mapfile -t root_pointer_candidates < <(
  find "$ROOT_DIR/tmp" -maxdepth 1 -type f -name '*fortios*latest*.txt' \
    ! -name 'fortios-pr30-ai-snapshot-hygiene-cleanup-latest.txt' \
    ! -name 'fortios-ai-artifact-quarantine-approval-latest.txt' \
    ! -name 'fortios-pr30-ci-stabilization-latest.txt' \
    ! -name 'fortios-pr30-create-vault-runtime-regression-latest.txt' \
    ! -name 'fortios-pr30-create-vault-runtime-root-cause-latest.txt' \
    ! -name 'fortios-pr30-fresh-state-workspace-hygiene-latest.txt' \
    ! -name 'fortios-pr30-wkwebview-secure-field-research-validate-latest.txt' \
    2>/dev/null | sort
)

mapfile -t root_dir_candidates < <(
  find "$ROOT_DIR/tmp" -maxdepth 1 -type d -name 'fortios-*' \
    ! -name 'fortios-pr30-ai-snapshot-hygiene-cleanup-*' \
    ! -name 'fortios-ai-artifact-quarantine-approval-*' \
    ! -name 'fortios-pr30-create-vault-runtime-root-cause-*' \
    ! -name 'fortios-pr30-fresh-state-workspace-hygiene-*' \
    ! -name 'fortios-pr30-create-vault-runtime-regression-*' \
    ! -name 'fortios-pr30-wkwebview-secure-field-research-validate-*' \
    ! -name 'fortios-pr30-ci-stabilization-*' \
    2>/dev/null | sort
)

mapfile -t fortios_build_candidates < <(
  find "$FORTIOS_DIR/build" -maxdepth 1 -type d \
    \( -name '*create*' -o -name '*passcode*' -o -name '*runtime*' -o -name '*loopback*' -o -name 'TestResults*.xcresult' \) \
    ! -name 'passcoded-vault-create-timeout-*' \
    ! -name 'known-good-loopback-checkpoint' \
    ! -name 'loopback-origin' \
    ! -name 'passcode-focus-manual-repro-*' \
    ! -name 'hardened-loopback-*' \
    2>/dev/null | sort
)

print_group() {
  local title="$1"
  shift
  local items=("$@")
  echo "$title"
  if [[ ${#items[@]} -eq 0 ]]; then
    echo "  (none)"
    return
  fi
  local item
  for item in "${items[@]}"; do
    echo "  $item"
  done
}

list_all() {
  print_group "ROOT_TMP_POINTER_CANDIDATES" "${root_pointer_candidates[@]}"
  echo
  print_group "ROOT_TMP_DIR_CANDIDATES" "${root_dir_candidates[@]}"
  echo
  print_group "FORTIOS_BUILD_CANDIDATES" "${fortios_build_candidates[@]}"
}

quarantine_all() {
  mkdir -p "$QUARANTINE_DIR"
  local item
  for item in "${root_pointer_candidates[@]}" "${root_dir_candidates[@]}" "${fortios_build_candidates[@]}"; do
    if [[ -z "$item" || ! -e "$item" ]]; then
      continue
    fi
    echo "QUARANTINE $item"
    mv "$item" "$QUARANTINE_DIR/"
  done
  echo "QUARANTINE_DIR=$QUARANTINE_DIR"
}

case "$MODE" in
  list)
    list_all
    ;;
  quarantine)
    quarantine_all
    ;;
  *)
    echo "Usage: $0 [list|quarantine]"
    exit 1
    ;;
esac
