#!/usr/bin/env bash

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

XCODE_PROJECT="${XCODE_PROJECT:-xcodeproj/KeriWallet/KeriWallet.xcodeproj}"
SCHEME="${SCHEME:-KeriWallet}"
DERIVED_DATA_PATH="${DERIVED_DATA_PATH:-build/DerivedData-sim}"
TEST_RESULTS_PATH="${TEST_RESULTS_PATH:-build/TestResults-sim.xcresult}"
BUILD_RESULTS_PATH="${BUILD_RESULTS_PATH:-build/TestResults-build-for-testing.xcresult}"
CI_DIAGNOSTICS_DIR="${CI_DIAGNOSTICS_DIR:-build/ci-diagnostics}"
SIMULATOR_NAME="${SIMULATOR_NAME:-iPhone 17 Pro}"
SIMULATOR_OS="${SIMULATOR_OS:-auto}"

timestamp() {
  date -u +"%Y-%m-%dT%H:%M:%SZ"
}

log_phase() {
  echo "$(timestamp) $*"
}

ensure_paths() {
  mkdir -p "$(dirname "${TEST_RESULTS_PATH}")" "${DERIVED_DATA_PATH}" "${CI_DIAGNOSTICS_DIR}"
}

write_github_env() {
  local key="$1"
  local value="$2"

  if [[ -n "${GITHUB_ENV:-}" ]]; then
    printf '%s=%s\n' "${key}" "${value}" >> "${GITHUB_ENV}"
  fi
}

resolve_simulator_udid() {
  if [[ -n "${SIMULATOR_UDID:-}" ]]; then
    printf '%s\n' "${SIMULATOR_UDID}"
    return 0
  fi

  bash scripts/resolve-simulator-udid.sh "${SIMULATOR_NAME}" "${SIMULATOR_OS}"
}

find_xctestrun() {
  local candidates=("${DERIVED_DATA_PATH}"/Build/Products/*.xctestrun)

  if [[ ! -e "${candidates[0]}" ]]; then
    echo "ERROR: no .xctestrun file found under ${DERIVED_DATA_PATH}/Build/Products" >&2
    return 1
  fi

  printf '%s\n' "${candidates[0]}"
}

record_artifact_state() {
  {
    echo "timestamp=$(timestamp)"

    for path in \
      "${BUILD_RESULTS_PATH}" \
      "${TEST_RESULTS_PATH}" \
      "${DERIVED_DATA_PATH}/Logs/Test" \
      "${CI_DIAGNOSTICS_DIR}"
    do
      if [[ -e "${path}" ]]; then
        echo "present ${path}"
      else
        echo "missing ${path}"
      fi
    done
  } | tee "${CI_DIAGNOSTICS_DIR}/artifact-state.txt"
}

bootstrap() {
  local simulator_udid

  ensure_paths
  rm -rf "${TEST_RESULTS_PATH}" "${BUILD_RESULTS_PATH}"

  simulator_udid="$(resolve_simulator_udid)"
  write_github_env "SIMULATOR_UDID" "${simulator_udid}"
  printf '%s\n' "${simulator_udid}" > "${CI_DIAGNOSTICS_DIR}/simulator-udid.txt"

  log_phase "swift-ci bootstrap start"
  log_phase "resolved simulator ${SIMULATOR_NAME} (${SIMULATOR_OS}) -> ${simulator_udid}"

  {
    echo "timestamp=$(timestamp)"
    echo "xcodebuild_version"
    xcodebuild -version
    echo
    echo "simctl_list_runtimes"
    xcrun simctl list runtimes
    echo
    echo "simctl_list_devices_available"
    xcrun simctl list devices available
  } | tee "${CI_DIAGNOSTICS_DIR}/preflight.log"

  log_phase "boot simulator start"
  xcrun simctl boot "${simulator_udid}" >/dev/null 2>&1 || true
  {
    echo "timestamp=$(timestamp)"
    echo "bootstatus_helper=scripts/wait-for-simulator-boot.sh"
  } | tee "${CI_DIAGNOSTICS_DIR}/bootstatus.log"
  bash scripts/wait-for-simulator-boot.sh "${simulator_udid}" 180 2>&1 | tee -a "${CI_DIAGNOSTICS_DIR}/bootstatus.log"
  xcrun simctl list devices booted | tee "${CI_DIAGNOSTICS_DIR}/booted-devices.log"
  record_artifact_state
  log_phase "swift-ci bootstrap end"
}

build_for_testing() {
  local simulator_udid

  ensure_paths
  simulator_udid="$(resolve_simulator_udid)"

  log_phase "build-for-testing start"
  xcodebuild build-for-testing \
    -project "${XCODE_PROJECT}" \
    -scheme "${SCHEME}" \
    -configuration Debug \
    -destination "id=${simulator_udid}" \
    -destination-timeout 120 \
    -resultBundlePath "${BUILD_RESULTS_PATH}" \
    -derivedDataPath "${DERIVED_DATA_PATH}" \
    -parallel-testing-enabled NO \
    -showBuildTimingSummary | tee "${CI_DIAGNOSTICS_DIR}/build-for-testing.log"
  record_artifact_state
  log_phase "build-for-testing end"
}

test_without_building() {
  local simulator_udid
  local xctestrun_path

  ensure_paths
  simulator_udid="$(resolve_simulator_udid)"
  xctestrun_path="$(find_xctestrun)"

  log_phase "test-without-building start"
  log_phase "using xctestrun ${xctestrun_path}"
  xcodebuild test-without-building \
    -xctestrun "${xctestrun_path}" \
    -destination "id=${simulator_udid}" \
    -destination-timeout 120 \
    -resultBundlePath "${TEST_RESULTS_PATH}" \
    -derivedDataPath "${DERIVED_DATA_PATH}" \
    -parallel-testing-enabled NO \
    -showBuildTimingSummary | tee "${CI_DIAGNOSTICS_DIR}/test-without-building.log"
  record_artifact_state
  log_phase "test-without-building end"
}

diagnostics() {
  local simulator_udid=""

  ensure_paths

  if ! simulator_udid="$(resolve_simulator_udid 2>/dev/null)"; then
    simulator_udid=""
  fi

  log_phase "swift-ci diagnostics start"
  {
    echo "timestamp=$(timestamp)"
    echo "xcodebuild_version"
    xcodebuild -version || true
    echo
    echo "simctl_list_runtimes"
    xcrun simctl list runtimes || true
    echo
    echo "simctl_list_devices_available"
    xcrun simctl list devices available || true
    echo
    echo "simctl_list_devices_booted"
    xcrun simctl list devices booted || true
  } | tee "${CI_DIAGNOSTICS_DIR}/postflight.log"

  if [[ -n "${simulator_udid}" ]]; then
    xcrun simctl spawn "${simulator_udid}" log show --last 10m --style compact \
      > "${CI_DIAGNOSTICS_DIR}/simulator-system.log" 2>&1 || true
  fi

  record_artifact_state
  log_phase "swift-ci diagnostics end"
}

usage() {
  cat <<'EOF'
usage: scripts/run-swift-tests-ci.sh <bootstrap|build-for-testing|test-without-building|diagnostics>
EOF
}

main() {
  local command="${1:-}"

  case "${command}" in
    bootstrap)
      bootstrap
      ;;
    build-for-testing)
      build_for_testing
      ;;
    test-without-building)
      test_without_building
      ;;
    diagnostics)
      diagnostics
      ;;
    *)
      usage >&2
      exit 2
      ;;
  esac
}

main "$@"
