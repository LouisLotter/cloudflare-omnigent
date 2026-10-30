"""Restore points and the rollback (WP3.41): the module on a file store, then the entrypoint as a
process with the pinned Litestream: a restore point taken before the app starts, writes after it,
and a rollback that gives back exactly the database the restore point recorded.

Every value is synthetic. The S3 path runs against an S3 stand-in in
``tests/integration/test_restore_point_image.py``.
"""

from __future__ import annotations

import json
import os
import sqlite3
from pathlib import Path
from typing import Any

import pytest
from hypothesis import HealthCheck, given, settings
from hypothesis import strategies as st
from test_entrypoint import Rig, _with_config, requires_litestream, table_values

from cfo_server import config as image_config
from cfo_server import entrypoint
from cfo_server import restore_point as rp
from cfo_server.entrypoint import Ready, prepare_database

RP = "rp-20261030T120000Z-0a1b2c3d"
OLDER = ["rp-20261001T000000Z-00000001", "rp-20261002T000000Z-00000002"]


# ── Where restore points live ─────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("url", "replica", "points", "copy"),
    [
        (
            "s3://cfo-db/omnigent",
            "omnigent/",
            "cfo-restore-points/",
            "s3://cfo-db/cfo-restore-points/X/replica",
        ),
        (
            "s3://cfo-db/a/b/",
            "a/b/",
            "a/cfo-restore-points/",
            "s3://cfo-db/a/cfo-restore-points/X/replica",
        ),
        (
            "file:///srv/replica",
            "srv/replica/",
            "srv/cfo-restore-points/",
            "file:///srv/cfo-restore-points/X/replica",
        ),
    ],
)
def test_restore_points_live_beside_the_replica_outside_its_path(
    url: str, replica: str, points: str, copy: str
) -> None:
    where = rp.places(url)
    assert (where.replica, where.points, where.copy_url("X")) == (replica, points, copy)
    assert not where.points.startswith(where.replica)


@pytest.mark.parametrize(
    "url",
    [
        "s3://cfo-db",
        "s3://cfo-db/",
        "s3://cfo-db/x/cfo-restore-points",
        "s3://b/a/../c",
        "gs://b/x",
    ],
)
def test_a_replica_without_room_beside_it_is_refused(url: str) -> None:
    with pytest.raises(ValueError):
        rp.places(url)


def test_settings_name_restore_points_strictly(tmp_path: Path) -> None:
    rig = Rig(tmp_path)
    good = rig.env(CFO_RESTORE_POINT=RP, CFO_ROLLBACK_TO=RP)
    config = image_config.load(good)
    assert (config.restore_point, config.rollback_to) == (RP, RP)
    assert image_config.load(rig.env()).restore_point is None
    for extra, message in [
        ({"CFO_RESTORE_POINT": "rp-yesterday"}, "CFO_RESTORE_POINT must be a restore point"),
        ({"CFO_ROLLBACK_TO": RP}, "CFO_ROLLBACK_TO must name the restore point"),
        (
            {"CFO_RESTORE_POINT": RP, "CFO_ROLLBACK_TO": OLDER[0]},
            "CFO_ROLLBACK_TO must name the restore point",
        ),
        (
            {"CFO_RESTORE_POINT": RP, "CFO_REPLICA_URL": "file:///"},
            "restore points need a replica with a path",
        ),
    ]:
        with pytest.raises(image_config.ConfigError, match=message):
            image_config.load(rig.env(**extra))


# ── The module on a file store ────────────────────────────────────────────────────────


class Replica:
    """A file store with a fake replica: objects under ``root/db/omnigent/``."""

    def __init__(self, root: Path) -> None:
        self.store = rp.FileStore(root)
        self.where = rp.places("file:///db/omnigent")
        self.root = root

    def put(self, objects: dict[str, bytes]) -> None:
        for key, data in objects.items():
            path = self.root / self.where.replica / key
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)

    def contents(self, prefix: str | None = None) -> dict[str, bytes]:
        base = self.root / (self.where.replica if prefix is None else prefix)
        if not base.is_dir():
            return {}
        return {
            p.relative_to(base).as_posix(): p.read_bytes()
            for p in sorted(base.rglob("*"))
            if p.is_file()
        }

    def take(self, rp_id: str = RP, **kwargs: Any) -> rp.Taken:
        kwargs.setdefault("database", None)
        kwargs.setdefault("build", {"omnigentCommit": "0" * 40})
        kwargs.setdefault("deadline", float("inf"))
        return rp.take(self.store, self.where, rp_id, **kwargs)

    def roll_back(self, rp_id: str = RP, verify: Any = None, **kwargs: Any) -> rp.RolledBack:
        return rp.roll_back(
            self.store,
            self.where,
            rp_id,
            verify_copy=verify or (lambda _m: None),
            **kwargs,
        )


