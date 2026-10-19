"""IR-011: the paused final pass must make the snapshot equal the frozen source.

Reviewer's scenario: the unpaused first pass copies "old-state"; the file is
rewritten in place to the same length within the same second (or with its
mtime preserved); the metadata-only paused pass skips it and the snapshot keeps
"old-state". Covered here for the two-phase and incremental methods, with add,
remove and rename, a whole-tree equality check, and lease expiry during the
corrected final pass.
"""

from __future__ import annotations

import os
from pathlib import Path

from conftest import base_spec, build_home, items_for, proc_state, snapshot_files, source_files

from supervisor import capture as C

T = 1_700_000_000


def set_mtime(p: Path, ns: int) -> None:
    os.utime(p, ns=(ns, ns))


def same_second_rewrite(p: Path, data: bytes) -> None:
    """Same length, new bytes, mtime moved within the same second."""
    st = p.stat()
    assert len(data) == st.st_size
    p.write_bytes(data)
    set_mtime(p, T * 10**9 + 900_000_000)


def mtime_preserving_rewrite(p: Path, data: bytes) -> None:
    """Same length, new bytes, original mtime put back (as `cp -p` or `touch -r` would)."""
    st = p.stat()
    assert len(data) == st.st_size
    p.write_bytes(data)
    os.utime(p, ns=(st.st_atime_ns, st.st_mtime_ns))


def prepare(tmp_path: Path) -> tuple[Path, list[dict]]:
    home = tmp_path / "home"
    build_home(home, plant_credentials=False)
    state = home / "work" / "project" / "state.txt"
    state.write_bytes(b"old-state")
    set_mtime(state, T * 10**9 + 100_000_000)
    kept = home / "work" / "project" / "kept.txt"
    kept.write_bytes(b"old-kept!")
    set_mtime(kept, T * 10**9)
    (home / "work" / "project" / "to-remove.txt").write_text("bye")
    (home / "work" / "project" / "to-rename.txt").write_text("renamed content")
    return home, items_for(home)


def mutate(home: Path) -> None:
    proj = home / "work" / "project"
    same_second_rewrite(proj / "state.txt", b"new-state")
    mtime_preserving_rewrite(proj / "kept.txt", b"new-kept!")
    (proj / "added.txt").write_text("new file")
    (proj / "to-remove.txt").unlink()
    (proj / "to-rename.txt").rename(proj / "renamed.txt")


def assert_equal_to_source(res: dict, home: Path, items: list[dict]) -> None:
    assert res["outcome"] == "snapshot_ready", res
    snap = snapshot_files(Path(res["snapshot_dir"]), items, home)
    src = source_files(home, items)
    assert snap["work/project/state.txt"] == b"new-state"
    assert snap["work/project/kept.txt"] == b"new-kept!"
    assert "work/project/added.txt" in snap
    assert "work/project/to-remove.txt" not in snap
    assert "work/project/renamed.txt" in snap and "work/project/to-rename.txt" not in snap
    assert snap == src, sorted(set(snap) ^ set(src))


def test_two_phase_final_pass_is_content_correct(tmp_path: Path, target) -> None:
    home, items = prepare(tmp_path)
    spec = base_spec(tmp_path, items, tmp_path / "snap", target, method="rsync-2phase",
                     hooks={"after_precopy": lambda: mutate(home)})
    res = C.capture(spec)
    assert_equal_to_source(res, home, items)


def test_incremental_reused_snapshot_is_content_correct(tmp_path: Path, target) -> None:
    home, items = prepare(tmp_path)
    first = C.capture(base_spec(tmp_path, items, tmp_path / "snap", target, method="rsync"))
    assert first["outcome"] == "snapshot_ready", first
    mutate(home)
    res = C.capture(base_spec(tmp_path, items, tmp_path / "snap", target, method="rsync-incremental",
                              incremental_base=first["snapshot_dir"]))
    assert_equal_to_source(res, home, items)


def test_full_copy_equals_source(tmp_path: Path, target) -> None:
    home, items = prepare(tmp_path)
    mutate(home)
    res = C.capture(base_spec(tmp_path, items, tmp_path / "snap", target, method="rsync"))
    assert_equal_to_source(res, home, items)


def test_lease_expiry_during_final_pass_discards(tmp_path: Path, target) -> None:
    """A budget far too small for the paused pass: the copy is discarded, nothing is left
    stopped, and no snapshot remains."""
    home, items = prepare(tmp_path)
    big = home / "work" / "big"
    big.mkdir()
    for i in range(40):
        (big / f"f{i}.bin").write_bytes(os.urandom(1 << 20))
    spec = base_spec(tmp_path, items, tmp_path / "snap", target, method="rsync-2phase", budget_s=0.05,
                     hooks={"after_precopy": lambda: [(big / f"f{i}.bin").write_bytes(os.urandom(1 << 20)) for i in range(40)]})
    res = C.capture(spec)
    assert res["outcome"] in ("discarded_lease_expired", "failed_freeze"), res
    assert not any((tmp_path / "snap").iterdir()), list((tmp_path / "snap").iterdir())
    for pid in target.pids():
        assert proc_state(pid) not in ("T", "t")
