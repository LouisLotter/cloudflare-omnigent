"""RC-53: the layer scan finds every encoded form, and real layers hold no planted token.

The scanner proves itself first (every form, archives, SQLite overflow pages and WAL, a
missing control, an unreadable archive). Then real captures through the actual receiver:
tokens planted in the credential families and in the native harnesses' secret files (with
their temporary-write variants), a control canary in a saved file before each capture, each
staged layer archived as tar+zstd as DirectoryBackup stores it, decompressed and scanned.
"""

from __future__ import annotations

import base64
import io
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import tarfile
import urllib.parse
from pathlib import Path

import pytest
from cfo_computer import rc53 as rc53_scan  # noqa: E402
from harness import Rig, canary, new_id


def _encodings(value: str) -> dict[str, bytes]:
    raw = value.encode()
    return {
        "raw": raw,
        "json": json.dumps({"k": value}).encode(),
        "url": urllib.parse.quote(value, safe="").encode(),
        "hex": raw.hex().encode(),
        "b64-0": base64.b64encode(raw),
        "b64-1": base64.b64encode(b"x" + raw),
        "b64-2": base64.urlsafe_b64encode(b"xy" + raw),
        "utf16": value.encode("utf-16-le"),
    }


@pytest.mark.parametrize("form", list(_encodings("x" * 40)))
def test_the_scan_finds_every_form(tmp_path: Path, form: str) -> None:
    value = canary("form") + "/+=?&"
    (tmp_path / "t").mkdir()
    (tmp_path / "t" / "f.bin").write_bytes(b"prefix" + _encodings(value)[form] + b"suffix")
    code, report = rc53_scan.run([tmp_path / "t"], [value], [])
    assert code == 1 and report["findings"], form
    assert value not in json.dumps(report), "the report never prints a value"


def test_sqlite_overflow_pages_and_wal_and_archives(tmp_path: Path) -> None:
    value = canary("sqlite")
    tree = tmp_path / "t"
    tree.mkdir()
    con = sqlite3.connect(tree / "state.sqlite")
    con.execute("pragma journal_mode=wal")
    con.execute("create table t (v text)")
    # Spread over overflow pages: the token straddles a page boundary in the file.
    con.execute("insert into t values (?)", ("y" * 4090 + value + "z" * 9000,))
    con.commit()
    shutil.copy(tree / "state.sqlite", tmp_path / "db-copy")
    shutil.copy(tree / "state.sqlite-wal", tmp_path / "wal-copy")
    con.close()
    shutil.copy(tmp_path / "db-copy", tree / "state.sqlite")
    shutil.copy(tmp_path / "wal-copy", tree / "state.sqlite-wal")
    code, report = rc53_scan.run([tree], [value], [])
    assert code == 1 and any("sqlite value" in f["file"] for f in report["findings"])
    archive = tmp_path / "layer.tar.zst"
    if shutil.which("zstd"):
        subprocess.run(["tar", "-I", "zstd", "-cf", str(archive), "-C", str(tree), "."], check=True)
        code, report = rc53_scan.run([archive], [value], [])
        assert code == 1
    gz = io.BytesIO()
    with tarfile.open(fileobj=gz, mode="w:gz") as tar:
        tar.add(tree, arcname=".")
    (tmp_path / "layer.tar.gz").write_bytes(gz.getvalue())
    code, _ = rc53_scan.run([tmp_path / "layer.tar.gz"], [value], [])
    assert code == 1


def test_a_missing_control_or_an_unreadable_archive_is_never_clean(tmp_path: Path) -> None:
    tree = tmp_path / "t"
    tree.mkdir()
    (tree / "f").write_text("nothing")
    assert rc53_scan.run([tree], [canary("absent")], [canary("control")])[0] == 1
    (tmp_path / "bad.tar.zst").write_bytes(b"\x28\xb5\x2f\xfd" + b"garbage")
    assert rc53_scan.run([tmp_path / "bad.tar.zst"], [canary("absent")], [])[0] == 3
    assert rc53_scan.run([tree], [canary("absent")], [])[0] == 0


SECRET_FILES = [
    ".claude/.credentials.json",
    ".claude/.credentials.json.tmp.1a2b3c4d",
    ".claude/.device-keys.json",
    ".codex/auth.json",
    ".codex/auth.json.tmp",
    ".codex/.credentials.json",
    ".omnigent/auth_tokens.json",
    ".omnigent/codex-native/b1/policy_hook.json",
    ".omnigent/codex-native/b1/policy_hook.json.k2j3h4g5",
    ".omnigent/codex-native/b1/bridge.json",
    ".omnigent/codex-native/b1/bridge.json.a1b2c3d4",
    ".omnigent/codex-native/b1/server.json",
    ".omnigent/codex-native/b1/.server.json.x9y8z7w6.tmp",
    ".omnigent/codex-native/b1/tool_relay.json",
    ".omnigent/codex-native/b1/.tool_relay.json.q1w2e3r4.tmp",
    ".omnigent/codex-native/b1/tool_relay.env",
    ".omnigent/codex-native/b1/turn_router.json",
    ".omnigent/codex-native/b1/subagent_router.json.p0o9i8u7.tmp",
    ".omnigent/codex-native/b1/provider_key",
    ".omnigent/codex-native/b1/provider_key.m1n2b3v4",
    ".omnigent/codex-native/b1/codex-home/auth.json",
    ".omnigent/codex-native/b1/codex-home/.credentials.json",
    ".omnigent/cache/codex-model-probe/x/auth.json",
    ".claude/backups/.claude.json.backup.1",
]