LTX = {
    "ltx/0/0000000000000003-0000000000000003.ltx": b"l0-3",
    "ltx/1/0000000000000001-0000000000000003.ltx": b"l1-1-3",
    "ltx/9/0000000000000001-0000000000000001.ltx": b"snapshot",
}


def test_a_restore_point_copies_every_object_and_writes_its_manifest_last(tmp_path: Path) -> None:
    r = Replica(tmp_path)
    r.put(LTX)
    db = tmp_path / "restored.db"
    db.write_bytes(b"database bytes")
    taken = r.take(database=db)
    assert taken.new and taken.pruned == ()
    assert r.contents(r.where.copy(RP)) == LTX
    manifest = json.loads((tmp_path / r.where.manifest(RP)).read_text())
    assert manifest["id"] == RP and manifest["format"] == 1
    assert {o["key"]: o["size"] for o in manifest["objects"]} == {k: len(v) for k, v in LTX.items()}
    assert manifest["database"] == {"sha256": rp.sha256_of(db)[0], "bytes": 14}
    assert taken.manifest.summary() == {
        "id": RP,
        "takenAt": manifest["takenAt"],
        "objects": 3,
        "bytes": sum(len(v) for v in LTX.values()),
    }
    # Taken once: a later start under the same name finds it, even after the replica moved on.
    r.put({"ltx/0/0000000000000004-0000000000000004.ltx": b"after"})
    again = r.take(database=db)
    assert not again.new and again.manifest == taken.manifest
    assert r.contents(r.where.copy(RP)) == LTX


def test_an_unfinished_copy_never_counts_and_is_started_over(tmp_path: Path) -> None:
    r = Replica(tmp_path)
    r.put(LTX)
    calls = {"n": 0}

    def stop_after_one() -> bool:
        calls["n"] += 1
        return calls["n"] > 1

    with pytest.raises(rp.RestorePointError, match="stopped"):
        r.take(should_stop=stop_after_one)
    assert not (tmp_path / r.where.manifest(RP)).exists()
    # A leftover the replica no longer holds goes too.
    stray = tmp_path / r.where.copy(RP) / "ltx/0/stray.ltx"
    stray.parent.mkdir(parents=True, exist_ok=True)
    stray.write_bytes(b"stray")
    assert r.take().new
    assert r.contents(r.where.copy(RP)) == LTX


def test_a_restore_point_past_its_deadline_or_of_an_empty_replica_is_refused(
    tmp_path: Path,
) -> None:
    r = Replica(tmp_path)
    with pytest.raises(rp.RestorePointError, match="holds no backup"):
        r.take()
    r.put(LTX)
    with pytest.raises(rp.RestorePointError, match="deadline"):
        r.take(deadline=0.0, clock=lambda: 1.0)
    assert not (tmp_path / r.where.manifest(RP)).exists()
    with pytest.raises(rp.RestorePointError, match="name"):
        r.take("rp-not-a-name")


class LossyStore(rp.FileStore):
    """Copies drop the last object, as a copy that went wrong would."""

    def copy(self, source: str, target: str) -> None:
        if not source.endswith("9/0000000000000001-0000000000000001.ltx"):
            super().copy(source, target)


def test_a_copy_that_differs_from_the_replica_is_refused(tmp_path: Path) -> None:
    r = Replica(tmp_path)
    r.put(LTX)
    r.store = LossyStore(tmp_path)
    with pytest.raises(rp.RestorePointError, match="differs"):
        r.take()
    assert not (tmp_path / r.where.manifest(RP)).exists()


def test_the_newest_three_are_kept_and_older_ones_deleted(tmp_path: Path) -> None:
    r = Replica(tmp_path)
    r.put(LTX)
    names = [f"rp-2026100{d}T000000Z-0000000{d}" for d in range(1, 6)]
    pruned = [r.take(name).pruned for name in names[:4]]
    assert pruned == [(), (), (), (names[0],)]
    # An unfinished attempt older than the newest, and something else in the folder.
    (tmp_path / r.where.copy("rp-20261001T120000Z-000000aa")).mkdir(parents=True)
    (tmp_path / r.where.copy("rp-20261001T120000Z-000000aa") / "x").write_bytes(b"x")
    (tmp_path / r.where.points / "README").write_bytes(b"not a restore point")
    taken = r.take(names[4])
    assert taken.pruned == ("rp-20261001T120000Z-000000aa", names[1])
    # (A file store keeps the empty folders; S3 has none.)
    left = sorted(
        p.name
        for p in (tmp_path / r.where.points).iterdir()
        if p.is_file() or any(f.is_file() for f in p.rglob("*"))
    )
    assert left == ["README", *names[2:]]


