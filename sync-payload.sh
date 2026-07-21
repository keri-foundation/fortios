#!/usr/bin/env bash
# ── sync-payload.sh ───────────────────────────────────────────────────────────
#
# Stage the shipped FortWeb product-shell payload into WebPayload/.
# This is the only supported wrapper sync path for upstream Fort-ios.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PAYLOAD_SOURCE="${PAYLOAD_SOURCE:-fortweb}"
FORTWEB_DIR="${FORTWEB_DIR:-${SCRIPT_DIR}/../fortweb}"
WRAPPER_PAYLOAD_DIR="${SCRIPT_DIR}/WebPayload"
FORTWEB_MANIFEST_TOOL="${SCRIPT_DIR}/tools/gen-fortweb-bundle-manifest.mjs"
PAYLOAD_VALIDATOR="${SCRIPT_DIR}/tools/validate-mobile-payload.mjs"

write_fortweb_redirect() {
  cat > "${WRAPPER_PAYLOAD_DIR}/index.html" <<'EOF'
<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
  <title>KERI Wallet</title>
  <script>
    window.location.replace('./fortweb/app/index.html');
  </script>
</head>
<body></body>
</html>
EOF
}

write_fortweb_manifest() {
  node "${FORTWEB_MANIFEST_TOOL}" \
    --payload-root "${WRAPPER_PAYLOAD_DIR}" \
    --fortweb-dir "${FORTWEB_DIR}" \
    --build-command 'PAYLOAD_SOURCE=fortweb ./sync-payload.sh'
}

sync_fortweb_payload() {
  if [[ ! -d "${FORTWEB_DIR}" ]]; then
    echo "error: FortWeb repo not found at ${FORTWEB_DIR}" 1>&2
    exit 1
  fi

  if [[ ! -d "${FORTWEB_DIR}/dist/runtime" ]]; then
    echo "error: FortWeb dist/runtime not found at ${FORTWEB_DIR}/dist/runtime" 1>&2
    echo "       Run in FortWeb: npm run build:runtime" 1>&2
    exit 1
  fi

  if [[ ! -f "${FORTWEB_DIR}/dist/runtime/app/app/main.js" ]]; then
    echo "error: FortWeb compiled entry script missing at ${FORTWEB_DIR}/dist/runtime/app/app/main.js" 1>&2
    echo "       Run in FortWeb: npm run build:runtime" 1>&2
    exit 1
  fi

  echo "[sync-payload] syncing compiled FortWeb payload into wrapper WebPayload/"
  mkdir -p "${WRAPPER_PAYLOAD_DIR}"
  rm -rf "${WRAPPER_PAYLOAD_DIR}"/*

  # Copy compiled dist/runtime — includes app/, vendor/, pyscript-ci.toml,
  # wheels/, and app/index.html (build-runtime.mjs copies all of these)
  cp -R "${FORTWEB_DIR}/dist/runtime/"* "${WRAPPER_PAYLOAD_DIR}/fortweb/"
  write_fortweb_redirect
  write_fortweb_manifest
}

case "${PAYLOAD_SOURCE}" in
  fortweb)
    sync_fortweb_payload
    ;;
  *)
    echo "error: unsupported PAYLOAD_SOURCE=${PAYLOAD_SOURCE}" 1>&2
    echo "       Only PAYLOAD_SOURCE=fortweb is supported for live wrapper sync." 1>&2
    exit 1
    ;;
esac

node "${PAYLOAD_VALIDATOR}" \
  --payload-dir "${WRAPPER_PAYLOAD_DIR}" \
  --target ios-webpayload

if [[ ! -f "${WRAPPER_PAYLOAD_DIR}/index.html" ]]; then
  echo "error: expected index.html missing after sync" 1>&2
  exit 1
fi

if [[ ! -f "${WRAPPER_PAYLOAD_DIR}/build-manifest.json" ]]; then
  echo "error: expected build-manifest.json missing after sync" 1>&2
  exit 1
fi

FILE_COUNT=$(find "${WRAPPER_PAYLOAD_DIR}" -type f | wc -l | tr -d ' ')
DIST_HASH=$(python3 - <<'PY' "${WRAPPER_PAYLOAD_DIR}/build-manifest.json"
import json
import sys

with open(sys.argv[1], 'r', encoding='utf-8') as fp:
    print(json.load(fp)['dist_tree_sha256'])
PY
)

echo "[sync-payload] ok: source=${PAYLOAD_SOURCE} files=${FILE_COUNT} dist_tree_sha256=${DIST_HASH}"
