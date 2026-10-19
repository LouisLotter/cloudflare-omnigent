"""IR-015: no credential file, temporary sibling or lock enters a workspace snapshot.

The filename families come from S6's audited policy (spikes/s6/credsync/core.py):
Claude's .credentials.json and its ".tmp.<hex>" siblings, the provisional
.device-keys.json with its siblings and lock, Codex's auth.json, and Omnigent's
auth_tokens.json with its ".<random>.tmp" siblings and lock. Each planted file
holds a distinct marker. Every copy method is checked, including a reused
snapshot that already holds forbidden members, then the uploaded archive and a
restore. An older archive that holds forbidden members must not install them.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest
from conftest import (
    FakeS3,
    base_spec,
    build_home,
    credential_family_paths,
    forbidden_in,
    items_for,
    load_s6,
    snapshot_files,
    zstd_tar_members,
)

from supervisor import capture as C
from supervisor import upload as U

METHODS = ["rsync", "rsync-2phase", "rsync-incremental", "reflink"]


def test_policy_copy_matches_s6_source() -> None:
    """The image's copy of S6's policy is the repository file (same SHA-256)."""
    expected = os.environ.get("S3_S6_SHA256")
    if not expected:
        pytest.skip("run through bench/run_tests.py, which passes the source digest")
    got = hashlib.sha256(Path("/opt/s3/s6credsync/core.py").read_bytes()).hexdigest()
    assert got == expected


def test_every_family_is_covered_by_the_policy() -> None:
    s6 = load_s6()
    paths = credential_family_paths()
    assert {".claude/.credentials.json", ".claude/.device-keys.json", ".codex/auth.json",
            ".omnigent/auth_tokens.json"} <= set(paths)
    assert any(p.startswith(".omnigent/.auth_tokens.json.") for p in paths)
    assert any(".device-keys.json.tmp." in p for p in paths)
    assert all(s6.is_credential_or_sibling(p) for p in paths)


def test_rsync_globs_cover_every_family() -> None:
    """The widened globs handed to rsync match every concrete family name."""
    import fnmatch

    from supervisor import credpolicy

    for path in credential_family_paths():
        root, _, rest = path.partition("/")
        patterns = credpolicy.credential_excludes(root)
        assert any(fnmatch.fnmatchcase("/" + rest, p) for p in patterns), (path, patterns)


def older_snapshot_with_credentials(home: Path, snap_root: Path, items: list[dict]) -> Path:
    """A snapshot as an older policy would have left it: every file, credentials included."""
    base = snap_root / "older"
    for it in items:
        dst = base / it["name"]
        if os.path.isdir(it["src"]):
            shutil.copytree(it["src"], dst, symlinks=True)
        elif os.path.exists(it["src"]):
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(it["src"], dst)
    return base


@pytest.mark.parametrize("method", METHODS)
def test_snapshot_archive_and_restore_hold_no_credentials(method: str, tmp_path: Path, target) -> None:
    home = tmp_path / "home"
    markers = build_home(home)
    items = items_for(home)
    snap_root = tmp_path / "snap"
    snap_root.mkdir()
    kw: dict = {"method": method}
    if method == "rsync-incremental":
        kw["incremental_base"] = str(older_snapshot_with_credentials(home, snap_root, items))
    res = C.capture(base_spec(tmp_path, items, snap_root, target, **kw))
    assert res["outcome"] == "snapshot_ready", res
    if method != "reflink":
        # rsync itself left them out; the prune found nothing to remove.
        assert not [p for p in res.get("pruned", []) if load_s6().is_credential_or_sibling(
            {"claude": ".claude", "codex": ".codex", "omnigent": ".omnigent", "work": "work"}[p.split("/", 1)[0]]
            + "/" + p.split("/", 1)[1])], res["pruned"]
    snap = Path(res["snapshot_dir"])
    files = snapshot_files(snap, items, home)

    # No forbidden member, and no marker bytes anywhere in the snapshot.
    assert forbidden_in(list(files)) == []
    blob = b"".join(files.values())
    leaked = [rel for rel, m in markers.items() if m in blob]
    assert leaked == []
    # Positive controls: history and settings survive.
    assert ".claude/projects/-home-agent-work/session-1.jsonl" in files
    assert ".codex/sessions/2026/10/18/rollout-1.jsonl" in files
    assert ".claude/.claude.json" in files

    # The uploaded archive holds none of them either.
    s3 = FakeS3()
    up = U.upload_snapshot({"bucket": "b", "computer_id": "c", "snapshot_dir": str(snap),
                            "capture_id": res["capture_id"], "delete_snapshot": False}, s3=s3)
    assert up["published"], up
    obj = s3.objects[up["key"]]
    members = zstd_tar_members(obj)
    assert not [m for m in markers.values() if m in b"".join(members.values())]

    # And a restore into a fresh home installs none of them.
    restored = tmp_path / "restored"
    rr = U.restore_latest("b", "c", str(restored), s3=s3)
    assert rr["outcome"] == "restored", rr
    names = {it["name"]: os.path.relpath(it["src"], home) for it in items}
    rel = []
    for p in restored.rglob("*"):
        if p.is_file():
            top, _, rest = str(p.relative_to(restored)).partition("/")
            rel.append(f"{names.get(top, top)}/{rest}")
    assert ".claude/projects/-home-agent-work/session-1.jsonl" in rel
    assert forbidden_in(rel) == []


def test_older_archive_with_credentials_is_not_installed(tmp_path: Path) -> None:
    """A workspace archive written under an older policy holds a credential sibling.
    Restoring it must leave that member out and keep the rest."""
    staging = tmp_path / "old"
    (staging / "claude" / "projects").mkdir(parents=True)
    (staging / "claude" / "projects" / "s.jsonl").write_text("history\n")
    paths = credential_family_paths()
    for rel in paths:
        top, _, rest = rel.partition("/")
        name = {".claude": "claude", ".codex": "codex", ".omnigent": "omnigent"}[top]
        p = staging / name / rest
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text('{"synthetic":"old-archive"}')
    tar = subprocess.run(["tar", "-C", str(staging), "-cf", "-", "."], capture_output=True, check=True).stdout
    blob = subprocess.run(["zstd", "-q", "-c"], input=tar, capture_output=True, check=True).stdout
    s3 = FakeS3()
    key = "checkpoints/c/old.tar.zst"
    s3.put_object(Bucket="b", Key=key, Body=blob)
    manifest = {"format_version": 1, "computer_id": "c", "generation": 1, "capture_id": "old",
                "objects": [{"key": key, "size": len(blob), "sha256": hashlib.sha256(blob).hexdigest(),
                             "format": "tar+zstd/1"}]}
    s3.put_object(Bucket="b", Key="manifests/c/old.json", Body=json.dumps(manifest).encode())
    s3.put_object(Bucket="b", Key="pointers/c.json",
                  Body=json.dumps({"manifest": "manifests/c/old.json", "capture_id": "old"}).encode())
    target = tmp_path / "restored"
    rr = U.restore_latest("b", "c", str(target), s3=s3)
    assert rr["outcome"] == "restored", rr
    assert (target / "claude" / "projects" / "s.jsonl").read_text() == "history\n"
    names = {"claude": ".claude", "codex": ".codex", "omnigent": ".omnigent"}
    installed = []
    for p in target.rglob("*"):
        if p.is_file():
            top, _, rest = str(p.relative_to(target)).partition("/")
            installed.append(f"{names.get(top, top)}/{rest}")
    assert forbidden_in(installed) == [], installed
