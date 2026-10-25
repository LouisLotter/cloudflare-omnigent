"""The native harnesses' secret files and continuation state, on the real capture and restore.

Ported from S6's follow-up (``spikes/s6/followup/bridge_check.py``) onto the supervisor: the
writers are Omnigent's own (``/opt/venv``, fork ``cfo/integration`` at the image's pin), the
captures and restores go through the actual receiver.

1. Paused writers (G1BR-001's residual): each secret writer is held after its temporary file
   holds a synthetic credential and before the rename, including the policy hook's renewal and
   core change 20's provider key; a capture is taken right then. No layer holds the temporary
   or any planted value (RC-53's scan, every encoded form).
2. Codex's restore test (G1BR-001): a native Codex session with private configuration and two
   events the server never received, saved as a base and a delta, restored after a disk
   replacement, keeps both; each event reaches the server once; restoring the same checkpoint
   again re-posts under the same ``source_id`` and the server still holds one item each.
"""

from __future__ import annotations

import base64
import json
import os
import subprocess
import sys
import time
from pathlib import Path

from harness import Rig, Uploads, canary, new_id

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
import rc53_scan  # noqa: E402

WRITERS = Path(__file__).resolve().parent / "bridge_writers.py"
VENV_PYTHON = "/opt/venv/bin/python"


def _writer(rig: Rig, mode: str, ctl: Path, *extra: str) -> subprocess.Popen[bytes]:
    tmp = rig.root / "tmp"  # $TMPDIR stays outside every checkpointed root
    tmp.mkdir(exist_ok=True)
    env = {
        "HOME": str(rig.home),
        "TMPDIR": str(tmp),
        "PATH": "/opt/venv/bin:/usr/local/bin:/usr/bin:/bin",
        "XDG_CONFIG_HOME": str(rig.home / ".config"),
        "XDG_CACHE_HOME": str(rig.home / ".cache"),
    }
    return subprocess.Popen([VENV_PYTHON, "-I", str(WRITERS), mode, str(ctl), *extra], env=env)


def _wait(path: Path, proc: subprocess.Popen[bytes], timeout: float = 120) -> bool:
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if path.exists():
            return True
        if proc.poll() is not None:
            return path.exists()
        time.sleep(0.01)
    raise AssertionError(f"timed out waiting for {path.name}")


def test_paused_secret_writers_never_reach_a_layer(tmp_path: Path) -> None:
    ctl = tmp_path / "ctl"
    ctl.mkdir()
    rig = Rig(tmp_path / "a")
    try:
        rig.boot()
        writer = _writer(rig, "writers", ctl)
        rig.sup.scope_pids = [writer.pid]
        paused: list[dict] = []
        seen_values: list[str] = []
        while True:
            _wait(ctl / "paused.json", writer)
            if not (ctl / "paused.json").exists():
                break
            record = json.loads((ctl / "paused.json").read_text())
            assert record["values"], record  # the temporary holds a credential right now
            seen_values += record["values"]
            op, job = rig.capture()
            assert job["state"] == "staged", job
            layer = Path(job["layerDir"])
            index = json.loads((layer / ".cfo-layer" / "index.json").read_text())
            paths = {e["path"] for e in index["entries"]}
            if record["temporary"]:
                assert record["temporary"] not in paths, record
            code, report = rc53_scan.run([layer], seen_values, [])
            assert code == 0, (record["target"], report)
            rig.finish(op, "discarded")
            paused.append(record)
            (ctl / "paused.json").unlink()
            (ctl / "go").write_text("")
        assert writer.wait(timeout=60) == 0
        done = json.loads((ctl / "done.json").read_text())
        targets = {Path(p["target"]).name for p in paused}
        assert {
            "policy_hook.json",
            "bridge.json",
            "tool_relay.json",
            "server.json",
            "turn_router.json",
            "subagent_router.json",
            "provider_key",
        } <= targets, targets
        assert (
            sum(1 for p in paused if p["target"].endswith("policy_hook.json")) == 2
        )  # and its renewal
        op, job = rig.capture()
        code, report = rc53_scan.run([Path(job["layerDir"])], list(done["planted"].values()), [])
        assert code == 0, report
    finally:
        rig.close()


DECLARED = (
    ".claude/.credentials.json",
    ".claude/.device-keys.json",
    ".codex/auth.json",
    ".codex/.credentials.json",
)


