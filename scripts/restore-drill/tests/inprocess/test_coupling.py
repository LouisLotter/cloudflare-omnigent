"""The drill's coupling to the image and to Omnigent's schema, checked inside the image.

The drill compares the response barrier's tables row by row, by primary key, and finds
transcript items by conversation; the fence stub implements Omnigent's launcher interface; the
drill's paths are the entrypoint's. A fork bump or an image change that moves any of these
fails here instead of weakening the drill silently.
"""

from __future__ import annotations

import inspect
import sqlite3
from pathlib import Path

import pytest


@pytest.fixture(scope="module")
def schema(tmp_path_factory: pytest.TempPathFactory) -> dict[str, list[str]]:
    from cfo_server.app import load_docker_entrypoint

    path = tmp_path_factory.mktemp("schema") / "omnigent.db"
    load_docker_entrypoint().run_migrations(f"sqlite:///{path}")
    conn = sqlite3.connect(path)
    try:
        tables = [n for (n,) in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")]
        return {
            t: [
                row[1]
                for row in sorted(conn.execute(f'PRAGMA table_info("{t}")'), key=lambda r: r[5])
                if row[5]
            ]
            for t in tables
        }
    finally:
        conn.close()


def test_security_tables_are_the_barriers_and_keyed_by_their_primary_keys(schema) -> None:  # noqa: ANN001
    from cfo_drill import db
    from cfo_server.barrier import SECURITY_TABLES

    assert set(db.SECURITY_TABLE_KEYS) == set(SECURITY_TABLES)
    for table, key in db.SECURITY_TABLE_KEYS.items():
        assert tuple(schema[table]) == key, (table, schema[table])


def test_transcript_items_are_found_by_conversation_and_id(schema) -> None:  # noqa: ANN001
    from cfo_drill import db

    assert set(db.ITEM_KEY) <= set(schema[db.ITEMS_TABLE])
    assert db.ITEM_KEY[1] == "conversation_id"


def test_the_filler_table_is_not_omnigents(schema) -> None:  # noqa: ANN001
    from cfo_drill import filler

    assert filler.TABLE not in schema


def test_the_drill_uses_the_entrypoints_paths() -> None:
    from cfo_drill import drill
    from cfo_server import config

    assert drill.DB_PATH == config.DB_PATH
    assert drill.LITESTREAM_CONFIG == config.LITESTREAM_CONFIG
    assert drill.LITESTREAM_SOCKET == config.LITESTREAM_SOCKET
    assert drill.LITESTREAM_BIN == config.LITESTREAM_BIN
    assert Path(drill.LITESTREAM_BIN).exists()


def test_the_stub_launcher_implements_omnigents_launcher_interface() -> None:
    from omnigent.onboarding.sandboxes.base import SandboxHostLauncher

    from cfo_drill.fence import FENCED, RecordingStubLauncher

    for name in (*FENCED, "provision", "resume", "is_running", "keep_alive", "prepare"):
        ours = inspect.signature(getattr(RecordingStubLauncher, name))
        theirs = inspect.signature(getattr(SandboxHostLauncher, name))
        assert list(ours.parameters) == list(theirs.parameters), name
    assert not inspect.isabstract(RecordingStubLauncher)
