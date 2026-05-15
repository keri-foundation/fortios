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
SIMULATOR_DESTINATION_ARCH="${SIMULATOR_DESTINATION_ARCH:-}"
SWIFT_TEST_WITHOUT_BUILDING_TIMEOUT_SECONDS="${SWIFT_TEST_WITHOUT_BUILDING_TIMEOUT_SECONDS:-1800}"

timestamp() {
  date -u +"%Y-%m-%dT%H:%M:%SZ"
}

log_phase() {
  echo "$(timestamp) $*"
}

ensure_paths() {
  mkdir -p \
    "$(dirname "${TEST_RESULTS_PATH}")" \
    "$(dirname "${BUILD_RESULTS_PATH}")" \
    "${DERIVED_DATA_PATH}" \
    "${CI_DIAGNOSTICS_DIR}"
}

prepare_result_bundle_path() {
  local result_bundle_path="$1"

  rm -rf "${result_bundle_path}"
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

test_destination() {
  local simulator_udid="$1"

  if [[ -n "${SIMULATOR_DESTINATION_ARCH}" ]]; then
    printf 'platform=iOS Simulator,id=%s,arch=%s\n' "${simulator_udid}" "${SIMULATOR_DESTINATION_ARCH}"
    return 0
  fi

  printf 'id=%s\n' "${simulator_udid}"
}

find_xctestrun() {
  local products_dir="${DERIVED_DATA_PATH}/Build/Products"
  local all_candidates=()
  local arm64_candidates=()
  local candidate

  while IFS= read -r candidate; do
    all_candidates+=("${candidate}")
  done < <(find "${products_dir}" -maxdepth 3 -type f -name '*.xctestrun' | sort)

  {
    echo "timestamp=$(timestamp)"
    echo "products_dir=${products_dir}"
    echo "all_candidates=${#all_candidates[@]}"
    if [[ ${#all_candidates[@]} -gt 0 ]]; then
      printf '%s\n' "${all_candidates[@]}"
    fi
  } > "${CI_DIAGNOSTICS_DIR}/xctestrun-candidates.txt"

  cat "${CI_DIAGNOSTICS_DIR}/xctestrun-candidates.txt" >&2

  if [[ ${#all_candidates[@]} -eq 0 ]]; then
    echo "ERROR: no .xctestrun file found under ${products_dir}" >&2
    return 1
  fi

  for candidate in "${all_candidates[@]}"; do
    if [[ "$(basename "${candidate}")" == *iphonesimulator*arm64*.xctestrun ]]; then
      arm64_candidates+=("${candidate}")
    fi
  done

  if [[ ${#arm64_candidates[@]} -eq 0 ]]; then
    echo "ERROR: no arm64 iPhone simulator .xctestrun file found under ${products_dir}" >&2
    return 1
  fi

  if [[ ${#arm64_candidates[@]} -gt 1 ]]; then
    echo "ERROR: multiple arm64 iPhone simulator .xctestrun files found; refusing to guess" >&2
    printf '%s\n' "${arm64_candidates[@]}" >&2
    return 1
  fi

  printf '%s\n' "${arm64_candidates[0]}" > "${CI_DIAGNOSTICS_DIR}/selected-xctestrun.txt"
  cat "${CI_DIAGNOSTICS_DIR}/selected-xctestrun.txt" >&2
  printf '%s\n' "${arm64_candidates[0]}"
}

result_bundle_validity() {
  local result_bundle_path="$1"
  local output_path="$2"
  local stderr_path="${output_path}.stderr"

  {
    echo "timestamp=$(timestamp)"
    echo "result_bundle_path=${result_bundle_path}"

    if [[ -e "${result_bundle_path}" ]]; then
      echo "exists=yes"
    else
      echo "exists=no"
      return 0
    fi

    if [[ -f "${result_bundle_path}/Info.plist" ]]; then
      echo "info_plist=yes"
    else
      echo "info_plist=no"
    fi

    if xcrun xcresulttool get --legacy --path "${result_bundle_path}" --format json >/dev/null 2>"${stderr_path}"; then
      echo "xcresulttool=valid"
    else
      local validation_exit=$?
      echo "xcresulttool=invalid exit=${validation_exit}"
      if [[ -s "${stderr_path}" ]]; then
        echo "xcresulttool_stderr_begin"
        cat "${stderr_path}"
        echo "xcresulttool_stderr_end"
      fi
    fi
  } | tee "${output_path}"
}

collect_test_without_building_diagnostics() {
  local simulator_udid="$1"
  local xctestrun_path="$2"
  local exit_code="$3"

  {
    echo "timestamp=$(timestamp)"
    echo "exit_code=${exit_code}"
    echo "simulator_name=${SIMULATOR_NAME}"
    echo "simulator_os=${SIMULATOR_OS}"
    echo "simulator_udid=${simulator_udid:-<unresolved>}"
    echo "simulator_destination_arch=${SIMULATOR_DESTINATION_ARCH:-<unset>}"
    echo "xctestrun_path=${xctestrun_path:-<unresolved>}"
    echo "timeout_seconds=${SWIFT_TEST_WITHOUT_BUILDING_TIMEOUT_SECONDS}"
  } | tee "${CI_DIAGNOSTICS_DIR}/test-without-building-failure.txt"

  if [[ -n "${simulator_udid}" ]]; then
    python3 - "${simulator_udid}" <<'PY' | tee "${CI_DIAGNOSTICS_DIR}/simulator-state.txt"
import json
import subprocess
import sys

target_udid = sys.argv[1]
result = subprocess.run(
    ["xcrun", "simctl", "list", "devices", "--json"],
    check=False,
    text=True,
    capture_output=True,
)
print(f"target_udid={target_udid}")
if result.returncode != 0:
    print(f"simctl_json_exit={result.returncode}")
    sys.exit(0)

devices = json.loads(result.stdout).get("devices", {})
for runtime, runtime_devices in devices.items():
    for device in runtime_devices:
        if device.get("udid") == target_udid:
            print(f"runtime={runtime}")
            print(f"name={device.get('name')}")
            print(f"state={device.get('state')}")
            print(f"isAvailable={device.get('isAvailable')}")
            sys.exit(0)

print("state=missing")
PY

    xcrun simctl spawn "${simulator_udid}" log show --last 15m --style compact \
      --predicate '(process == "xcodebuild") OR (process == "testmanagerd") OR (process == "KeriWallet") OR (process == "WebKit") OR (eventMessage CONTAINS[c] "XCTest") OR (eventMessage CONTAINS[c] "testmanagerd") OR (eventMessage CONTAINS[c] "KeriWallet") OR (eventMessage CONTAINS[c] "WebKit") OR (eventMessage CONTAINS[c] "crash") OR (eventMessage CONTAINS[c] "timeout")' \
      > "${CI_DIAGNOSTICS_DIR}/test-without-building-simulator-filtered.log" 2>&1 || true
  fi

  find "${DERIVED_DATA_PATH}/Build/Products" -maxdepth 3 -type f | sort \
    > "${CI_DIAGNOSTICS_DIR}/build-products-files.txt" 2>&1 || true

  result_bundle_validity "${TEST_RESULTS_PATH}" "${CI_DIAGNOSTICS_DIR}/test-without-building-xcresult-validation.txt"
  record_artifact_state
}

run_with_timeout() {
  local timeout_seconds="$1"
  shift

  python3 - "$timeout_seconds" "$@" <<'PY'
import os
import signal
import subprocess
import sys

timeout_seconds = int(sys.argv[1])
command = sys.argv[2:]

process = subprocess.Popen(command, start_new_session=True)

try:
    sys.exit(process.wait(timeout=timeout_seconds))
except subprocess.TimeoutExpired:
    print(
        f"ERROR: command timed out after {timeout_seconds}s: {' '.join(command)}",
        file=sys.stderr,
    )
    os.killpg(process.pid, signal.SIGTERM)
    try:
        process.wait(timeout=30)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGKILL)
        process.wait()
    sys.exit(124)
PY
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
  prepare_result_bundle_path "${BUILD_RESULTS_PATH}"
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
  local destination
  local exit_code

  ensure_paths
  prepare_result_bundle_path "${TEST_RESULTS_PATH}"
  simulator_udid="$(resolve_simulator_udid)"
  xctestrun_path="$(find_xctestrun)"
  destination="$(test_destination "${simulator_udid}")"

  log_phase "test-without-building start"
  log_phase "using xctestrun ${xctestrun_path}"
  log_phase "using destination ${destination}"
  set +e
  run_with_timeout "${SWIFT_TEST_WITHOUT_BUILDING_TIMEOUT_SECONDS}" \
    xcodebuild test-without-building \
    -xctestrun "${xctestrun_path}" \
    -destination "${destination}" \
    -destination-timeout 120 \
    -resultBundlePath "${TEST_RESULTS_PATH}" \
    -derivedDataPath "${DERIVED_DATA_PATH}" \
    -parallel-testing-enabled NO \
    -showBuildTimingSummary | tee "${CI_DIAGNOSTICS_DIR}/test-without-building.log"
  exit_code="${PIPESTATUS[0]}"
  set -e

  if [[ "${exit_code}" -ne 0 ]]; then
    collect_test_without_building_diagnostics "${simulator_udid}" "${xctestrun_path}" "${exit_code}"
    return "${exit_code}"
  fi

  record_artifact_state
  result_bundle_validity "${TEST_RESULTS_PATH}" "${CI_DIAGNOSTICS_DIR}/test-without-building-xcresult-validation.txt"
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