def test_a_failed_pruning_never_fails_the_restore_point(tmp_path: Path) -> None:
    r = Replica(tmp_path)
    r.put(LTX)
    for name in [*OLDER, "rp-20261003T000000Z-00000003"]:
        r.take(name)
    events: list[tuple[str, dict[str, Any]]] = []

    class NoDelete(rp.FileStore):
        def delete(self, key: str) -> None:
            if "cfo-restore-points" in key and RP not in key:
                raise OSError("injected")
            super().delete(key)

    r.store = NoDelete(tmp_path)
    taken = r.take(log=lambda name, **f: events.append((name, f)))
    assert taken.new and events and events[0][0] == "restore_point.prune_failed"


def test_a_rollback_puts_the_restore_point_back_exactly_once(tmp_path: Path) -> None:
    r = Replica(tmp_path)
    r.put(LTX)
    r.take()
    # The new release migrates: new objects, one rewritten, one compacted away.
    (tmp_path / r.where.replica / "ltx/0/0000000000000003-0000000000000003.ltx").unlink()
    r.put({"ltx/0/0000000000000004-0000000000000004.ltx": b"migration", LTX_KEY_SNAPSHOT: b"new"})
    seen: list[dict[str, int]] = []
    done = r.roll_back(verify=lambda m: seen.append(m.objects) or None)
    assert done == rp.RolledBack(True, False, "3 objects put back as the replica")
    assert seen == [{k: len(v) for k, v in LTX.items()}]
    assert r.contents() == LTX
    marker = json.loads((tmp_path / r.where.marker(RP)).read_text())
    assert marker["restored"] is True
    # The previous release writes; a lingering order never puts the restore point back again.
    r.put({"ltx/0/0000000000000004-0000000000000004.ltx": b"previous release"})
    after = r.contents()
    again = r.roll_back(verify=lambda _m: pytest.fail("no second rollback"))
    assert again.already and r.contents() == after


LTX_KEY_SNAPSHOT = "ltx/9/0000000000000001-0000000000000001.ltx"


def test_a_restore_point_that_does_not_restore_leaves_the_replica_as_it_is(tmp_path: Path) -> None:
    r = Replica(tmp_path)
    r.put(LTX)
    r.take()
    r.put({"ltx/0/0000000000000004-0000000000000004.ltx": b"migration"})
    migrated = r.contents()
    with pytest.raises(rp.RestorePointError, match="does not restore as recorded: bad"):
        r.roll_back(verify=lambda _m: "bad")
    assert r.contents() == migrated
    (tmp_path / r.where.copy(RP) / LTX_KEY_SNAPSHOT).unlink()
    with pytest.raises(rp.RestorePointError, match="incomplete"):
        r.roll_back()
    assert r.contents() == migrated
    assert not (tmp_path / r.where.marker(RP)).exists()


def test_without_a_restore_point_the_rollback_changes_nothing(tmp_path: Path) -> None:
    """The update's server never took it, so it never started Omnigent: nothing to put back."""
    r = Replica(tmp_path)
    r.put(LTX)
    done = r.roll_back(verify=lambda _m: pytest.fail("nothing to verify"))
    assert done.restored is False and not done.already
    assert r.contents() == LTX
    assert json.loads((tmp_path / r.where.marker(RP)).read_text())["restored"] is False


def test_a_rollback_stopped_before_the_replica_changes_changes_nothing(tmp_path: Path) -> None:
    r = Replica(tmp_path)
    r.put(LTX)
    r.take()
    r.put({"ltx/0/0000000000000004-0000000000000004.ltx": b"migration"})
    migrated = r.contents()
    with pytest.raises(rp.RestorePointError, match="stopped"):
        r.roll_back(should_stop=lambda: True)
    assert r.contents() == migrated


