"""Credential install, the watcher, publication, sign-out and login status (ST-01).

Through the supervisor's real receiver and its real background loops, with the fake CLIs
writing their login files the way the pinned CLIs do (Claude: atomic rename; Codex: rewritten
in place) and a fake WorkspaceDO that applies ``credentialIsNewer``.
"""

from __future__ import annotations

import base64
import json
import os
import subprocess
import time
from pathlib import Path

import pytest
from harness import FAKES, FakeWorkspace, Rig, canary

DECLARED = (
    ".claude/.credentials.json",
    ".claude/.device-keys.json",
    ".codex/auth.json",
    ".codex/.credentials.json",
)


def _until(predicate, timeout: float = 20.0, what: str = "condition") -> None:
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if predicate():
            return
        time.sleep(0.05)
    raise AssertionError(f"timed out waiting for {what}")


@pytest.fixture
def rig(tmp_path: Path):
    workspace = FakeWorkspace()
    rig = Rig(tmp_path / "a", workspace=workspace)
    rig.provider = tmp_path / "provider" / "state.json"
    rig.sup.extra_env = {"CFO_FAKE_PROVIDER": str(rig.provider)}
    rig.sup.start_loops()
    yield rig
    rig.close()
    workspace.close()


def _cli(rig: Rig, *argv: str, **env: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [str(FAKES / argv[0]), *argv[1:]],
        env={
            "HOME": str(rig.home),
            "PATH": os.environ["PATH"],
            "CFO_FAKE_PROVIDER": str(rig.provider),
            **env,
        },
        capture_output=True,
        text=True,
        check=False,
    )


def _bundle(rig: Rig, order: int, files: dict[str, bytes | None]) -> dict:
    out = {}
    for rel in DECLARED:
        data = files.get(rel)
        if data is None:
            out[rel] = {"state": "tombstone", "copyOrder": 1}
        else:
            out[rel] = {
                "state": "present",
                "mode": 0o600,
                "copyOrder": order,
                "contentBase64": base64.b64encode(data).decode(),
            }
    return {
        "formatVersion": 1,
        "computerId": rig.computer_id,
        "generation": 2,
        "order": max(f["copyOrder"] for f in out.values()),
        "files": out,
    }


def test_install_puts_only_the_declared_files_in_place(rig: Rig) -> None:
    assert rig.restore()["state"] == "done"
    (rig.home / ".codex").mkdir()
    (rig.home / ".codex" / ".credentials.json").write_text("a stale MCP login")
    (rig.home / ".codex" / "config.toml").write_text('model = "x"\n')
    claude = canary("claude").encode()
    bundle = _bundle(rig, 5, {".claude/.credentials.json": claude, ".codex/auth.json": b"{}"})
    command = rig.command("install_credentials", bundle=bundle)
    status, reply = rig.post(command)
    assert status == 200, reply
    assert reply["installed"] == [".claude/.credentials.json", ".codex/auth.json"]
    assert reply["removed"] == [".codex/.credentials.json"]
    assert reply["orderFloor"] == 0
    assert (rig.home / ".claude" / ".credentials.json").read_bytes() == claude
    assert (rig.home / ".claude" / ".credentials.json").stat().st_mode & 0o777 == 0o600
    assert (rig.home / ".codex" / "config.toml").read_text() == 'model = "x"\n'
    # A repeat returns the recorded answer; another computer's bundle is refused.
    assert rig.post(command) == (200, reply)
    other = dict(bundle, computerId="cmp_" + "0" * 26)
    status, err = rig.send("install_credentials", bundle=other)
    assert status == 400 and err["error"]["code"] == "bad_request"


