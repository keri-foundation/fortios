#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
FORTIOS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ROOT_DIR="$(cd "$FORTIOS_DIR/../.." && pwd)"

LATEST_POINTER="$ROOT_DIR/.tmp/golden/fortios-pr30-current-latest.txt"
DEFAULT_CONTEXT_JSON=""
if [[ -f "$LATEST_POINTER" ]]; then
  latest_dir="$(cat "$LATEST_POINTER")"
  DEFAULT_CONTEXT_JSON="$latest_dir/context.json"
fi

CONTEXT_JSON="${CONTEXT_JSON:-${1:-$DEFAULT_CONTEXT_JSON}}"

if [[ -z "$CONTEXT_JSON" ]]; then
  echo "ERROR: context JSON path not provided and no latest pointer found."
  echo "Set CONTEXT_JSON=/abs/path/to/context.json"
  exit 1
fi

if [[ ! -f "$CONTEXT_JSON" ]]; then
  echo "ERROR: context JSON not found: $CONTEXT_JSON"
  exit 1
fi

expected_branch="$(python3 - "$CONTEXT_JSON" <<'PY'
import json
import sys
with open(sys.argv[1], 'r', encoding='utf-8') as f:
    obj = json.load(f)
print(obj.get('branch', ''))
PY
)"
expected_local_head="$(python3 - "$CONTEXT_JSON" <<'PY'
import json
import sys
with open(sys.argv[1], 'r', encoding='utf-8') as f:
    obj = json.load(f)
print(obj.get('local_head', ''))
PY
)"
expected_remote_head="$(python3 - "$CONTEXT_JSON" <<'PY'
import json
import sys
with open(sys.argv[1], 'r', encoding='utf-8') as f:
    obj = json.load(f)
print(obj.get('remote_head', ''))
PY
)"
required_origin_mode="$(python3 - "$CONTEXT_JSON" <<'PY'
import json
import sys
with open(sys.argv[1], 'r', encoding='utf-8') as f:
    obj = json.load(f)
print(obj.get('required_origin_mode_for_create_vault_tests', ''))
PY
)"

if [[ -z "$expected_branch" || -z "$expected_local_head" || -z "$expected_remote_head" ]]; then
  echo "ERROR: context JSON is missing required keys (branch/local_head/remote_head)."
  exit 1
fi

current_branch="$(git -C "$FORTIOS_DIR" branch --show-current)"
current_head="$(git -C "$FORTIOS_DIR" rev-parse HEAD)"
remote_head="$(git -C "$FORTIOS_DIR" rev-parse "origin/$expected_branch" 2>/dev/null || true)"
webpayload_status="$(git -C "$FORTIOS_DIR" status --short -- WebPayload)"

echo "CONTEXT_JSON=$CONTEXT_JSON"
echo "EXPECTED_BRANCH=$expected_branch"
echo "CURRENT_BRANCH=$current_branch"
if [[ "$current_branch" != "$expected_branch" ]]; then
  echo "ERROR: current branch does not match expected branch."
  exit 1
fi

echo "EXPECTED_LOCAL_HEAD=$expected_local_head"
echo "CURRENT_HEAD=$current_head"
if [[ "$current_head" != "$expected_local_head" ]]; then
  echo "ERROR: local HEAD drift detected."
  exit 1
fi

echo "EXPECTED_REMOTE_HEAD=$expected_remote_head"
echo "CURRENT_REMOTE_HEAD=$remote_head"
if [[ -z "$remote_head" || "$remote_head" != "$expected_remote_head" ]]; then
  echo "ERROR: remote branch HEAD mismatch or unavailable."
  echo "Run: git -C $FORTIOS_DIR fetch origin --prune"
  exit 1
fi

if [[ -n "$webpayload_status" ]]; then
  echo "ERROR: WebPayload tree is not clean."
  echo "$webpayload_status"
  exit 1
fi

echo "REQUIRED_ORIGIN_MODE=$required_origin_mode"
if [[ -n "$required_origin_mode" ]]; then
  echo "NOTE: enforce $required_origin_mode mode in create-vault runs (e.g. FORTIOS_LOOPBACK_ORIGIN=1)."
fi

echo "PASS: PR30 context guard satisfied."