_keys = st.sampled_from(
    [f"ltx/{lv}/{n:016x}-{n:016x}.ltx" for lv in (0, 1, 9) for n in range(1, 6)]
)
_contents = st.dictionaries(_keys, st.binary(min_size=1, max_size=8), min_size=1, max_size=8)


@settings(max_examples=60, suppress_health_check=[HealthCheck.function_scoped_fixture])
@given(before=_contents, after=st.dictionaries(_keys, st.binary(max_size=8), max_size=8))
def test_any_change_after_the_restore_point_is_undone_by_the_rollback(
    tmp_path_factory: pytest.TempPathFactory, before: dict[str, bytes], after: dict[str, bytes]
) -> None:
    r = Replica(tmp_path_factory.mktemp("prop"))
    r.put(before)
    r.take()
    # Whatever the new release does to the replica: writes, rewrites, deletions (empty values).
    for key, data in after.items():
        path = r.root / r.where.replica / key
        if data:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
        else:
            path.unlink(missing_ok=True)
    r.roll_back()
    assert r.contents() == before


# ── The entrypoint, with the pinned Litestream ────────────────────────────────────────


@pytest.fixture
def rig(tmp_path: Path):  # noqa: ANN201
    r = Rig(tmp_path)
    yield r
    r.kill_all()


def _where(rig: Rig) -> rp.Places:
    return rp.places(f"file://{rig.replica}")


def _replica_files(rig: Rig) -> dict[str, bytes]:
    return {
        p.relative_to(rig.replica).as_posix(): p.read_bytes()
        for p in sorted(rig.replica.rglob("*"))
        if p.is_file()
    }


def _restored_values(rig: Rig) -> list[str]:
    """The replica restored to a fresh file, as the next server's start would."""
    entrypoint.remove_local_database_state(rig.layout())
    rig.db.unlink(missing_ok=True)
    env = rig.env(initialized="true")
    decision = prepare_database(rig.config(env), _with_config(rig, env), env)
    assert isinstance(decision, Ready) and decision.source == "restored", decision
    return table_values(rig.db)


@requires_litestream
def test_the_update_server_takes_its_restore_point_before_the_app_starts(rig: Rig) -> None:
    rig.seed(with_owner=True)
    before = _replica_files(rig)
    rig.start(rig.env(initialized="true", CFO_RESTORE_POINT=RP))
    status = rig.wait_phase("running")
    rig.wait_app()
    where = _where(rig)
    manifest_path = Path("/") / where.manifest(RP)
    # The app started after the manifest existed: Omnigent never runs before its restore point.
    assert manifest_path.stat().st_mtime_ns <= rig.marker.stat().st_mtime_ns
    assert status["restorePoint"]["id"] == RP and status["restorePoint"]["objects"] == len(before)
    manifest = json.loads(manifest_path.read_text())
    copy = Path("/") / where.copy(RP)
    assert {
        p.relative_to(copy).as_posix(): p.read_bytes() for p in copy.rglob("*") if p.is_file()
    } == before
    # The new release writes (its migration), then stops with a confirmed final sync.
    rig.write("migrated")
    assert rig.stop() == entrypoint.EXIT_OK
    assert rig.events("restore_point.taken")[0]["objects"] == len(before)
    assert _restored_values(rig) == ["seed-0", "seed-1", "seed-2", "migrated"]

    # A second start under the same name keeps the restore point it has.
    rig.start(rig.env(initialized="true", CFO_RESTORE_POINT=RP))
    rig.wait_phase("running")
    assert rig.stop() == entrypoint.EXIT_OK
    assert rig.events("restore_point.present") and not rig.events("restore_point.taken")
    assert json.loads(manifest_path.read_text()) == manifest

    # The rollback: the replica as the restore point recorded it, checked, then exit 79.
    rig.start(rig.env(initialized="true", CFO_RESTORE_POINT=RP, CFO_ROLLBACK_TO=RP))
    assert rig.wait(60) == entrypoint.EXIT_ROLLED_BACK
    assert rig.events("rollback.done")[0]["restored"] is True
    assert _replica_files(rig) == before
    assert _restored_values(rig) == ["seed-0", "seed-1", "seed-2"]
    assert rp.sha256_of(rig.db)[0] == manifest["database"]["sha256"]

    # The previous release starts on it and writes; a lingering order changes nothing more.
    rig.db.unlink()
    entrypoint.remove_local_database_state(rig.layout())
    rig.start(rig.env(initialized="true"))
    rig.wait_phase("running")
    rig.wait_app()
    rig.write("after the rollback")
    assert rig.stop() == entrypoint.EXIT_OK
    after = _replica_files(rig)
    rig.db.unlink(missing_ok=True)
    entrypoint.remove_local_database_state(rig.layout())
    rig.start(rig.env(initialized="true", CFO_RESTORE_POINT=RP, CFO_ROLLBACK_TO=RP))
    assert rig.wait(60) == entrypoint.EXIT_ROLLED_BACK
    assert rig.events("rollback.done")[0]["already"] is True
    assert _replica_files(rig) == after
    assert _restored_values(rig) == ["seed-0", "seed-1", "seed-2", "after the rollback"]


