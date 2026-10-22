"""Tests for what the staging probe added to the capture code.

* The kept snapshot (design step 7): a two-phase capture into the previous
  snapshot stays content-correct (IR-011's scenarios).
* The entrypoint scope: only processes below the container's entrypoint are
  paused, never the entrypoint itself or anything outside its tree (an exec'd
  helper such as the backup shim).
* Incremental layers (AR-25, RC-37's spike version): a base and deltas applied
  in order reproduce the tree exactly, over random edit sequences; deleted
  paths outside the declared roots, or through a symbolic link, are refused
  with the tree unchanged; credential members in a layer are stripped; verify
  catches a difference; the hash cache survives staging.
"""

from __future__ import annotations

import json
import os
import random
import shutil
import subprocess
from pathlib import Path

import pytest
from conftest import Target, base_spec, items_for, proc_state, snapshot_files, source_files
from test_ir011_content import assert_equal_to_source, mutate, prepare

from supervisor import capture as C
from supervisor import layers as L

ROOTS = {"work": "work", "claude": ".claude", "codex": ".codex", "omnigent": ".omnigent"}


# --- kept snapshot ------------------------------------------------------------------------


def test_kept_snapshot_two_phase_is_content_correct(tmp_path: Path, target) -> None:
    home, items = prepare(tmp_path)
    first = C.capture(base_spec(tmp_path, items, tmp_path / "snap", target, method="rsync-2phase",
                                capture_id="first"))
    assert first["outcome"] == "snapshot_ready", first
    (home / "work" / "project" / "between.txt").write_text("written between captures")
    res = C.capture(base_spec(tmp_path, items, tmp_path / "snap", target, method="rsync-2phase",
                              capture_id="second", keep_base=first["snapshot_dir"],
                              hooks={"after_precopy": lambda: mutate(home)}))
    assert res.get("reused_snapshot") is True
    assert not os.path.exists(first["snapshot_dir"])  # taken over, not copied
    assert_equal_to_source(res, home, items)


def test_kept_snapshot_failure_discards_it(tmp_path: Path, target) -> None:
    """A failed capture over the kept snapshot leaves no snapshot; the next starts afresh."""
    home, items = prepare(tmp_path)
    first = C.capture(base_spec(tmp_path, items, tmp_path / "snap", target, method="rsync-2phase",
                                capture_id="first"))
    big = home / "work" / "big"
    big.mkdir()
    for i in range(30):
        (big / f"f{i}.bin").write_bytes(os.urandom(1 << 20))
    res = C.capture(base_spec(
        tmp_path, items, tmp_path / "snap", target, method="rsync-2phase", capture_id="second", budget_s=0.05,
        keep_base=first["snapshot_dir"],
        hooks={"after_precopy": lambda: [(big / f"f{i}.bin").write_bytes(os.urandom(1 << 20)) for i in range(30)]}))
    assert res["outcome"] in ("discarded_lease_expired", "failed_freeze"), res
    assert not any((tmp_path / "snap").iterdir())
    for pid in target.pids():
        assert proc_state(pid) not in ("T", "t")


# --- entrypoint scope ---------------------------------------------------------------------


def test_entry_scope_pauses_only_below_the_entrypoint(tmp_path: Path) -> None:
    home, items = prepare(tmp_path)
    entry = Target()  # stands in for tini: its child is the workload
    outside = Target()  # stands in for an exec'd helper, outside the entrypoint's tree
    seen: dict[int, str | None] = {}

    def look(_pid: int) -> None:
        for pid in outside.pids() + [entry.pid]:
            seen[pid] = proc_state(pid)

    try:
        spec = base_spec(tmp_path, items, tmp_path / "snap", None, method="rsync",
                         workload_pids=[entry.pid, outside.pid], entry_pid=entry.pid, record_kinds=True,
                         hooks={"after_stop": look})
        res = C.capture(spec)
        assert res["outcome"] == "snapshot_ready", res
        assert res["freeze"]["stopped_count"] == len(entry.children()) == 1
        assert seen and all(state not in ("T", "t") for state in seen.values()), seen
        assert res["stopped_by_kind"] == {"idle-sleep": 1}
    finally:
        entry.kill()
        outside.kill()


# --- layers -------------------------------------------------------------------------------


def write(p: Path, data: bytes, mode: int = 0o644) -> None:
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(data)
    os.chmod(p, mode)


