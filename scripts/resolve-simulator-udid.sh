#!/usr/bin/env bash

set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: $0 <simulator-name> <ios-version>" >&2
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

raw = subprocess.check_output(
    ["xcrun", "simctl", "list", "devices", "available", "--json"],
    text=True,
)
data = json.loads(raw)


def parse_runtime_version(runtime_name: str) -> tuple[int, ...]:
    runtime_os = runtime_name.split("iOS-")[-1].replace("-", ".")
    return tuple(int(part) for part in runtime_os.split("."))


def collect_matches(match_os: bool) -> list[dict[str, str]]:
    matches: list[dict[str, str]] = []

    for runtime_name, devices in data.get("devices", {}).items():
        if not runtime_name.startswith("com.apple.CoreSimulator.SimRuntime.iOS-"):
            continue

        runtime_os = runtime_name.split("iOS-")[-1].replace("-", ".")
        if match_os and runtime_os != simulator_os:
            continue

        for device in devices:
            if not device.get("isAvailable"):
                continue
            if device.get("name") != simulator_name:
                continue
            matches.append(
                {
                    "udid": device.get("udid"),
                    "state": device.get("state", ""),
                    "runtime_name": runtime_name,
                }
            )

    matches.sort(
        key=lambda match: (
            match["state"] == "Booted",
            parse_runtime_version(match["runtime_name"]),
        ),
        reverse=True,
    )
    return matches

matches = collect_matches(match_os=True)
if not matches:
    matches = collect_matches(match_os=False)

if not matches:
    raise SystemExit(1)

print(matches[0]["udid"])
PY