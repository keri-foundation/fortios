#!/usr/bin/env bash

set -euo pipefail

if [[ $# -lt 3 || $# -gt 4 ]]; then
  echo "usage: $0 <status|guard> <simulator-name> <ios-version|auto> [resolved-udid]" >&2
  exit 2
fi

mode="$1"
simulator_name="$2"
simulator_os="$3"
resolved_udid="${4:-}"

python3 - "$mode" "$simulator_name" "$simulator_os" "$resolved_udid" <<'PY'
import json
import subprocess
import sys

mode = sys.argv[1]
simulator_name = sys.argv[2]
simulator_os = sys.argv[3]
resolved_udid = sys.argv[4]


def load_devices() -> dict:
    result = subprocess.run(
        ["xcrun", "simctl", "list", "devices", "--json"],
        check=False,
        text=True,
        capture_output=True,
    )
    if result.returncode != 0:
        print(f"ERROR: simctl list devices failed with exit code {result.returncode}", file=sys.stderr)
        if result.stderr:
            print(result.stderr, file=sys.stderr, end="")
        raise SystemExit(result.returncode)
    return json.loads(result.stdout)


def runtime_to_ios_version(runtime_name: str) -> str | None:
    if not runtime_name.startswith("com.apple.CoreSimulator.SimRuntime.iOS-"):
        return None
    return runtime_name.split("iOS-")[-1].replace("-", ".")


data = load_devices().get("devices", {})
target = None
booted_ios_devices: list[dict] = []

for runtime_name, devices in data.items():
    runtime_os = runtime_to_ios_version(runtime_name)
    if runtime_os is None:
        continue

    for device in devices:
        device_info = {
            "runtime": runtime_name,
            "runtime_os": runtime_os,
            "name": device.get("name", "<unknown>"),
            "udid": device.get("udid", ""),
            "state": device.get("state", "<unknown>"),
            "available": bool(device.get("isAvailable", False)),
        }

        if device_info["udid"] == resolved_udid and resolved_udid:
            target = device_info

        if device_info["state"] == "Booted":
            booted_ios_devices.append(device_info)


print(f"mode={mode}")
print(f"simulator_name={simulator_name}")
print(f"simulator_os={simulator_os}")
print(f"resolved_udid={resolved_udid or '<unresolved>'}")
print(f"booted_ios_count={len(booted_ios_devices)}")

if target is not None:
    print(f"target_runtime={target['runtime_os']}")
    print(f"target_state={target['state']}")
    print(f"target_available={str(target['available']).lower()}")
else:
    print("target_runtime=<missing>")
    print("target_state=<missing>")
    print("target_available=<missing>")

if booted_ios_devices:
    print("booted_ios_devices_begin")
    for device in sorted(booted_ios_devices, key=lambda item: (item["name"], item["runtime_os"], item["udid"])):
        print(
            f"- name={device['name']} runtime={device['runtime_os']} udid={device['udid']} state={device['state']} available={str(device['available']).lower()}"
        )
    print("booted_ios_devices_end")
else:
    print("booted_ios_devices=none")

if mode == "status":
    raise SystemExit(0)

if mode != "guard":
    print(f"ERROR: unsupported mode {mode}", file=sys.stderr)
    raise SystemExit(2)

if not resolved_udid:
    print("ERROR: simulator destination is unresolved; refusing guarded run", file=sys.stderr)
    raise SystemExit(1)

if target is None:
    print("ERROR: resolved simulator UDID is not present in simctl device inventory", file=sys.stderr)
    raise SystemExit(1)

foreign_booted = [device for device in booted_ios_devices if device["udid"] != resolved_udid]
if foreign_booted:
    print("ERROR: another booted iOS simulator is active; refusing guarded run", file=sys.stderr)
    raise SystemExit(1)

if len([device for device in booted_ios_devices if device["udid"] == resolved_udid]) > 1:
    print("ERROR: duplicate booted entries found for the resolved simulator; refusing guarded run", file=sys.stderr)
    raise SystemExit(1)

print("guard_status=clean")
PY