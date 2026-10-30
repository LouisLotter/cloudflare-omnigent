"""The update's restore point and its rollback in the built image (WP3.41), against an S3
stand-in: real Litestream, real Omnigent, the restore point copied server-side in the replica's
bucket, and a rollback that gives back exactly the database from before the update.

Each test has its own replica path (``<prefix>/omnigent``), so its restore points live in
``<prefix>/cfo-restore-points/``. Writes are Omnigent's own (scheduled tasks), acknowledged only
once durable, as every write is.
"""

from __future__ import annotations

import json

from conftest import BUCKET, Server, Stack
from test_image import _schedule, _schedule_names

RP = "rp-20261030T120000Z-0a1b2c3d"


def _write(server: Server, name: str) -> None:
    with server.client() as c:
        response = _schedule(c, server.bearer(), name)
    assert response.status_code in (200, 201), response.text


def _listing(stack: Stack, prefix: str) -> dict[str, int]:
    """Every object under ``prefix/``, by its key below it, with its size."""
    found: dict[str, int] = {}
    token = None
    while True:
        args = {"Bucket": BUCKET, "Prefix": prefix.rstrip("/") + "/"}
        if token:
            args["ContinuationToken"] = token
        page = stack.s3().list_objects_v2(**args)
        for o in page.get("Contents", []):
            found[o["Key"][len(prefix.rstrip("/")) + 1 :]] = o["Size"]
        if not page.get("IsTruncated"):
            return found
        token = page["NextContinuationToken"]


def _stop(server: Server) -> None:
    """A graceful stop, as the watchdog's: SIGTERM, and a confirmed final sync."""
    server.kill("TERM")
    assert server.wait_exit() == 0, server.logs()[-2000:]
    server.remove()


def test_an_update_takes_its_restore_point_and_a_rollback_gives_back_the_database(
    link: Stack, prefix: str
) -> None:
    replica = f"{prefix}/omnigent"
    points = f"{prefix}/cfo-restore-points"
    # The previous release: the owner, and a write before the update.
    previous = link.server(replica, initialized=False).start()
    previous.wait_healthy()
    _write(previous, "before the update")
    previous.wait_replicated()
    _stop(previous)
    before = _listing(link, replica)
    assert before

    # The update's server: the restore point before Omnigent starts, then its own writes.
    update = link.server(replica, initialized=True, CFO_RESTORE_POINT=RP).start()
    update.wait_healthy()
    status = update.status()
    assert status["restorePoint"]["id"] == RP
    assert status["restorePoint"]["objects"] == len(before)
    taken = update.events("restore_point.taken")
    started = [e["event"] for e in map(json.loads, _json_lines(update)) if "event" in e]
    assert started.index("cfo.restore_point.taken") < started.index("cfo.started")
    assert taken and taken[0]["objects"] == len(before)
    assert _listing(link, f"{points}/{RP}/replica") == before
    manifest = json.loads(
        link.s3().get_object(Bucket=BUCKET, Key=f"{points}/{RP}/manifest.json")["Body"].read()
    )
    assert manifest["id"] == RP and len(manifest["database"]["sha256"]) == 64
    assert {o["key"]: o["size"] for o in manifest["objects"]} == before
    _write(update, "inside the window")
    update.wait_replicated()
    assert sorted(_schedule_names(update)) == ["before the update", "inside the window"]
    _stop(update)
    assert _listing(link, replica) != before

    # The rollback: checked, put back, exit 79; nothing else starts.
    rollback = link.server(
        replica, initialized=True, CFO_RESTORE_POINT=RP, CFO_ROLLBACK_TO=RP
    ).start()
    assert rollback.wait_exit() == 79, rollback.logs()[-3000:]
    done = rollback.events("rollback.done")
    assert done and done[0]["restored"] is True
    assert not rollback.events("started")
    rollback.remove()
    assert _listing(link, replica) == before
    marker = json.loads(
        link.s3().get_object(Bucket=BUCKET, Key=f"{points}/{RP}/rolled-back.json")["Body"].read()
    )
    assert marker["restored"] is True

    # The previous release again: exactly the data from before the update.
    back = link.server(replica, initialized=True).start()
    back.wait_healthy()
    assert _schedule_names(back) == ["before the update"]
    _write(back, "after the rollback")
    back.wait_replicated()
    _stop(back)

    # A lingering order never puts the restore point back again.
    again = link.server(
        replica, initialized=True, CFO_RESTORE_POINT=RP, CFO_ROLLBACK_TO=RP
    ).start()
    assert again.wait_exit() == 79
    assert again.events("rollback.done")[0]["already"] is True
    again.remove()
    last = link.server(replica, initialized=True).start()
    last.wait_healthy()
    assert sorted(_schedule_names(last)) == ["after the rollback", "before the update"]
    _stop(last)


def _json_lines(server: Server) -> list[str]:
    return [line for line in server.logs().splitlines() if line.startswith('{"')]
