"""Tests for the live ``xcrun simctl`` inventory boundary of resolve-ios-simulator.py.

The fixture suite in ``test_resolve_simulator.py`` exercises simulator *selection*
through ``--inventory`` and therefore never touches ``_get_inventory()``. These
tests cover the subprocess boundary directly so the bounded-retry behaviour and
the fail-closed behaviour are both pinned.

No Xcode, simulator runtime, or ``xcrun`` is required: ``subprocess.run`` is
monkeypatched.

Run from the repo root::

    python3 -m pytest scripts/__tests__/test_resolve_simulator_inventory.py -q
"""

from __future__ import annotations

import importlib.util
import json
import pathlib
import subprocess

import pytest

MODULE_PATH = pathlib.Path(__file__).resolve().parent.parent / "resolve-ios-simulator.py"

INVENTORY = {
    "devices": {
        "com.apple.CoreSimulator.SimRuntime.iOS-26-5": [
            {
                "name": "iPhone 17 Pro",
                "udid": "11111111-1111-1111-1111-111111111111",
                "state": "Shutdown",
                "isAvailable": True,
            }
        ]
    }
}

SIMCTL_COMMAND = ["xcrun", "simctl", "list", "devices", "available", "-j"]


@pytest.fixture(scope="module")
def resolver():
    """Import the hyphenated resolver script as a module."""
    spec = importlib.util.spec_from_file_location("resolve_ios_simulator", MODULE_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _completed(stdout: str, *, returncode: int = 0, stderr: str = "") -> subprocess.CompletedProcess[str]:
    return subprocess.CompletedProcess(
        args=list(SIMCTL_COMMAND), returncode=returncode, stdout=stdout, stderr=stderr
    )


def _record_run(monkeypatch, resolver, results: list[object]) -> list[dict[str, object]]:
    """Patch subprocess.run with a scripted sequence; return observed call kwargs."""
    observed: list[dict[str, object]] = []

    def fake_run(cmd, **kwargs):  # noqa: ANN001, ANN003
        observed.append({"cmd": cmd, **kwargs})
        outcome = results[min(len(observed) - 1, len(results) - 1)]
        if isinstance(outcome, BaseException):
            raise outcome
        return outcome

    monkeypatch.setattr(resolver.subprocess, "run", fake_run)
    return observed


# ── Happy path ────────────────────────────────────────────────────────────

def test_inventory_parses_valid_json_with_a_single_call(resolver, monkeypatch):
    """A healthy inventory is one bounded call returning parsed JSON."""
    observed = _record_run(monkeypatch, resolver, [_completed(json.dumps(INVENTORY))])

    assert resolver._get_inventory() == INVENTORY
    assert len(observed) == 1
    assert observed[0]["cmd"] == SIMCTL_COMMAND
    assert observed[0]["timeout"] == resolver.SIMCTL_TIMEOUT_SECONDS
    assert observed[0]["capture_output"] is True
    assert observed[0]["text"] is True


# ── Bounded retry on a stalled first call ─────────────────────────────────

def test_inventory_retries_after_a_stalled_first_attempt(resolver, monkeypatch):
    """A timed-out first attempt is retried and the second attempt succeeds."""
    timeout = subprocess.TimeoutExpired(cmd=SIMCTL_COMMAND, timeout=resolver.SIMCTL_TIMEOUT_SECONDS)
    observed = _record_run(monkeypatch, resolver, [timeout, _completed(json.dumps(INVENTORY))])

    assert resolver._get_inventory() == INVENTORY
    assert len(observed) == 2
    assert all(call["timeout"] == resolver.SIMCTL_TIMEOUT_SECONDS for call in observed)


def test_inventory_retries_are_bounded_and_fail_closed(resolver, monkeypatch, capsys):
    """Every attempt timing out exits 2 after a bounded number of attempts."""
    def always_timeout(cmd, **kwargs):  # noqa: ANN001, ANN003
        raise subprocess.TimeoutExpired(cmd=cmd, timeout=kwargs["timeout"])

    calls: list[int] = []

    def fake_run(cmd, **kwargs):  # noqa: ANN001, ANN003
        calls.append(1)
        return always_timeout(cmd, **kwargs)

    monkeypatch.setattr(resolver.subprocess, "run", fake_run)

    with pytest.raises(SystemExit) as exit_info:
        resolver._get_inventory()

    assert exit_info.value.code == 2
    assert len(calls) == resolver.SIMCTL_MAX_ATTEMPTS
    stderr = capsys.readouterr().err
    assert "timed out" in stderr
    assert str(resolver.SIMCTL_MAX_ATTEMPTS) in stderr
    assert str(resolver.SIMCTL_TIMEOUT_SECONDS) in stderr


def test_inventory_emits_a_retry_warning_before_succeeding(resolver, monkeypatch, capsys):
    """The retry path reports the stall instead of failing silently."""
    timeout = subprocess.TimeoutExpired(cmd=SIMCTL_COMMAND, timeout=resolver.SIMCTL_TIMEOUT_SECONDS)
    _record_run(monkeypatch, resolver, [timeout, _completed(json.dumps(INVENTORY))])

    resolver._get_inventory()

    assert "retrying" in capsys.readouterr().err


# ── Determinate failures stay fail-closed and are not retried ─────────────

def test_nonzero_simctl_exit_fails_closed_without_retrying(resolver, monkeypatch, capsys):
    """A non-zero simctl exit is determinate and must not be retried."""
    observed = _record_run(
        monkeypatch, resolver, [_completed("", returncode=3, stderr="boom")]
    )

    with pytest.raises(SystemExit) as exit_info:
        resolver._get_inventory()

    assert exit_info.value.code == 2
    assert len(observed) == 1
    stderr = capsys.readouterr().err
    assert "exit 3" in stderr
    assert "boom" in stderr


def test_missing_xcrun_fails_closed_without_retrying(resolver, monkeypatch, capsys):
    """A missing xcrun binary is determinate and must not be retried."""
    observed = _record_run(monkeypatch, resolver, [FileNotFoundError()])

    with pytest.raises(SystemExit) as exit_info:
        resolver._get_inventory()

    assert exit_info.value.code == 2
    assert len(observed) == 1
    assert "xcrun not found" in capsys.readouterr().err


def test_malformed_json_fails_closed_without_retrying(resolver, monkeypatch, capsys):
    """Unparseable output is determinate and must not be retried."""
    observed = _record_run(monkeypatch, resolver, [_completed("not json at all")])

    with pytest.raises(SystemExit) as exit_info:
        resolver._get_inventory()

    assert exit_info.value.code == 2
    assert len(observed) == 1
    assert "not valid JSON" in capsys.readouterr().err


def test_retry_constants_keep_the_total_wait_bounded(resolver):
    """The retry budget must stay small enough to be a bounded wait."""
    total = resolver.SIMCTL_TIMEOUT_SECONDS * resolver.SIMCTL_MAX_ATTEMPTS
    assert resolver.SIMCTL_MAX_ATTEMPTS >= 2, "a single attempt cannot absorb a cold start"
    assert resolver.SIMCTL_TIMEOUT_SECONDS > 15, "the observed failure exceeded the old 15s budget"
    assert total <= 120, f"worst case {total}s should stay within a bounded step budget"
