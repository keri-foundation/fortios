"""Tests for resolve-ios-simulator.py using fixture JSON.

Run from the repo root::

    python3 -m pytest scripts/__tests__/test_resolve_simulator.py -xvs
"""

from __future__ import annotations

import json
import os
import pathlib
import subprocess
import sys

SCRIPT = pathlib.Path(__file__).resolve().parent.parent / "resolve-ios-simulator.py"
FIXTURES = pathlib.Path(__file__).resolve().parent / "fixtures"


def _run(*, inventory: str, env: dict[str, str] | None = None, args: list[str] | None = None) -> subprocess.CompletedProcess[str]:
    """Invoke the resolver with a fixture file."""
    cmd = [sys.executable, str(SCRIPT), "--inventory", inventory]
    if args:
        cmd.extend(args)
    run_env = os.environ.copy()
    run_env.pop("SIMULATOR_UDID", None)
    run_env.pop("SIMULATOR_NAME", None)
    run_env.pop("SIMULATOR_OS", None)
    if env:
        run_env.update(env)
    return subprocess.run(cmd, capture_output=True, text=True, env=run_env, timeout=10)


def _fixture(name: str) -> str:
    return str(FIXTURES / name)


# ── Resolution tests ──────────────────────────────────────────────────────

def test_explicit_unique_name():
    """Explicit unique name selects the correct device."""
    r = _run(inventory=_fixture("simctl-normal.json"),
             env={"SIMULATOR_NAME": "iPhone 16"}, args=["--udid"])
    assert r.returncode == 0, r.stderr
    assert r.stdout.strip() == "A002-A002-A002-A002-A002-A002"


def test_explicit_name_with_os():
    """Name + OS constraint selects the correct runtime."""
    r = _run(inventory=_fixture("simctl-duplicate-names.json"),
             env={"SIMULATOR_NAME": "iPhone 17 Pro", "SIMULATOR_OS": "26.0"}, args=["--udid"])
    assert r.returncode == 0, r.stderr
    assert r.stdout.strip() == "33333333-3333-3333-3333-333333333333"


def test_explicit_udid():
    """Explicit UDID bypasses name resolution."""
    r = _run(inventory=_fixture("simctl-normal.json"),
             env={"SIMULATOR_UDID": "A003-A003-A003-A003-A003-A003"}, args=["--udid"])
    assert r.returncode == 0, r.stderr
    assert r.stdout.strip() == "A003-A003-A003-A003-A003-A003"


def test_explicit_udid_not_found():
    """Non-existent UDID fails."""
    r = _run(inventory=_fixture("simctl-normal.json"),
             env={"SIMULATOR_UDID": "DEAD-DEAD-DEAD-DEAD-DEAD-DEAD"}, args=["--udid"])
    assert r.returncode == 1
    assert "not found" in r.stderr


def test_duplicate_name_no_os():
    """Duplicate name without OS constraint fails."""
    r = _run(inventory=_fixture("simctl-duplicate-names.json"),
             env={"SIMULATOR_NAME": "iPhone 17 Pro"}, args=["--udid"])
    assert r.returncode == 1
    assert "matches multiple runtimes" in r.stderr


def test_one_booted():
    """Single booted simulator is auto-selected."""
    r = _run(inventory=_fixture("simctl-one-booted.json"), args=["--udid"])
    assert r.returncode == 0, r.stderr
    assert r.stdout.strip() == "BOOT-0001-0001-0001-0001-0001"


def test_multi_booted_fails():
    """Multiple booted simulators without explicit selection fails."""
    r = _run(inventory=_fixture("simctl-multi-booted.json"), args=["--udid"])
    assert r.returncode == 1
    assert "Multiple booted" in r.stderr


def test_newest_runtime_fallback():
    """No booted → newest runtime → preferred model."""
    r = _run(inventory=_fixture("simctl-normal.json"), args=["--name"])
    assert r.returncode == 0, r.stderr
    assert r.stdout.strip() == "iPhone 17 Pro"  # newest runtime (26.4), preferred model


def test_unavailable_ignored():
    """Unavailable devices are excluded."""
    # simctl-duplicate-names.json has iPhone 16e isAvailable=false in the 26.0 runtime
    r = _run(inventory=_fixture("simctl-duplicate-names.json"),
             env={"SIMULATOR_NAME": "iPhone 16e"}, args=["--udid"])
    assert r.returncode == 1  # not found (it's unavailable)
    assert "not found" in r.stderr


def test_no_available_devices():
    """No available devices at all fails."""
    r = _run(inventory=_fixture("simctl-no-available.json"), args=["--udid"])
    assert r.returncode == 1
    assert "No available" in r.stderr or "not found" in r.stderr


def test_no_devices():
    """Empty devices dict fails."""
    r = _run(inventory=_fixture("simctl-no-devices.json"), args=["--udid"])
    assert r.returncode == 1
    assert "No available" in r.stderr


def test_version_sort():
    """26.10 is correctly treated as newer than 26.4 (not lexicographic)."""
    r = _run(inventory=_fixture("simctl-version-sort.json"), args=["--runtime"])
    assert r.returncode == 0, r.stderr
    # The 26.10 device is unavailable → one booted (26.4) winner
    assert r.stdout.strip() == "26.4"


# ── Output mode tests ──────────────────────────────────────────────────────

def test_output_destination():
    r = _run(inventory=_fixture("simctl-one-booted.json"), args=["--destination"])
    assert r.returncode == 0
    assert "platform=iOS Simulator,id=BOOT-0001" in r.stdout


def test_output_json():
    r = _run(inventory=_fixture("simctl-one-booted.json"), args=["--json"])
    assert r.returncode == 0
    data = json.loads(r.stdout)
    assert data["udid"] == "BOOT-0001-0001-0001-0001-0001"
    assert data["name"] == "iPhone 17 Pro"
    assert "destination" in data


def test_output_default_summary():
    r = _run(inventory=_fixture("simctl-one-booted.json"))
    assert r.returncode == 0
    for key in ("simulator-name=", "simulator-runtime=", "simulator-udid=",
                 "simulator-state=", "xcode-destination="):
        assert key in r.stdout, f"Missing {key} in output: {r.stdout}"


# ── Error handling tests ───────────────────────────────────────────────────

def test_malformed_json():
    """Malformed fixture file fails."""
    bad = _fixture("simctl-normal.json") + ".bad"
    with open(_fixture("simctl-normal.json")) as fh:
        content = fh.read()
    # Truncate it
    with open(bad, "w") as fh:
        fh.write(content[:-50])
    try:
        r = _run(inventory=bad, args=["--udid"])
        assert r.returncode == 2
    finally:
        os.remove(bad)