def make_tree(top: Path) -> None:
    for root in ROOTS:
        (top / root).mkdir(parents=True)
    write(top / "work" / "proj" / "a.py", b"print(1)\n" * 50)
    write(top / "work" / "proj" / "b.py", b"x = 2\n")
    write(top / "claude" / "projects" / "s.jsonl", b'{"t":1}\n' * 20)
    write(top / "codex" / "state.sqlite-wal", os.urandom(4096))
    os.symlink("proj/a.py", top / "work" / "link")
    (top / "omnigent" / "empty").mkdir()
    for p in top.rglob("*"):
        os.lchown(p, 1000, 1000)


def random_edit(top: Path, rng: random.Random) -> None:
    files = sorted(p for p in top.rglob("*") if p.is_file() and not p.is_symlink())
    dirs = sorted(p for p in top.rglob("*") if p.is_dir() and not p.is_symlink() and p.parent != top)
    op = rng.choice(["add", "modify", "append", "delete", "rmdir", "mkdir", "chmod", "symlink", "rename",
                     "file-to-dir", "same-size"])
    root = top / rng.choice(list(ROOTS))
    if op == "add" or not files:
        write(root / f"n{rng.randrange(10**6)}" / f"f{rng.randrange(100)}.txt", os.urandom(rng.randrange(1, 3000)))
    elif op == "modify":
        write(rng.choice(files), os.urandom(rng.randrange(0, 5000)))
    elif op == "append":
        with open(rng.choice(files), "ab") as fh:
            fh.write(b"more\n" * rng.randrange(1, 50))
    elif op == "same-size":
        f = rng.choice(files)
        size = f.stat().st_size
        st = f.stat()
        f.write_bytes(os.urandom(size))
        os.utime(f, ns=(st.st_atime_ns, st.st_mtime_ns))
    elif op == "delete":
        rng.choice(files).unlink()
    elif op == "rmdir" and dirs:
        shutil.rmtree(rng.choice(dirs))
    elif op == "mkdir":
        (root / f"d{rng.randrange(10**6)}" / "sub").mkdir(parents=True)
    elif op == "chmod":
        os.chmod(rng.choice(files), rng.choice([0o600, 0o644, 0o755]))
    elif op == "symlink":
        link = root / f"l{rng.randrange(10**6)}"
        os.symlink(f"target-{rng.randrange(100)}", link)
    elif op == "rename":
        f = rng.choice(files)
        f.rename(f.with_name(f.name + ".moved"))
    elif op == "file-to-dir":
        f = rng.choice(files)
        f.unlink()
        f.mkdir()
        write(f / "inner.txt", b"was a file")


def upload_and_restore(layer_dir: Path, restored: Path) -> None:
    """Stands in for DirectoryBackup: a restore yields a copy of the staged directory."""
    if restored.exists():
        shutil.rmtree(restored)
    subprocess.run(["cp", "-a", str(layer_dir), str(restored)], check=True)


@pytest.mark.parametrize("seed", [1, 2, 3, 4, 5])
def test_base_plus_deltas_reproduce_the_tree(tmp_path: Path, seed: int) -> None:
    rng = random.Random(seed)
    snap, tree = tmp_path / "snap", tmp_path / "tree"
    make_tree(snap)
    index, _ = L.build_index(str(snap))
    L.stage(str(snap), str(tmp_path / "stage"), index, sorted(index), [], {"seq": 0, "base": True})
    upload_and_restore(tmp_path / "stage", tmp_path / "layer")
    L.merge(str(tmp_path / "layer"), str(tree), ROOTS)
    assert L.verify(str(tree), index)["equal"]
    for n in range(1, 21):
        for _ in range(rng.randrange(1, 6)):
            random_edit(snap, rng)
        new, _ = L.build_index(str(snap), index)
        changed, deleted = L.diff(index, new)
        L.stage(str(snap), str(tmp_path / "stage"), new, changed, deleted, {"seq": n, "base": False})
        upload_and_restore(tmp_path / "stage", tmp_path / "layer")
        L.merge(str(tmp_path / "layer"), str(tree), ROOTS)
        check = L.verify(str(tree), new)
        assert check["equal"], (seed, n, check)
        index = new


@pytest.mark.parametrize("bad", ["../escape", "/etc/passwd", "elsewhere/x", "work/../escape", "", "work//x",
                                 "work/./x", 7])
