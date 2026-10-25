"""RC-37's property test: random edit sequences, a base and deltas, restored exactly.

Each example edits a workspace at random between captures (files, contents, modes,
directories, symbolic links, deletions and type changes), captures a base and deltas through
the actual receiver, uploads each staged layer, then restores the whole chain into a fresh
computer through ``restore_workspace`` and compares the trees.
"""

from __future__ import annotations

import os
import shutil
from pathlib import Path

from harness import Rig, Uploads, new_id, tree_files
from hypothesis import HealthCheck, Phase, given, settings
from hypothesis import strategies as st

NAMES = ["a", "b", "c", "d"]
paths = st.lists(st.sampled_from(NAMES), min_size=1, max_size=3).map(lambda parts: "/".join(parts))
op = st.one_of(
    st.tuples(st.just("write"), paths, st.binary(max_size=64), st.sampled_from([0o644, 0o600, 0o755])),
    st.tuples(st.just("mkdir"), paths, st.just(b""), st.sampled_from([0o755, 0o700])),
    st.tuples(st.just("link"), paths, st.sampled_from([b"a", b"../b", b"/nowhere"]), st.just(0)),
    st.tuples(st.just("delete"), paths, st.just(b""), st.just(0)),
    # Modes keep the owner's rwx: the tests may run without root, which cannot read a
    # directory its owner cannot (the supervisor runs as root on a computer).
    st.tuples(st.just("chmod"), paths, st.just(b""), st.sampled_from([0o700, 0o750, 0o755])),
)
rounds = st.lists(st.lists(op, max_size=6), min_size=1, max_size=4)


def _remove(path: Path) -> None:
    if path.is_symlink() or path.is_file():
        path.unlink()
    elif path.is_dir():
        shutil.rmtree(path)


def _apply(work: Path, edits: list) -> None:
    for kind, rel, data, mode in edits:
        path = work / rel
        parent = path.parent
        ancestors = [work / "/".join(rel.split("/")[:i]) for i in range(1, rel.count("/") + 1)]
        if any(p.is_symlink() or (p.exists() and not p.is_dir()) for p in ancestors):
            continue
        parent.mkdir(parents=True, exist_ok=True)
        if kind == "write":
            if path.is_dir() and not path.is_symlink():
                shutil.rmtree(path)
            elif path.is_symlink():
                path.unlink()
            path.write_bytes(data)
            path.chmod(mode)
        elif kind == "mkdir":
            if os.path.lexists(path) and not (path.is_dir() and not path.is_symlink()):
                _remove(path)
            path.mkdir(exist_ok=True)
            path.chmod(mode)
        elif kind == "link":
            if os.path.lexists(path):
                _remove(path)
            path.symlink_to(data.decode())
        elif kind == "delete":
            if os.path.lexists(path):
                _remove(path)
        elif kind == "chmod" and os.path.lexists(path) and not path.is_symlink():
            path.chmod(mode)


# Each example runs real capture workers and guards; shrinking such examples takes minutes,
# so a failure is reported as generated.
@settings(
    max_examples=10,
    deadline=None,
    suppress_health_check=list(HealthCheck),
    phases=[Phase.explicit, Phase.reuse, Phase.generate],
)
@given(rounds=rounds)
def test_random_edit_sequences_restore_exactly(tmp_path_factory, rounds) -> None:
    root = tmp_path_factory.mktemp("prop")
    uploads = Uploads(root / "r2")
    a = Rig(root / "a")
    try:
        a.boot()
        work = a.home / "work"
        parent = None
        for i, edits in enumerate(rounds):
            _apply(work, edits)
            if parent is None:
                op, job = a.capture()
            else:
                op, job = a.capture("delta", {"checkpointId": new_id("ckp"), "treeDigest": parent})
            if job["state"] == "unchanged":
                continue
            assert job["state"] == "staged", (i, job)
            uploads.upload(job)
            a.finish(op)
            parent = job["treeDigest"]
        expected = tree_files(a.home)
    finally:
        a.close()
    b = Rig(root / "b", computer_id=a.computer_id, generation=a.generation + 1)
    try:
        job = b.restore(uploads.manifest(a.computer_id, a.generation), uploads.restore_into(b))
        assert job["state"] == "done", job
        assert tree_files(b.home) == expected
    finally:
        b.close()
