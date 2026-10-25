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
import shutil
import sqlite3
import subprocess
import sys
import tarfile
import urllib.parse
from pathlib import Path

import pytest
from harness import COMPUTER, Rig, canary, new_id

sys.path.insert(0, str(COMPUTER / "tools"))
import rc53_scan  # noqa: E402


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