def test_deleted_path_outside_the_roots_is_refused(tmp_path: Path, bad: object) -> None:
    tree = tmp_path / "tree"
    make_tree(tree)
    before, _ = L.build_index(str(tree))
    layer = tmp_path / "layer"
    (layer / "work").mkdir(parents=True)
    write(layer / "work" / "new.txt", b"new")
    (layer / L.LAYER_META).write_text(json.dumps({"format": 1, "seq": 1, "deleted": ["work/proj/b.py", bad]}))
    with pytest.raises(L.LayerError):
        L.merge(str(layer), str(tree), ROOTS)
    after, _ = L.build_index(str(tree))
    # The tree is unchanged: nothing was deleted or added.
    assert {p: L._logical(e) for p, e in after.items()} == {p: L._logical(e) for p, e in before.items()}


def test_deleted_path_through_a_symbolic_link_is_refused(tmp_path: Path) -> None:
    tree = tmp_path / "tree"
    make_tree(tree)
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "keep.txt").write_text("must survive")
    os.symlink(str(outside), tree / "work" / "jump")
    layer = tmp_path / "layer"
    layer.mkdir()
    (layer / L.LAYER_META).write_text(json.dumps({"format": 1, "seq": 1, "deleted": ["work/jump/keep.txt"]}))
    with pytest.raises(L.LayerError):
        L.merge(str(layer), str(tree), ROOTS)
    assert (outside / "keep.txt").read_text() == "must survive"


def test_unknown_root_and_format_are_refused(tmp_path: Path) -> None:
    tree = tmp_path / "tree"
    make_tree(tree)
    layer = tmp_path / "layer"
    (layer / "etc").mkdir(parents=True)
    (layer / L.LAYER_META).write_text(json.dumps({"format": 1, "seq": 1, "deleted": []}))
    with pytest.raises(L.LayerError):
        L.merge(str(layer), str(tree), ROOTS)
    (layer / L.LAYER_META).write_text(json.dumps({"format": 99, "seq": 1, "deleted": []}))
    with pytest.raises(L.LayerError):
        L.merge(str(layer), str(tree), ROOTS)


def test_credential_members_in_a_layer_are_stripped(tmp_path: Path) -> None:
    tree = tmp_path / "tree"
    make_tree(tree)
    layer = tmp_path / "layer"
    write(layer / "claude" / ".credentials.json", b'{"synthetic":"S3MARKERLAYER"}')
    write(layer / "codex" / "auth.json", b'{"synthetic":"S3MARKERLAYER"}')
    write(layer / "claude" / "projects" / "ok.jsonl", b"fine\n")
    (layer / L.LAYER_META).write_text(json.dumps({"format": 1, "seq": 1, "deleted": []}))
    res = L.merge(str(layer), str(tree), ROOTS)
    assert sorted(res["stripped_credential_members"]) == ["claude/.credentials.json", "codex/auth.json"]
    assert not (tree / "claude" / ".credentials.json").exists()
    assert not (tree / "codex" / "auth.json").exists()
    assert (tree / "claude" / "projects" / "ok.jsonl").read_bytes() == b"fine\n"


def test_verify_catches_differences(tmp_path: Path) -> None:
    tree = tmp_path / "tree"
    make_tree(tree)
    index, _ = L.build_index(str(tree))
    assert L.verify(str(tree), index)["equal"]
    f = tree / "work" / "proj" / "b.py"
    st = f.stat()
    f.write_bytes(b"y = 2\n")  # same size
    os.utime(f, ns=(st.st_atime_ns, st.st_mtime_ns))
    res = L.verify(str(tree), index)
    assert not res["equal"] and res["mismatched"] == 1
    os.chown(tree / "work" / "proj" / "a.py", 0, 0)
    (tree / "work" / "extra").write_text("x")
    (tree / "claude" / "projects" / "s.jsonl").unlink()
    res = L.verify(str(tree), index)
    assert (res["mismatched"], res["extra"], res["missing"]) == (2, 1, 1)


