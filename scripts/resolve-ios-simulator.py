#!/usr/bin/env python3
"""Resolve a single iOS Simulator UDID from environment variables and host inventory.

Resolution order:
  1. Explicit SIMULATOR_UDID
  2. Explicit SIMULATOR_NAME, optionally constrained by SIMULATOR_OS
  3. Exactly one compatible *booted* iPhone simulator
  4. Newest available iPhone simulator runtime → deterministic preferred model
  5. Fail with an actionable diagnostic.

Consumes ``xcrun simctl list devices available -j``.  Only the Python
standard library is required — no ``jq``, no third-party packages.

Output modes::

    python3 scripts/resolve-ios-simulator.py --udid
    python3 scripts/resolve-ios-simulator.py --name
    python3 scripts/resolve-ios-simulator.py --runtime
    python3 scripts/resolve-ios-simulator.py --destination
    python3 scripts/resolve-ios-simulator.py --json
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from typing import Any


# ---------------------------------------------------------------------------
# Version helpers — avoid lexicographic "26.9 > 26.10" bugs
# ---------------------------------------------------------------------------

def _parse_version(v: str) -> tuple[int, ...]:
    """Return a sortable integer tuple from a dotted version string."""
    return tuple(int(x) for x in v.split("."))


def _runtime_version(runtime_name: str) -> tuple[int, ...]:
    """Extract e.g. (26, 4, 1) from 'com.apple.CoreSimulator.SimRuntime.iOS-26-4-1'."""
    label = runtime_name.split(".", 4)[-1]  # "iOS-26-4-1"
    parts = label.split("-", 1)[-1]  # "26-4-1"
    return tuple(int(x) for x in parts.split("-"))


def _ios_only(info: dict[str, Any]) -> list[dict[str, Any]]:
    """Return only iOS-related entries from the simctl JSON."""
    ios: list[dict[str, Any]] = []
    for runtime_name, devices in info.get("devices", {}).items():
        if "iOS" not in runtime_name.split(".", 4)[-1]:
            continue
        if not isinstance(devices, list):
            continue
        for device_entry in devices:
            if not isinstance(device_entry, dict):
                continue
            device_entry = dict(device_entry)  # shallow copy
            device_entry["_runtime_name"] = runtime_name
            device_entry["_runtime_version"] = _runtime_version(runtime_name)
            ios.append(device_entry)
    return ios


# ---------------------------------------------------------------------------
# Preferred model fallback (newest iOS release → deterministic model)
# ---------------------------------------------------------------------------

MODEL_PREFERENCE: list[str] = [
    "iPhone 17 Pro",
    "iPhone 16 Pro",
    "iPhone 16",
    "iPhone 16e",
    "iPhone 15 Pro",
    "iPhone 15",
    "iPhone SE (3rd generation)",
]


def _preferred_model(devices: list[dict[str, Any]]) -> str | None:
    """Return the first preferred model present in *devices*."""
    names = {d["name"] for d in devices}
    for candidate in MODEL_PREFERENCE:
        if candidate in names:
            return candidate
    # Fallback: alphabetically first iPhone name
    iphones = sorted([n for n in names if "iPhone" in n])
    return iphones[0] if iphones else None


# ---------------------------------------------------------------------------
# Resolution entry point
# ---------------------------------------------------------------------------

def resolve_simulator(
    info: dict[str, Any],
    *,
    sim_udid: str | None = None,
    sim_name: str | None = None,
    sim_os: str | None = None,
) -> dict[str, str]:
    """Return a dict with keys: udid, name, runtime, runtime_name, state, destination."""
    devices = _ios_only(info)
    available = [d for d in devices if d.get("isAvailable", True)]

    # ── 1. Explicit UDID ──────────────────────────────────────────────
    if sim_udid:
        for d in available:
            if d["udid"] == sim_udid:
                return _result(d)
        candidates = [d["udid"] for d in available]
        _fail(f"SIMULATOR_UDID '{sim_udid}' not found in available devices.",
              candidates=candidates)

    # ── 2. Explicit name ± OS ─────────────────────────────────────────
    if sim_name:
        name_matches = [d for d in available if d["name"] == sim_name]
        if sim_os:
            os_tuple = _parse_version(sim_os)
            name_matches = [d for d in name_matches if d["_runtime_version"] == os_tuple]

        if len(name_matches) == 1:
            return _result(name_matches[0])

        if len(name_matches) == 0:
            if sim_os:
                _fail(
                    f"SIMULATOR_NAME='{sim_name}' with SIMULATOR_OS={sim_os} not found.",
                    candidates=sorted({f"{d['name']} ({_fmt_rt(d)})" for d in available}),
                )
            _fail(
                f"SIMULATOR_NAME='{sim_name}' not found in available devices.",
                candidates=sorted({f"{d['name']} ({_fmt_rt(d)})" for d in available}),
            )

        # Multiple matches (duplicate name across runtimes)
        lines = [f"  {d['udid']}  {_fmt_rt(d)}  {d.get('state','?')}" for d in name_matches]
        _fail(
            f"SIMULATOR_NAME='{sim_name}' matches multiple runtimes. "
            f"Specify SIMULATOR_OS=<version> or SIMULATOR_UDID=<udid>.",
            candidates=lines,
        )

    # ── 3. Single booted iPhone ───────────────────────────────────────
    booted = [d for d in available if d.get("state") == "Booted"]
    if len(booted) == 1:
        return _result(booted[0])
    if len(booted) > 1:
        lines = [f"  {d['udid']}  {d['name']}  {_fmt_rt(d)}" for d in booted]
        _fail(
            "Multiple booted iPhone simulators. "
            "Specify SIMULATOR_UDID, SIMULATOR_NAME, or shut down all but one.",
            candidates=lines,
        )

    # ── 4. Newest runtime → preferred model ───────────────────────────
    if not available:
        _fail("No available iPhone Simulator runtimes installed.\n"
              "Open Xcode > Settings > Components and install an iOS Simulator runtime.")

    newest_runtime = max(d["_runtime_version"] for d in available)
    newest_devices = [d for d in available if d["_runtime_version"] == newest_runtime]

    model = _preferred_model(newest_devices)
    if model is None:
        _fail("No iPhone device found in the latest runtime.",
              candidates=sorted({d["name"] for d in newest_devices}))

    chosen = [d for d in newest_devices if d["name"] == model]
    return _result(chosen[0])


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _result(d: dict[str, Any]) -> dict[str, str]:
    return {
        "udid": d["udid"],
        "name": d["name"],
        "runtime": ".".join(str(x) for x in d["_runtime_version"]),
        "runtime_name": d["_runtime_name"],
        "state": d.get("state", "Shutdown"),
        "destination": f"platform=iOS Simulator,id={d['udid']}",
    }


def _fmt_rt(d: dict[str, Any]) -> str:
    return ".".join(str(x) for x in d["_runtime_version"])


def _fail(msg: str, *, candidates: list[str] | None = None) -> None:
    print(f"ERROR: {msg}", file=sys.stderr)
    if candidates:
        print("\nAvailable iPhone Simulators:", file=sys.stderr)
        for c in candidates[:30]:
            print(f"  {c}", file=sys.stderr)
        if len(candidates) > 30:
            print(f"  ... and {len(candidates) - 30} more", file=sys.stderr)
    sys.exit(1)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def _get_inventory() -> dict[str, Any]:
    """Call ``xcrun simctl list devices available -j`` and return parsed JSON."""
    try:
        proc = subprocess.run(
            ["xcrun", "simctl", "list", "devices", "available", "-j"],
            capture_output=True,
            text=True,
            timeout=15,
        )
    except FileNotFoundError:
        print("ERROR: xcrun not found. Is Xcode installed?", file=sys.stderr)
        sys.exit(2)
    except subprocess.TimeoutExpired:
        print("ERROR: simctl timed out.", file=sys.stderr)
        sys.exit(2)

    if proc.returncode != 0:
        print(f"ERROR: simctl failed (exit {proc.returncode}):\n{proc.stderr}", file=sys.stderr)
        sys.exit(2)

    try:
        return json.loads(proc.stdout)
    except json.JSONDecodeError as exc:
        print(f"ERROR: simctl output is not valid JSON: {exc}", file=sys.stderr)
        sys.exit(2)


def main() -> None:
    parser = argparse.ArgumentParser(description="Resolve a single iOS Simulator UDID.")
    parser.add_argument("--udid", action="store_true", help="Print UDID only.")
    parser.add_argument("--name", action="store_true", help="Print device name only.")
    parser.add_argument("--runtime", action="store_true", help="Print runtime version only.")
    parser.add_argument("--destination", action="store_true", help="Print xcodebuild destination string.")
    parser.add_argument("--json", action="store_true", help="Print resolved device as JSON object.")
    parser.add_argument("--inventory", metavar="FILE", help="Use a fixture JSON file instead of live simctl.")
    args = parser.parse_args()

    # Load inventory
    if args.inventory:
        with open(args.inventory) as fh:
            try:
                info = json.load(fh)
            except json.JSONDecodeError as exc:
                print(f"ERROR: inventory file is not valid JSON: {exc}", file=sys.stderr)
                sys.exit(2)
    else:
        info = _get_inventory()

    sim_udid = os.environ.get("SIMULATOR_UDID")
    sim_name = os.environ.get("SIMULATOR_NAME")
    sim_os = os.environ.get("SIMULATOR_OS")

    result = resolve_simulator(info, sim_udid=sim_udid, sim_name=sim_name, sim_os=sim_os)

    # Output
    if args.udid:
        print(result["udid"])
    elif args.name:
        print(result["name"])
    elif args.runtime:
        print(result["runtime"])
    elif args.destination:
        print(result["destination"])
    elif args.json:
        json.dump(result, sys.stdout)
        print()
    else:
        # Default: human-readable summary
        print(f"simulator-name={result['name']}")
        print(f"simulator-runtime={result['runtime']}")
        print(f"simulator-udid={result['udid']}")
        print(f"simulator-state={result['state']}")
        print(f"xcode-destination={result['destination']}")


if __name__ == "__main__":
    main()
