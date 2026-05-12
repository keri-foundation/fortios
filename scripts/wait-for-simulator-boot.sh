#!/usr/bin/env bash

set -euo pipefail

if [[ $# -lt 1 || $# -gt 2 ]]; then
  echo "usage: $0 <simulator-udid> [timeout-seconds]" >&2
  exit 2
fi

simulator_udid="$1"
timeout_seconds="${2:-180}"

python3 - "$simulator_udid" "$timeout_seconds" <<'PY'
import subprocess
import sys

simulator_udid = sys.argv[1]
timeout_seconds = int(sys.argv[2])

try:
    subprocess.run(
        ["xcrun", "simctl", "bootstatus", simulator_udid, "-b"],
        check=True,
        timeout=timeout_seconds,
    )
except subprocess.TimeoutExpired:
    print(
        f"ERROR: timed out after {timeout_seconds}s waiting for simulator {simulator_udid} to boot.",
        file=sys.stderr,
    )
    print("Available simulators:", file=sys.stderr)
    subprocess.run(["xcrun", "simctl", "list", "devices", "available"], check=False)
    sys.exit(1)
except subprocess.CalledProcessError as exc:
    print(
        f"ERROR: simctl bootstatus failed for simulator {simulator_udid} with exit code {exc.returncode}.",
        file=sys.stderr,
    )
    print("Available simulators:", file=sys.stderr)
    subprocess.run(["xcrun", "simctl", "list", "devices", "available"], check=False)
    sys.exit(exc.returncode)
PY