def test_staged_layer_keeps_owners_and_the_hash_cache_survives(tmp_path: Path) -> None:
    snap = tmp_path / "snap"
    make_tree(snap)
    index, stats = L.build_index(str(snap))
    assert stats["hashed_files"] == 4
    L.stage(str(snap), str(tmp_path / "stage"), index, sorted(index), [], {"seq": 0, "base": True})
    for p in (tmp_path / "stage").rglob("*"):
        if p.name != L.LAYER_META:
            assert (p.lstat().st_uid, p.lstat().st_gid) == (1000, 1000), p
    shutil.rmtree(tmp_path / "stage")
    L.save_index(index, str(tmp_path / "index.json"))
    assert L.refresh_keys(str(snap), str(tmp_path / "index.json")) == 4
    write(snap / "work" / "proj" / "b.py", b"x = 3\n")
    os.chown(snap / "work" / "proj" / "b.py", 1000, 1000)
    again, stats = L.build_index(str(snap), L.load_index(str(tmp_path / "index.json")))
    assert stats["hashed_files"] == 1
    changed, deleted = L.diff(index, again)
    assert (changed, deleted) == (["work/proj/b.py"], [])


def test_snapshot_files_helpers_still_agree(tmp_path: Path) -> None:
    """The kept-snapshot test above relies on these helpers; a trivial cross-check."""
    home, items = prepare(tmp_path)
    t = Target()
    try:
        res = C.capture(base_spec(tmp_path, items, tmp_path / "snap", t, method="rsync"))
    finally:
        t.kill()
    assert snapshot_files(Path(res["snapshot_dir"]), items, home) == source_files(home, items)
    assert items_for(home)


# --- review fixes (Codex s3-staging r1) ---------------------------------------------------


def test_layer_root_symlink_is_refused_and_nothing_outside_is_touched(tmp_path: Path) -> None:
    """P1: a layer whose root is a symbolic link must not be walked (stripping would delete
    outside the layer) nor installed."""
    tree = tmp_path / "tree"
    make_tree(tree)
    live = tmp_path / "live-claude"
    live.mkdir()
    (live / ".credentials.json").write_text('{"synthetic":"must survive"}')
    layer = tmp_path / "layer"
    layer.mkdir()
    os.symlink(str(live), layer / "claude")
    (layer / L.LAYER_META).write_text(json.dumps({"format": 1, "seq": 1, "deleted": []}))
    with pytest.raises(L.LayerError):
        L.merge(str(layer), str(tree), ROOTS)
    assert (live / ".credentials.json").read_text() == '{"synthetic":"must survive"}'
    assert not (tree / "claude").is_symlink()


def test_credential_named_symlink_to_a_directory_is_stripped(tmp_path: Path) -> None:
    tree = tmp_path / "tree"
    make_tree(tree)
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    (elsewhere / "keep.txt").write_text("not ours")
    layer = tmp_path / "layer"
    (layer / "claude").mkdir(parents=True)
    os.symlink(str(elsewhere), layer / "claude" / ".credentials.json")
    os.symlink(str(elsewhere), layer / "claude" / "plain-link")
    (layer / L.LAYER_META).write_text(json.dumps({"format": 1, "seq": 1, "deleted": []}))
    res = L.merge(str(layer), str(tree), ROOTS)
    assert res["stripped_credential_members"] == ["claude/.credentials.json"]
    assert not os.path.lexists(tree / "claude" / ".credentials.json")
    assert (tree / "claude" / "plain-link").is_symlink()  # installed as a link, never followed
    assert (elsewhere / "keep.txt").read_text() == "not ours"


def test_kept_snapshot_drops_a_deleted_root(tmp_path: Path, target) -> None:
    """P2: a declared root that disappears between captures must disappear from the reused snapshot."""
    home, items = prepare(tmp_path)
    first = C.capture(base_spec(tmp_path, items, tmp_path / "snap", target, method="rsync-2phase",
                                capture_id="first"))
    assert os.path.isdir(os.path.join(first["snapshot_dir"], "codex"))
    shutil.rmtree(home / ".codex")
    res = C.capture(base_spec(tmp_path, items, tmp_path / "snap", target, method="rsync-2phase",
                              capture_id="second", keep_base=first["snapshot_dir"]))
    assert res["outcome"] == "snapshot_ready", res
    assert not os.path.exists(os.path.join(res["snapshot_dir"], "codex"))
    assert snapshot_files(Path(res["snapshot_dir"]), items, home) == source_files(home, items)


def test_root_deleted_between_the_passes_is_dropped(tmp_path: Path, target) -> None:
    home, items = prepare(tmp_path)
    res = C.capture(base_spec(tmp_path, items, tmp_path / "snap", target, method="rsync-2phase",
                              hooks={"after_precopy": lambda: shutil.rmtree(home / ".codex")}))
    assert res["outcome"] == "snapshot_ready", res
    assert not os.path.exists(os.path.join(res["snapshot_dir"], "codex"))
