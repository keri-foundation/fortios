#!/usr/bin/env bash

set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: $0 <simulator-name> <ios-version|auto>" >&2
  exit 2
fi

simulator_name="$1"
simulator_os="$2"

python3 - "$simulator_name" "$simulator_os" <<'PY'
import json
import subprocess
import sys

simulator_name = sys.argv[1]
simulator_os = sys.argv[2]
filter_os = simulator_os not in {"", "auto"}


def parse_runtime_version(version: str) -> tuple[int, ...]:
    return tuple(int(part) for part in version.split("."))

raw = subprocess.check_output(
    ["xcrun", "simctl", "list", "devices", "available", "--json"],
    text=True,
)
data = json.loads(raw)
matches = []

for runtime_name, devices in data.get("devices", {}).items():
    if not runtime_name.startswith("com.apple.CoreSimulator.SimRuntime.iOS-"):
        continue

    runtime_os = runtime_name.split("iOS-")[-1].replace("-", ".")
    if filter_os and runtime_os != simulator_os:
        continue

    for device in devices:
        if not device.get("isAvailable"):
            continue
        if device.get("name") != simulator_name:
            continue
        matches.append((parse_runtime_version(runtime_os), device.get("udid")))

if filter_os:
    if len(matches) != 1:
        raise SystemExit(1)
    print(matches[0][1])
    raise SystemExit(0)

if not matches:
    raise SystemExit(1)

matches.sort(key=lambda match: match[0], reverse=True)
print(matches[0][1])
PY
