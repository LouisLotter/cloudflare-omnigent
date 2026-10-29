"""Checkpoint exclusion must survive hard-link aliases before copying any bytes."""

import copy
import os
import shutil
import stat
from pathlib import Path

import pytest
from cfo_computer.contract import DECLARED_CREDENTIAL_PATHS
from cfo_computer.policy import Policy
from cfo_computer.tree import scan_home

POLICY = Path(__file__).resolve().parents[3] / "contracts/fixtures/CheckpointPolicy/v1.json"
MARKER = b"synthetic excluded credential for filesystem regression"


def write(home, rel, content=MARKER):
    path = home / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(content)
    return path


@pytest.mark.parametrize("reverse", [False, True])
@pytest.mark.parametrize(
    "source",
    [
        ".codex/auth.json",
        ".codex/auth.json.tmp.123",
        ".claude/.credentials.json",
        ".claude/backups/old-login.json",
        ".claude/backups/a/b/old-login.json",
        ".omnigent/cache/codex-model-probe/auth.json",
        ".omnigent/codex-native/session/provider_key",
        ".omnigent/codex-native/session/unclassified/secret",
        "work/project/node_modules/a/key",
        "outside-roots/secret",
    ],
)
def test_excluded_hardlink_never_enters_saved_projection(tmp_path, source, reverse):
    home = tmp_path / "home"
    src = write(home, source)
    alias = home / "work/alias"
    alias.parent.mkdir(parents=True, exist_ok=True)
    os.link(src, alias)
    policy = Policy.load(POLICY)
    if reverse:
        policy.roots = tuple(reversed(policy.roots))
    scan = scan_home(home, policy, declared=DECLARED_CREDENTIAL_PATHS)
    regulars = [rel for rel, st in scan.entries if stat.S_ISREG(st.st_mode)]
    assert "work/alias" not in regulars
    assert scan.skipped  # exclusion is visible to the future capture caller
    # Independent consumer: do not use the scanner's policy to decide what to copy again.
    for rel in regulars:
        dst = tmp_path / "saved" / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(home / rel, dst)
        assert MARKER not in dst.read_bytes()


def test_all_saved_links_and_ordinary_files_survive(tmp_path):
    src = write(tmp_path, "work/a", b"ordinary content")
    os.link(src, tmp_path / "work/b")
    write(tmp_path, "work/c", b"other content")
    scan = scan_home(tmp_path, Policy.load(POLICY))
    assert {rel for rel, st in scan.entries if stat.S_ISREG(st.st_mode)} == {
        "work/a",
        "work/b",
        "work/c",
    }
    assert not scan.skipped


def test_skipped_directory_is_not_crawled_and_symlink_not_followed(tmp_path, monkeypatch):
    src = write(tmp_path, ".claude/backups/nested/secret")
    (tmp_path / "work").mkdir()
    os.link(src, tmp_path / "work/alias")
    (tmp_path / "work/symlink").symlink_to(src.parent, target_is_directory=True)
    scandir = os.scandir

    def bounded(path):
        assert "/backups" not in str(path)
        assert "/symlink" not in str(path)
        return scandir(path)

    monkeypatch.setattr(os, "scandir", bounded)
    scan = scan_home(tmp_path, Policy.load(POLICY))
    assert "work/alias" not in {rel for rel, _ in scan.entries}
    assert "work/symlink" in {rel for rel, _ in scan.entries}


def test_duplicate_root_does_not_account_for_hidden_link(tmp_path):
    src = write(tmp_path, ".claude/backups/secret")
    (tmp_path / "work").mkdir()
    os.link(src, tmp_path / "work/alias")
    policy = Policy.load(POLICY)
    data = copy.deepcopy(policy.data)
    data["roots"] = ["work", "work"]
    scan = scan_home(tmp_path, Policy(data))
    assert "work/alias" not in {rel for rel, _ in scan.entries}


def test_declared_file_is_excluded_even_under_saved_root(tmp_path):
    write(tmp_path, "work/declared")
    scan = scan_home(tmp_path, Policy.load(POLICY), declared=["work/declared"])
    assert "work/declared" not in {rel for rel, _ in scan.entries}


def test_codex_log_database_stays_out_of_a_save_and_its_continuation_goes_in(tmp_path):
    """WP3.27: ``logs_N.sqlite`` (with its WAL, shared memory and journal) is Codex's own trace
    log, which it prunes by age; on 28 Oct it held a ChatGPT edge token Codex had logged. A real
    capture through the supervisor leaves it out, in a session's private CODEX_HOME and in
    ``~/.codex``, and keeps Codex 0.164.0's continuation databases and rollouts."""
    from harness import Rig, canary

    marker = canary("wp327-codex-log").encode()
    rig = Rig(tmp_path / "a")
    try:
        rig.boot()
        homes = [".omnigent/codex-native/b1/codex-home", ".codex"]
        logs = ["logs_2.sqlite", "logs_2.sqlite-wal", "logs_2.sqlite-shm", "logs_1.sqlite-journal"]
        kept = [
            "state_5.sqlite",
            "state_5.sqlite-wal",
            "goals_1.sqlite",
            "queue_1.sqlite",
            "thread_history_1.sqlite",
            "sessions/2026/10/28/rollout-x.jsonl",
        ]
        for home in homes:
            for name in logs:
                write(rig.home, f"{home}/{name}", b"SQLite format 3\0" + marker)
            for name in kept:
                write(rig.home, f"{home}/{name}", b"continuation")
        op, job = rig.capture()
        assert job["state"] == "staged", job
        layer = Path(job["layerDir"])
        staged = {
            str((Path(d) / f).relative_to(layer))
            for d, _dirs, files in os.walk(layer)
            for f in files
        }
        for home in homes:
            assert not [p for p in staged if p.startswith(f"{home}/logs_")], staged
            for name in kept:
                assert f"{home}/{name}" in staged, (home, name)
        for d, _dirs, files in os.walk(layer):
            for f in files:
                assert marker not in (Path(d) / f).read_bytes()
        rig.finish(op)
    finally:
        rig.close()