def test_no_planted_token_in_any_archived_layer(tmp_path: Path) -> None:
    rig = Rig(tmp_path / "a")
    archives = tmp_path / "layers"
    archives.mkdir()
    controls, values = [], {}
    try:
        rig.boot()
        bridge = rig.home / ".omnigent" / "codex-native" / "b1"
        (bridge / "codex-home" / "sessions").mkdir(parents=True)
        (bridge / "codex-home" / "config.toml").write_text('model = "gpt-private"\n')
        (bridge / "dead_letter.jsonl").write_text('{"event_type":"external_conversation_item"}\n')
        parent = None
        for round_ in range(3):
            for rel in SECRET_FILES:  # every generation of every token, rotated each round
                value = canary(f"r{round_}")
                values[f"{rel} r{round_}"] = value
                path = rig.home / rel
                path.parent.mkdir(parents=True, exist_ok=True)
                encoded = base64.b64encode(value.encode()).decode()
                path.write_text(
                    json.dumps({"token": value, "header": f"Bearer {value}", "b64": encoded})
                )
            control = canary(f"control{round_}")
            controls.append(control)
            (rig.home / "work" / "control.txt").write_text(control)
            if parent is None:
                op, job = rig.capture()
            else:
                op, job = rig.capture(
                    "delta", {"checkpointId": new_id("ckp"), "treeDigest": parent}
                )
            assert job["state"] == "staged", job
            archive = archives / f"{round_}.tar.gz"
            with tarfile.open(archive, "w:gz") as tar:
                tar.add(job["layerDir"], arcname=".")
            rig.finish(op)
            parent = job["treeDigest"]
            # This round's control must be in this round's layer.
            code, report = rc53_scan.run([archive], list(values.values()), [control])
            assert code == 0, report
        # Continuation state the policy saves is in the base.
        with tarfile.open(archives / "0.tar.gz") as tar:
            names = set(tar.getnames())
        assert "./.omnigent/codex-native/b1/dead_letter.jsonl" in names
        assert "./.omnigent/codex-native/b1/codex-home/config.toml" in names
    finally:
        rig.close()


def _disk_holds(top: Path, values: list[str]) -> list[str]:
    hits = []
    for dirpath, _dirs, files in os.walk(top):
        for name in files:
            full = Path(dirpath) / name
            if full.is_symlink():
                continue
            data = full.read_bytes()
            if any(v.encode() in data for v in values):
                hits.append(str(full.relative_to(top)))
    return hits


def _rc53_rig(tmp_path: Path, token: str):
    holder = subprocess.Popen(
        [sys.executable, "-c", "import time; time.sleep(60)"],
        env={**os.environ, "OMNIGENT_HOST_TOKEN": token},
    )
    rig = Rig(tmp_path / "a", scope_pids=[holder.pid])
    rig.boot()
    (rig.layout.state / "rc53").mkdir()
    (rig.layout.state / "rc53" / "enabled").write_text("")
    rig.sup.rc53_tmp_roots = [tmp_path / "no-tmp"]
    return holder, rig


def test_the_opt_in_staging_check_keeps_values_in_memory(tmp_path: Path) -> None:
    """With ``<state>/rc53/enabled``, the supervisor collects the live values (the workload's
    environments, the bridges, the logins) before each capture and hands them to the worker
    on an anonymous memory descriptor; the worker scans the staged layer. No value is written
    to disk, a spec, a result or a log (Codex r2, finding 1)."""
    token = canary("hosttoken")
    holder, rig = _rc53_rig(tmp_path, token)
    try:
        bridge = rig.home / ".omnigent" / "codex-native" / "b1"
        bridge.mkdir(parents=True)
        delegated = canary("delegated")
        (bridge / "policy_hook.json").write_text(
            json.dumps({"ap_auth_headers": {"Authorization": f"Bearer {delegated}"}})
        )
        (rig.home / "work" / "notes.txt").write_text("no token here")
        op, job = rig.capture()
        assert job["state"] == "staged", job
        result = rig.result(op)["rc53"]
        assert result == {**result, "status": 0, "findings": 0, "incomplete": 0}
        assert result["values"] >= 2
        assert token in rig.sup._rc53_values and delegated in rig.sup._rc53_values
        assert not (rig.layout.state / "rc53" / "values").exists()
        # Only the home holds a value (the bridge file, as Omnigent wrote it).
        assert _disk_holds(rig.root, [token, delegated]) == [
            "home/.omnigent/codex-native/b1/policy_hook.json"
        ]
    finally:
        holder.kill()
        rig.close()