def test_sign_in_refresh_and_logout_are_published_in_order(rig: Rig) -> None:
    rig.boot()
    ws = rig.workspace
    assert _cli(rig, "claude", "auth", "login").returncode == 0
    _until(lambda: ws.pointer and ws.pointer["files"][".claude/.credentials.json"]["state"] == "present",
           what="the Claude login published")
    first = ws.pointer
    assert first["generation"] == rig.generation and first["computerId"] == rig.computer_id
    # Codex rewrites auth.json in place; a slow write must never be copied torn.
    assert _cli(rig, "codex", "login", "--device-auth", CFO_FAKE_SLOW_WRITE_MS="700").returncode == 0
    _until(lambda: ws.pointer["files"][".codex/auth.json"]["state"] == "present", what="the Codex login")
    assert _cli(rig, "codex", "refresh", CFO_FAKE_SLOW_WRITE_MS="700").returncode == 0
    _until(lambda: base64.b64decode(ws.pointer["files"][".codex/auth.json"]["contentBase64"])
           == (rig.home / ".codex" / "auth.json").read_bytes(), what="the refreshed Codex login")
    for message in ws.of("credential_checkpoint"):
        entry = message["bundle"]["files"][".codex/auth.json"]
        if entry["state"] == "present":
            json.loads(base64.b64decode(entry["contentBase64"]))  # never a torn copy
    # Orders only grow, and a file's copy order never goes back.
    published = [m["bundle"] for m in ws.of("credential_checkpoint")]
    for a, b in zip(published, published[1:], strict=False):
        assert b["order"] >= a["order"]
        assert all(b["files"][p]["copyOrder"] >= a["files"][p]["copyOrder"] for p in DECLARED)
    # Login status comes from each CLI's own status command.
    rig.sup.refresh_logins()
    assert rig.sup.logins == {"claude": "signed_in", "codex": "signed_in"}
    # Sign-out through the receiver: both logouts run, the watcher publishes tombstones.
    reply = rig.ok("sign_out")
    assert reply == {"type": "sign_out", "claude": "ok", "codex": "ok"}
    _until(lambda: all(ws.pointer["files"][p]["state"] == "tombstone" for p in DECLARED),
           what="the tombstones")
    provider = json.loads(rig.provider.read_text())
    assert provider["claude"]["revoked"] and provider["codex"]["revoked"]
    rig.sup.refresh_logins()
    assert rig.sup.logins == {"claude": "signed_out", "codex": "signed_out"}
    # The scratch-directory check of a sign-out (Q6): the published bundle installs nothing.
    assert rig.sup.verify_signed_out(ws.pointer) == []
    assert rig.sup.verify_signed_out(first) == [".claude/.credentials.json"]


def test_credential_snapshot_is_a_barrier_and_idempotent(rig: Rig) -> None:
    rig.boot()
    assert _cli(rig, "claude", "auth", "login").returncode == 0
    command = rig.command("credential_snapshot")
    status, reply = rig.post(command)
    assert status == 200 and reply["order"] >= 1
    _until(lambda: rig.workspace.pointer and rig.workspace.pointer["order"] >= reply["order"],
           what="the snapshot published")
    assert rig.post(command) == (200, reply)


def test_publication_is_repeated_unchanged_until_answered(rig: Rig) -> None:
    rig.boot()
    rig.workspace.drop = {"credential_checkpoint": 3}
    assert _cli(rig, "claude", "auth", "login").returncode == 0
    _until(lambda: rig.workspace.pointer is not None, timeout=30, what="publication after drops")
    sent = rig.workspace.of("credential_checkpoint")
    assert len(sent) >= 4
    assert len({m["operationId"] for m in sent[:4]}) == 1, "one operation ID for the repeats"
    assert rig.sup.creds.pending() == []


def test_unpublished_changes_are_reported_pending(rig: Rig) -> None:
    rig.boot()
    rig.workspace.refuse = "unavailable"
    assert _cli(rig, "codex", "login").returncode == 0
    _until(lambda: ".codex/auth.json" in rig.sup.creds.pending(), what="pending")
    assert ".codex/auth.json" in rig.sup.report()["credentialsPending"]


def test_a_declared_path_that_is_a_link_is_never_followed(rig: Rig, tmp_path: Path) -> None:
    rig.boot()
    outside = tmp_path / "outside.json"
    outside.write_text(canary("outside"))
    (rig.home / ".codex").mkdir(exist_ok=True)
    os.symlink(outside, rig.home / ".codex" / "auth.json")
    status, reply = rig.send("credential_snapshot")
    assert status == 500 and reply["error"]["code"] == "internal"
    assert all(canary_ not in json.dumps(m) for m in rig.workspace.messages for canary_ in [outside.read_text()])
