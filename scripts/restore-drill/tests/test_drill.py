"""The restore drill, and acknowledged changes across a server replacement (RC-03, RC-06).

Real server image, real Litestream, an S3 stand-in and a faulty link. Each test has its own
replica prefix. The canary changes go through Omnigent's real HTTP routes.
"""

from __future__ import annotations

import pytest

from cfo_drill import canaries as canary_mod

from conftest import requires_docker
from harness_stack import Server, Stack, checks_by_name, manifest

pytestmark = requires_docker

#: One of each: password change, grant issued, grant revoked, admin invite, schedule created,
#: schedule edit, schedule delete, and the transcript items.
SECURITY_CANARIES = 7
ITEMS = 5


def _healthy(link: Stack, prefix: str, **extra: str) -> Server:
    server = link.server(prefix, initialized=False, **extra).start()
    server.wait_healthy()
    server.wait_replicated()
    return server


def _write(server: Server, password: str | None = None, **kw: object) -> canary_mod.CanaryRun:
    with canary_mod.Omnigent(server.url) as client:
        run = canary_mod.write_canaries(
            client,
            password or server.password,
            live=server.query,
            **kw,  # type: ignore[arg-type]
        )
    server.stack.extra_canaries += run.secrets.values()
    return run


def test_drill_passes_and_finds_every_acknowledged_change(link: Stack, prefix: str) -> None:
    server = _healthy(link, prefix)
    run = _write(server, items=ITEMS)
    assert all(a.acknowledged for a in run.acks), run.summary()
    assert sum(1 for c in run.canaries if c.acknowledged) == SECURITY_CANARIES + ITEMS

    code, report = server.drill("--canaries", "-", stdin=manifest(run))
    checks = checks_by_name(report)
    assert code == 0, report
    assert report["ok"] is True
    assert checks["integrity"]["detail"]["answer"] == "ok"
    assert checks["owner"]["ok"]
    assert checks["schema_version"]["ok"] and checks["tables"]["ok"]
    assert checks["row_counts"]["ok"], checks["row_counts"]
    security = checks["security_tables"]["detail"]
    assert security["users"]["rows"] >= 1 and security["device_grants"]["rows"] >= 2
    assert checks["transcript_items"]["detail"]["rows"] == ITEMS
    acknowledged = checks["acknowledged_changes"]["detail"]
    assert acknowledged["acknowledged"] == acknowledged["present"] == SECURITY_CANARIES + ITEMS
    assert report["restore"]["ok"] and report["confirmed"]["txid"] >= 1


def test_drill_fails_a_valid_restore_that_misses_acknowledged_changes(
    link: Stack, prefix: str
) -> None:
    """Litestream issue #1540's shape: integrity passes, rows are missing. The drill fails."""
    server = _healthy(link, prefix)
    before = server.litestream_position()
    assert before["replicated_txid"] >= before["txid"]
    run = _write(server, items=ITEMS)
    server.wait_replicated()

    code, report = server.drill(
        "--canaries", "-", "--txid", str(before["txid"]), stdin=manifest(run)
    )
    checks = checks_by_name(report)
    assert code == 1 and report["ok"] is False
    assert checks["integrity"]["ok"] and checks["owner"]["ok"]  # structurally valid
    missing = checks["acknowledged_changes"]["detail"]["missing"]
    # Every acknowledged row the canaries made or changed after `before` is missing or older;
    # the deleted schedule is (rightly) absent, and the password row predates the run.
    assert {
        "schedule_created",
        "schedule_edit",
        "grant_issued",
        "grant_revoked",
        "admin_invite",
    } <= set(missing)
    assert sum(1 for m in missing if m.startswith("item_")) == ITEMS


def test_acknowledged_changes_survive_server_replacement(link: Stack, prefix: str) -> None:
    """RC-03 on the real HTTP routes: SIGKILL right after the last acknowledgement."""
    server = _healthy(link, prefix)
    run = _write(server, items=ITEMS)
    assert all(a.acknowledged for a in run.acks), run.summary()
    nxt = server.replace(CFO_INSTALLATION_INITIALIZED="true")
    nxt.wait_healthy()
    assert any(e["source"] == "restored" for e in nxt.events("database.ready"))

    with canary_mod.Omnigent(nxt.url) as client:
        checks = {c.name: c for c in canary_mod.verify_http(client, run)}
    failed = {n: c.detail for n, c in checks.items() if not c.ok}
    assert not failed, failed
    assert set(checks) >= {
        "http.password_change",
        "http.grant_issued",
        "http.grant_revoked",
        "http.schedule_created",
        "http.schedule_edited",
        "http.schedule_deleted",
        "http.transcript_items",
        "http.sharing_managed",
    }
    assert checks["http.transcript_items"].detail["present"] == ITEMS

    # And the replaced server's own replica passes the drill, canaries included.
    nxt.wait_replicated()
    code, report = nxt.drill("--canaries", "-", stdin=manifest(run))
    assert code == 0, report


def test_unacknowledged_changes_may_be_lost_and_are_reported(link: Stack, prefix: str) -> None:
    """FM-05: R2 blocked after the commit, before the acknowledgement. The server answers
    424 or 503 ("applied, durability not confirmed"), nothing claims durability, and a kill
    loses exactly those changes; the acknowledged ones before the block survive."""
    server = _healthy(
        link, prefix, CFO_RESPONSE_BARRIER_TIMEOUT_S="2", CFO_TRANSCRIPT_BARRIER_TIMEOUT_S="1"
    )
    first = _write(server, items=2)
    assert all(a.acknowledged for a in first.acks)
    server.wait_replicated()
    link.blackhole()
    second = _write(server, first.secrets.password, items=2, change_password=False)
    statuses = {a.label: a.status for a in second.acks}
    assert not any(a.acknowledged for a in second.acks), second.summary()
    assert {s for label, s in statuses.items() if not label.startswith("item_")} == {424}
    assert {s for label, s in statuses.items() if label.startswith("item_")} == {503}

    link.unblock()
    nxt = server.replace(CFO_INSTALLATION_INITIALIZED="true")
    nxt.wait_healthy()
    with canary_mod.Omnigent(nxt.url) as client:
        kept = {c.name: c for c in canary_mod.verify_http(client, first)}
        lost = {c.name: c for c in canary_mod.verify_http(client, second)}
    assert all(c.ok for c in kept.values()), {n: c.detail for n, c in kept.items()}
    # The second run's changes were applied but never durable; the kill lost them, which is
    # what "applied, durability not yet confirmed" allows. Nothing failed because of it.
    assert all(c.ok for c in lost.values())
    assert lost["http.schedule_created"].detail["holds"] is False

    nxt.wait_replicated()
    code, report = nxt.drill("--canaries", "-", stdin=manifest(second))
    assert code == 0, report
    unacked = checks_by_name(report)["acknowledged_changes"]["detail"]["unacknowledged"]
    assert unacked and set(unacked.values()) == {"absent"}


@pytest.mark.parametrize("deadline", ["1"])
def test_drill_reports_a_restore_that_misses_its_deadline(
    link: Stack, prefix: str, deadline: str
) -> None:
    server = _healthy(link, prefix)
    link.blackhole()
    try:
        code, report = server.drill("--txid", "1", "--deadline", deadline)
    finally:
        link.unblock()
    assert code == 1
    assert report["restore"]["timed_out"] is True
    assert checks_by_name(report)["restore"]["ok"] is False