def _bundle(computer_id: str, files: dict[str, bytes]) -> dict:
    out = {}
    for rel in DECLARED:
        if rel in files:
            out[rel] = {
                "state": "present",
                "mode": 0o600,
                "copyOrder": 1,
                "contentBase64": base64.b64encode(files[rel]).decode(),
            }
        else:
            out[rel] = {"state": "tombstone", "copyOrder": 1}
    return {
        "formatVersion": 1,
        "computerId": computer_id,
        "generation": 1,
        "order": 1,
        "files": out,
    }


def test_codex_session_and_undelivered_events_survive_a_disk_replacement(tmp_path: Path) -> None:
    logins = {
        ".codex/auth.json": json.dumps(
            {
                "OPENAI_API_KEY": None,
                "tokens": {
                    "id_token": canary("cid"),
                    "access_token": canary("cacc"),
                    "refresh_token": canary("cref"),
                    "account_id": "synthetic",
                },
                "last_refresh": "2026-10-25T00:00:00Z",
            }
        ).encode(),
        ".codex/.credentials.json": json.dumps({"mcp": {"access_token": canary("cmcp")}}).encode(),
        ".claude/.credentials.json": json.dumps(
            {"claudeAiOauth": {"accessToken": canary("clacc")}}
        ).encode(),
    }
    secrets = [v for data in logins.values() for v in rc53_scan_values(data)]
    uploads = Uploads(tmp_path / "r2")
    a = Rig(tmp_path / "a")
    bundle = _bundle(a.computer_id, logins)
    try:
        assert a.restore()["state"] == "done"
        a.install(bundle)
        codex = a.home / ".codex"
        (codex / "config.toml").write_text('model = "gpt-shared"\n')
        (codex / "AGENTS.md").write_text("shared notes\n")
        (codex / "memories_1.sqlite").write_bytes(b"")
        for d in ("memories", "rules", "plugins/cache", "mcp-oauth-locks"):
            (codex / d).mkdir(parents=True, exist_ok=True)
        ctl = tmp_path / "ctl"
        ctl.mkdir()
        assert _writer(a, "session-1", ctl).wait(timeout=120) == 0
        op, base = a.capture()
        assert base["state"] == "staged", base
        uploads.upload(base)
        a.finish(op)
        assert _writer(a, "session-2", ctl).wait(timeout=120) == 0
        op, delta = a.capture(
            "delta", {"checkpointId": new_id("ckp"), "treeDigest": base["treeDigest"]}
        )
        index = uploads.upload(delta)
        a.finish(op)
        changed = {e["path"] for e in index["entries"]}
        bridge = json.loads((ctl / "session.json").read_text())["bridge"]
        assert (
            f"{bridge}/dead_letter.jsonl" in changed
            and f"{bridge}/codex-home/config.toml" in changed
        )
        # RC-53: no login, and no link-copied login in the private home, in any layer.
        code, report = rc53_scan.run(
            [uploads.root / i["layerId"] for _j, i in uploads.jobs], secrets, []
        )
        assert code == 0, report
    finally:
        a.close()

    server = tmp_path / "server.json"
    results = []
    for name in ("b", "c"):  # c: the same checkpoint again, as after a crash before the next save
        rig = Rig(tmp_path / name, computer_id=a.computer_id, generation=a.generation + 1)
        try:
            job = rig.restore(
                uploads.manifest(a.computer_id, a.generation), uploads.restore_into(rig)
            )
            assert job["state"] == "done" and job["stripped"] == 0, job
            rig.install(bundle)
            out = tmp_path / f"reconcile-{name}.json"
            proc = _writer(rig, "reconcile", tmp_path / "ctl", str(server), str(out))
            assert proc.wait(timeout=120) == 0
            results.append(json.loads(out.read_text()))
        finally:
            rig.close()
    first, second = results
    for r in results:
        assert r["auth_link_is_symlink"] and r["mcp_login_same_inode"], r
        assert r["private_model_kept"] and r["instructions_kept"], r
        assert r["rollout_has_one"] and r["rollout_has_two"] and r["rollout_has_delivered"], r
    assert first["queue_before"] == 2 and first["queue_after"] == 0
    assert len(first["server_items"]) == 2
    assert second["server_items"] == first["server_items"], "still one item per event"
    assert all(n == 2 for n in second["server_posts"].values()), (
        "re-posted under the same source_id"
    )


def rc53_scan_values(data: bytes) -> list[str]:
    import re

    return re.findall(r"CFO_CANARY_[A-Za-z0-9]+", data.decode())


_ = os  # parity with the harness imports
