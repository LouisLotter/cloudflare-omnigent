"""The image records what it was built from and reports it (AIR2-007 at artifact scope)."""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

from cfo_server import buildinfo

from conftest import IMAGE_DIR

COMMIT = "212fc5886522931b0e96ffc4f5edc1d5145dd2fa"


def _write(path: Path, **fields: object) -> Path:
    record = {"omnigentRepo": "https://example.test/fork.git", "omnigentCommit": COMMIT}
    record["litestream"] = "0.5.17"
    record.update(fields)
    path.write_text(json.dumps(record))
    return path


def test_a_well_formed_record_is_read(tmp_path: Path) -> None:
    info = buildinfo.load(_write(tmp_path / "build.json"))
    assert info == {
        "omnigentRepo": "https://example.test/fork.git",
        "omnigentCommit": COMMIT,
        "litestream": "0.5.17",
    }


@pytest.mark.parametrize(
    "fields",
    [
        {"omnigentCommit": "cfo/integration"},  # a branch, not a commit
        {"omnigentCommit": COMMIT[:12]},  # abbreviated
        {"omnigentCommit": COMMIT.upper()},
        {"litestream": None},
    ],
)
def test_a_record_that_does_not_name_a_full_commit_is_refused(
    tmp_path: Path, fields: dict[str, object]
) -> None:
    assert buildinfo.load(_write(tmp_path / "build.json", **fields)) is None


def test_no_record_or_a_broken_one_is_none(tmp_path: Path) -> None:
    assert buildinfo.load(tmp_path / "missing.json") is None
    (tmp_path / "broken.json").write_text("{not json")
    assert buildinfo.load(tmp_path / "broken.json") is None
    (tmp_path / "list.json").write_text("[]")
    assert buildinfo.load(tmp_path / "list.json") is None


def _dockerfile_commit() -> str:
    dockerfile = IMAGE_DIR / "Dockerfile"
    if not dockerfile.exists():  # inside the image: the test stage copies it here
        dockerfile = Path("/opt/cfo/Dockerfile")
    match = re.search(r"^ARG OMNIGENT_COMMIT=([0-9a-f]{40})$", dockerfile.read_text(), re.M)
    assert match, "the Dockerfile pins the fork by a full commit ID"
    return match.group(1)


def test_the_dockerfile_pins_the_fork_commit_with_the_stop_fix() -> None:
    # cfo/upgrade-0.20.0 212fc5886 (WP3.40): Omnigent 0.20.0 merged into the fork at 3d7f7d08c
    # (WP3.24), then fork integration afb809aa6 (WP5.11's F1) and WP3.40c's crash-safe database
    # upgrade merged in. It keeps the Stop fix
    # (AIR2-007), core changes 12 to 21, WP3.16's notices, AIR2-008's resume refusal, WP3.8b's
    # provision by the whole host ID, WP3.24's Codex policy hook failing closed and Claude's
    # renderer pin. A later fork merge bumps it; this test then names the new commit.
    assert _dockerfile_commit() == COMMIT


@pytest.mark.skipif(not buildinfo.BUILD_INFO_PATH.exists(), reason="runs inside the server image")
def test_the_built_image_records_the_commit_it_was_built_from() -> None:
    info = buildinfo.load()
    assert info is not None
    assert info["omnigentCommit"] == _dockerfile_commit()
    assert info["omnigentRepo"] == "https://github.com/LouisLotter/omnigent.git"
    assert info["litestream"] == "0.5.17"
