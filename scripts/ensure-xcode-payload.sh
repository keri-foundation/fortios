#!/usr/bin/env bash
# ── ensure-xcode-payload.sh ───────────────────────────────────────────────────
#
# Ensure WebPayload/ is present, valid, and ready for Xcode to bundle.
# Called during Xcode builds and by make targets.
#
# Behaviour:
#   1. If WebPayload/ is present and passes validation → do nothing (exit 0).
#   2. If missing or invalid and a FortWeb source is found → stage it.
#   3. If it cannot be staged → fail with an actionable remediation command.
#   4. Never create an empty payload.  Never modify FortWeb.
#
# Environment:
#   FORTWEB_DIR    - override the FortWeb source directory
#   BUILD_CONFIG   - "Debug" or "Release" (default: Debug)
#                    Release builds fail closed — no auto-staging at all
#
# Usage:
#   ./scripts/ensure-xcode-payload.sh           # auto-discover FortWeb
#   FORTWEB_DIR=../fortweb ./scripts/ensure-xcode-payload.sh
#   BUILD_CONFIG=Release ./scripts/ensure-xcode-payload.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
PAYLOAD_DIR="${REPO_ROOT}/WebPayload"
PAYLOAD_VALIDATOR="${REPO_ROOT}/tools/validate-mobile-payload.mjs"
BUILD_CONFIG="${BUILD_CONFIG:-Debug}"
FORTWEB_DIR="${FORTWEB_DIR:-}"

# ── Helpers ───────────────────────────────────────────────────────────────────

validate_payload() {
  if [[ ! -d "${PAYLOAD_DIR}" ]]; then
    return 1
  fi
  if [[ ! -f "${PAYLOAD_DIR}/index.html" ]]; then
    return 1
  fi
  if [[ ! -f "${PAYLOAD_DIR}/build-manifest.json" ]]; then
    return 1
  fi
  if ! node "${PAYLOAD_VALIDATOR}" \
    --payload-dir "${PAYLOAD_DIR}" \
    --target ios-webpayload 2>/dev/null; then
    return 1
  fi
  return 0
}

find_fortweb_source() {
  local candidates=()

  if [[ -n "${FORTWEB_DIR}" ]]; then
    candidates=("${FORTWEB_DIR}")
  else
    # Supported sibling paths — only tried when FORTWEB_DIR is not set.
    candidates=(
      "${REPO_ROOT}/../fortweb"
      "${REPO_ROOT}/../FortWeb"
    )
  fi

  for dir in "${candidates[@]}"; do
    if [[ -d "${dir}" ]] && [[ -f "${dir}/app/index.html" ]] && [[ -f "${dir}/pyscript-ci.toml" ]]; then
      echo "${dir}"
      return 0
    fi
  done
  return 1
}

# ── Main ──────────────────────────────────────────────────────────────────────

if validate_payload; then
  echo "[ensure-payload] WebPayload/ is valid — nothing to do."
  exit 0
fi

if [[ "${BUILD_CONFIG}" == "Release" ]]; then
  echo "[ensure-payload] ERROR: WebPayload/ is missing or invalid and BUILD_CONFIG=Release." >&2
  echo "[ensure-payload] Release builds require a pre-staged payload." >&2
  echo "[ensure-payload] Run: make xcode-ready FORTWEB_DIR=../FortWeb" >&2
  exit 1
fi

FORTWEB_SRC="$(find_fortweb_source || true)"

if [[ -z "${FORTWEB_SRC}" ]]; then
  if [[ -n "${FORTWEB_DIR}" ]]; then
    echo "[ensure-payload] ERROR: FortWeb source not found at FORTWEB_DIR=${FORTWEB_DIR}" >&2
  else
    echo "[ensure-payload] ERROR: FortWeb source not found.  Tried:" >&2
    for d in "${REPO_ROOT}/../fortweb" "${REPO_ROOT}/../FortWeb"; do
      echo "  ${d}" >&2
    done
  fi
  echo "[ensure-payload] Specify FORTWEB_DIR or stage the payload manually:" >&2
  echo "[ensure-payload]   make xcode-ready FORTWEB_DIR=../FortWeb" >&2
  exit 1
fi

echo "[ensure-payload] Staging payload from ${FORTWEB_SRC} …"
"${REPO_ROOT}/sync-payload.sh" FORTWEB_DIR="${FORTWEB_SRC}"

if ! validate_payload; then
  echo "[ensure-payload] ERROR: Sync succeeded but payload validation failed." >&2
  exit 1
fi

echo "[ensure-payload] Payload staged and validated."
exit 0