@requires_litestream
def test_without_its_restore_point_the_app_never_starts(rig: Rig) -> None:
    rig.seed(with_owner=True)
    where = _where(rig)
    # The restore points' folder cannot be written: the copy fails.
    points = Path("/") / where.points
    points.parent.mkdir(parents=True, exist_ok=True)
    points.write_text("a file where the folder should be")
    rig.start(rig.env(initialized="true", CFO_RESTORE_POINT=RP))
    assert rig.wait(60) == entrypoint.EXIT_RESTORE_POINT_FAILED
    assert rig.events("restore_point.failed")
    assert not rig.marker.exists()


@requires_litestream
def test_a_rollback_without_a_restore_point_leaves_the_replica(rig: Rig) -> None:
    rig.seed(with_owner=True)
    before = _replica_files(rig)
    rig.start(rig.env(initialized="true", CFO_RESTORE_POINT=RP, CFO_ROLLBACK_TO=RP))
    assert rig.wait(60) == entrypoint.EXIT_ROLLED_BACK
    assert rig.events("rollback.done")[0]["restored"] is False
    assert _replica_files(rig) == before
    assert not rig.marker.exists()


@requires_litestream
def test_a_restore_point_that_restores_another_database_is_never_put_back(rig: Rig) -> None:
    rig.seed(with_owner=True)
    rig.start(rig.env(initialized="true", CFO_RESTORE_POINT=RP))
    rig.wait_app()
    rig.write("migrated")
    assert rig.stop() == entrypoint.EXIT_OK
    migrated = _replica_files(rig)
    manifest_path = Path("/") / _where(rig).manifest(RP)
    manifest = json.loads(manifest_path.read_text())
    manifest["database"]["sha256"] = "0" * 64
    manifest_path.write_text(json.dumps(manifest))
    rig.start(rig.env(initialized="true", CFO_RESTORE_POINT=RP, CFO_ROLLBACK_TO=RP))
    assert rig.wait(60) == entrypoint.EXIT_ROLLBACK_FAILED
    assert "not the one recorded" in rig.events("rollback.failed")[0]["error"]
    assert _replica_files(rig) == migrated


def test_the_apps_own_exit_79_is_never_taken_for_a_rollback(rig: Rig) -> None:
    rig.start(rig.env(), app_env={"FAKE_APP_EXIT_CODE": "79"})
    assert rig.wait(60) == entrypoint.EXIT_APP_EXITED


@requires_litestream
def test_a_new_installation_has_nothing_to_protect(rig: Rig) -> None:
    rig.start(rig.env(initialized="false", CFO_RESTORE_POINT=RP))
    rig.wait_app()
    assert rig.stop() == entrypoint.EXIT_OK
    assert rig.events("restore_point.skipped")
    assert not (Path("/") / _where(rig).manifest(RP)).exists()


def test_restore_point_reads_its_own_database_digest(tmp_path: Path) -> None:
    db = tmp_path / "x.db"
    with sqlite3.connect(db) as conn:
        conn.execute("CREATE TABLE t (v)")
    digest, size = rp.sha256_of(db)
    assert len(digest) == 64 and size == os.path.getsize(db)


def test_the_platform_and_the_installer_use_the_same_names_and_exit() -> None:
    """The platform Worker's maintenance.ts names the same exit code and restore point IDs."""
    from conftest import REPO_ROOT

    source = REPO_ROOT / "worker" / "src" / "server" / "maintenance.ts"
    if not source.exists():
        pytest.skip("needs the repository's worker sources")
    text = source.read_text()
    assert f"export const EXIT_ROLLED_BACK = {entrypoint.EXIT_ROLLED_BACK};" in text
    assert f"/^{rp.RESTORE_POINT_ID.pattern}$/" in text
    assert '"SERVER_ENV_CFO_RESTORE_POINT"' in text and '"SERVER_ENV_CFO_ROLLBACK_TO"' in text
