"""IR-016: a failed copy of any declared root must fail the whole capture.

Reviewer's scenario: a root that cannot be cloned fails, later roots succeed,
the helper returns 0 and the snapshot is marked ready without that root's
files. Covered: first and middle root failing, a snapshot filesystem without
reflink support, ENOSPC part-way, and a failing prune, each with no
snapshot left and nothing stopped; plus a successful all-roots control.

The container has two tmpfs mounts (bench/run_tests.py): /mnt/tmpfs, where a
root placed there cannot be cloned into the overlay snapshot area, and the
8 MB /mnt/small.
"""

from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path

import pytest
from conftest import base_spec, build_home, forbidden_in, items_for, proc_state, snapshot_files, source_files

from supervisor import capture as C

TMPFS = Path("/mnt/tmpfs")
SMALL = Path("/mnt/small")


def reflink_supported(where: Path) -> bool:
    a = where / ".rl-a"
    b = where / ".rl-b"
    a.write_bytes(b"x" * 8192)
    ok = subprocess.run(["cp", "--reflink=always", str(a), str(b)], capture_output=True).returncode == 0
    a.unlink()
    if b.exists():
        b.unlink()
    return ok


def move_root_to_tmpfs(item: dict, tag: str) -> None:
    """Put this root's files on tmpfs: cloning them into the overlay snapshot fails."""
    dst = TMPFS / tag / os.path.basename(item["src"])
    shutil.rmtree(dst, ignore_errors=True)
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(item["src"], dst, symlinks=True)
    item["src"] = str(dst)


def no_snapshot_left(snap_root: Path) -> None:
    left = [p.name for p in snap_root.iterdir()]
    assert left == [], left


def all_running(target) -> None:
    for pid in target.pids():
        assert proc_state(pid) not in ("T", "t")


@pytest.fixture
def home(tmp_path: Path) -> Path:
    h = tmp_path / "home"
    build_home(h, plant_credentials=False)
    (h / "work" / "document.txt").write_bytes(b"x" * 43)
    return h


def test_reflink_success_control(tmp_path: Path, home: Path, target) -> None:
    if not reflink_supported(tmp_path):
        pytest.skip("the container filesystem does not support reflinks")
    items = items_for(home)
    res = C.capture(base_spec(tmp_path, items, tmp_path / "snap", target, method="reflink"))
    assert res["outcome"] == "snapshot_ready", res
    assert snapshot_files(Path(res["snapshot_dir"]), items, home) == source_files(home, items)


@pytest.mark.parametrize("which", ["first", "middle"])
def test_reflink_root_failure_is_not_hidden(which: str, tmp_path: Path, home: Path, target) -> None:
    if not reflink_supported(tmp_path):
        pytest.skip("the container filesystem does not support reflinks")
    items = items_for(home)
    idx = 0 if which == "first" else 1
    assert items[0]["name"] == "work"
    move_root_to_tmpfs(items[idx], f"{which}-{os.getpid()}")
    res = C.capture(base_spec(tmp_path, items, tmp_path / "snap", target, method="reflink"))
    assert res["outcome"] != "snapshot_ready", res
    assert res["published"] is False
    no_snapshot_left(tmp_path / "snap")
    all_running(target)


def test_reflink_unsupported_snapshot_filesystem(tmp_path: Path, home: Path, target) -> None:
    snap_root = TMPFS / f"snap-{os.getpid()}"
    shutil.rmtree(snap_root, ignore_errors=True)
    res = C.capture(base_spec(tmp_path, items_for(home), snap_root, target, method="reflink"))
    assert res["outcome"] != "snapshot_ready", res
    no_snapshot_left(snap_root)
    all_running(target)


@pytest.mark.parametrize("method", ["rsync", "rsync-2phase", "reflink"])
def test_enospc_part_way(method: str, tmp_path: Path, home: Path, target) -> None:
    big = home / "work" / "big"
    big.mkdir()
    for i in range(12):
        (big / f"f{i}.bin").write_bytes(os.urandom(1 << 20))
    snap_root = SMALL / f"snap-{method}-{os.getpid()}"
    shutil.rmtree(snap_root, ignore_errors=True)
    res = C.capture(base_spec(tmp_path, items_for(home), snap_root, target, method=method,
                              margin_bytes=-(10**12)))
    assert res["outcome"] != "snapshot_ready", res
    no_snapshot_left(snap_root)
    all_running(target)


def test_failed_prune_rejects_the_snapshot(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, target) -> None:
    """A reflink copy clones everything, then prunes; if the prune fails, discard."""
    if not reflink_supported(tmp_path):
        pytest.skip("the container filesystem does not support reflinks")
    from supervisor import credpolicy

    h = tmp_path / "home"
    build_home(h)  # caches and credential families to prune
    items = items_for(h)

    def broken(*_a, **_k):
        raise OSError("injected prune failure")

    monkeypatch.setattr(credpolicy, "_remove", broken)
    res = C.capture(base_spec(tmp_path, items, tmp_path / "snap", target, method="reflink"))
    assert res["outcome"] != "snapshot_ready", res
    no_snapshot_left(tmp_path / "snap")


def test_rsync_success_control_has_no_forbidden_members(tmp_path: Path, target) -> None:
    h = tmp_path / "home"
    build_home(h)
    items = items_for(h)
    res = C.capture(base_spec(tmp_path, items, tmp_path / "snap", target, method="rsync"))
    assert res["outcome"] == "snapshot_ready", res
    assert forbidden_in(list(snapshot_files(Path(res["snapshot_dir"]), items, h))) == []