def test_a_detected_token_is_never_offered_for_upload(tmp_path: Path) -> None:
    """A finding fails the capture before it is reported staged (Codex r2, finding 4): the job
    WorkspaceDO reads says failed, no layer is left to upload, and the published parent stays."""
    token = canary("hosttoken")
    holder, rig = _rc53_rig(tmp_path, token)
    try:
        op, first = rig.capture()
        assert first["state"] == "staged"
        rig.finish(op)
        (rig.home / "work" / "leak.txt").write_text(f"export T={token}")
        op, job = rig.capture(
            "delta", {"checkpointId": new_id("ckp"), "treeDigest": first["treeDigest"]}
        )
        assert job == {
            "kind": "capture",
            "jobOperationId": op,
            "state": "failed",
            "reason": "policy_violation",
            "pausedMs": job["pausedMs"],
        }
        assert list(rig.layout.staged.iterdir()) == []
        assert not list(rig.layout.data.glob("pending-*.json"))
        assert rig.result(op)["rc53"]["findings"] >= 1
        assert token not in json.dumps(rig.result(op)) and token not in json.dumps(job)
        assert rig.sup.published_digest == first["treeDigest"]
        # The supervisor's own view of the job matches what WorkspaceDO reads.
        assert rig.sup._capture_job_view(op, rig.result(op))["state"] == "failed"
        # Remove the leak: the next capture is clean again.
        (rig.home / "work" / "leak.txt").unlink()
        _op, job = rig.capture(
            "delta", {"checkpointId": new_id("ckp"), "treeDigest": first["treeDigest"]}
        )
        assert job["state"] == "unchanged"
    finally:
        holder.kill()
        rig.close()


def test_a_failed_collection_fails_the_capture(tmp_path: Path, monkeypatch) -> None:
    from cfo_computer import rc53_collect

    holder, rig = _rc53_rig(tmp_path, canary("t"))
    try:

        def broken(*a, **k):
            raise OSError("collection failed")

        monkeypatch.setattr(rc53_collect, "collect", broken)
        _op, job = rig.capture()
        assert job["state"] == "failed" and job["reason"] == "policy_violation", job
        assert list(rig.layout.staged.iterdir()) == []
    finally:
        holder.kill()
        rig.close()


def test_rc53_verdict() -> None:
    from cfo_computer.capture import rc53_verdict

    assert rc53_verdict(0) is None
    assert "live token" in rc53_verdict(1)
    assert "completely" in rc53_verdict(3)


def test_the_collector_asks_the_host_broker_for_the_github_token(tmp_path: Path) -> None:
    """Production collection with a synthetic broker answer (Codex r2, finding 6): the
    collector speaks git's credential format to every broker socket under its root, and the
    supervisor's own collection before a capture finds the token in a staged layer."""
    import socket
    import tempfile
    import threading

    from cfo_computer import rc53_collect

    github = "ghu_" + canary("github")
    root = Path(tempfile.mkdtemp(prefix="cfo34-"))  # AF_UNIX paths must stay short
    server = socket.socket(socket.AF_UNIX)
    asked: list[str] = []

    def serve() -> None:
        while True:
            try:
                conn, _ = server.accept()
            except OSError:
                return
            with conn:
                request = b""
                while chunk := conn.recv(4096):
                    request += chunk
                asked.append(request.decode())
                conn.sendall(
                    "protocol=https\nhost=github.com\nusername=x-access-token\n"
                    f"password={github}\n".encode()
                )

    thread = threading.Thread(target=serve, daemon=True)
    holder = rig = None
    try:
        (root / "omnigent-1000").mkdir()
        server.bind(str(root / "omnigent-1000" / "credentials-0123456789abcdef.sock"))
        server.listen(4)
        thread.start()
        home = root / "home"
        home.mkdir()
        values = rc53_collect.collect(home, tmp_roots=[], process_scope=set(), broker_root=root)
        assert github in values
        assert asked and "host=github.com" in asked[0] and "protocol=https" in asked[0]
        # Without a broker root, no broker is asked.
        assert github not in rc53_collect.collect(home, tmp_roots=[], process_scope=set())
        assert len(asked) == 1
        # The supervisor's collection, as in production: a layer holding the token fails.
        holder, rig = _rc53_rig(tmp_path, canary("hosttoken"))
        rig.sup.rc53_broker_root = root
        (rig.home / "work" / "remote.txt").write_text(f"https://x-access-token:{github}@github.com")
        op, job = rig.capture()
        assert job["state"] == "failed" and job["reason"] == "policy_violation", job
        assert len(asked) == 2 and github in rig.sup._rc53_values
        assert github not in json.dumps(rig.result(op))
    finally:
        server.close()
        if holder is not None:
            holder.kill()
        if rig is not None:
            rig.close()
        shutil.rmtree(root, ignore_errors=True)
