#!/usr/bin/env bash

set -euo pipefail

if [[ $# -lt 1 || $# -gt 2 ]]; then
  echo "usage: $0 <simulator-udid> [timeout-seconds]" >&2
  exit 2
fi

simulator_udid="$1"
timeout_seconds="${2:-180}"

python3 - "$simulator_udid" "$timeout_seconds" <<'PY'
import json
import subprocess
import sys

simulator_udid = sys.argv[1]
timeout_seconds = int(sys.argv[2])


def current_device_state(target_udid: str) -> str | None:
    result = subprocess.run(
        ["xcrun", "simctl", "list", "devices", "--json"],
        check=False,
        text=True,
        capture_output=True,
    )
    if result.returncode != 0:
        return None

    try:
        devices = json.loads(result.stdout).get("devices", {})
    except json.JSONDecodeError:
        return None

    for runtime_devices in devices.values():
        for device in runtime_devices:
            if device.get("udid") == target_udid:
                return device.get("state")

    return None

try:
    subprocess.run(
        ["xcrun", "simctl", "bootstatus", simulator_udid, "-b"],
        check=True,
        timeout=timeout_seconds,
    )
except subprocess.TimeoutExpired:
    current_state = current_device_state(simulator_udid)
    if current_state == "Booted":
        print(
            f"WARN: simctl bootstatus timed out after {timeout_seconds}s, but simulator {simulator_udid} is already Booted.",
            file=sys.stderr,
        )
        sys.exit(0)

    print(
        f"ERROR: timed out after {timeout_seconds}s waiting for simulator {simulator_udid} to boot.",
        file=sys.stderr,
    )
    if current_state:
        print(f"Current simulator state: {current_state}", file=sys.stderr)
    print("Available simulators:", file=sys.stderr)
    subprocess.run(["xcrun", "simctl", "list", "devices", "available"], check=False)
    sys.exit(1)
except subprocess.CalledProcessError as exc:
    current_state = current_device_state(simulator_udid)
    if current_state == "Booted":
        print(
            f"WARN: simctl bootstatus exited {exc.returncode}, but simulator {simulator_udid} is already Booted.",
            file=sys.stderr,
        )
        sys.exit(0)

    print(
        f"ERROR: simctl bootstatus failed for simulator {simulator_udid} with exit code {exc.returncode}.",
        file=sys.stderr,
    )
    if current_state:
        print(f"Current simulator state: {current_state}", file=sys.stderr)
    print("Available simulators:", file=sys.stderr)
    subprocess.run(["xcrun", "simctl", "list", "devices", "available"], check=False)
    sys.exit(exc.returncode)
PY
