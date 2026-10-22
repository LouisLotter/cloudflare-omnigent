"""Image tests: the built server image, real Litestream, an S3 stand-in and a faulty link.

Fault injection follows spike S4: SIGKILL through Docker, "blackhole" with a Toxiproxy
``timeout`` toxic (connections open, no data flows). Each test uses its own replica prefix.
"""

from __future__ import annotations

import json
import time
import uuid
from pathlib import Path

import httpx
import pytest

from conftest import OWNER, Server, Stack
from sharing_variants import REACHED_THE_HANDLER, send, variants

EDITABLE_KEYS = (
    "editable",
    "public_sharing_editable",
    "public_sharing_max_level_editable",
    "default_public_sessions_editable",
)


def _agent_id(c: httpx.Client, bearer: dict[str, str]) -> str:
    body = c.get("/v1/agents", headers=bearer).json()
    return (body.get("data") or body.get("agents") or body)[0]["id"]


def _schedule(c: httpx.Client, bearer: dict[str, str], name: str) -> httpx.Response:
    return c.post(
        "/v1/scheduled-tasks",
        headers=bearer,
        json={
            "name": name,
            "prompt": "synthetic task",
            "rrule": "FREQ=DAILY;BYHOUR=3",
            "agent_id": _agent_id(c, bearer),
            "timezone": "UTC",
        },
    )


def _schedule_names(server: Server) -> list[str]:
    with server.client() as c:
        body = c.get("/v1/scheduled-tasks", headers=server.bearer()).json()
    return [t["name"] for t in (body.get("data") or body.get("scheduled_tasks") or [])]


def _item(source_id: str) -> dict:
    return {
        "type": "external_conversation_item",
        "data": {
            "item_type": "message",
            "response_id": "resp_synthetic",
            "source_id": source_id,
            "item_data": {
                "role": "assistant",
                "agent": "codex-native-ui",
                "content": [{"type": "output_text", "text": f"item {source_id}"}],
            },
        },
    }


def _item_texts(server: Server, session_id: str) -> list[str]:
    with server.client() as c:
        body = c.get(f"/v1/sessions/{session_id}/items", headers=server.bearer()).json()
    return [
        block.get("text", "")
        for item in body["data"]
        for block in item.get("content", [])
        if isinstance(block, dict)
    ]


REPO_ROOT = Path(__file__).resolve().parents[4]


def _validate(payload: object, schema: str) -> None:
    from jsonschema import Draft202012Validator

    spec = json.loads((REPO_ROOT / "contracts/schema" / f"{schema}.schema.json").read_text())
    errors = [e.message for e in Draft202012Validator(spec).iter_errors(payload)]
    assert not errors, (payload, errors)


# ── Entrypoint order, the replicated position, and the owner across a replacement ─────


def test_entrypoint_order_and_owner_durable_across_replacement(link: Stack, prefix: str) -> None:
    server = link.server(prefix, initialized=False).start()
    server.wait_healthy()
    order = [
        e["event"]
        for line in server.logs().splitlines()
        if line.startswith('{"')
        and (e := json.loads(line))["event"]
        in ("cfo.restore", "cfo.database.ready", "cfo.started", "cfo.app.built")
    ]
    assert order == ["cfo.restore", "cfo.database.ready", "cfo.started", "cfo.app.built"]
    # BootstrapStatus, as WP2.2's watchdog reads it: /v1/info first, then a position whose
    # replicatedTxid of the same boot reaches a txid read after it.
    info = httpx.get(f"{server.url}/v1/info", timeout=10).json()
    assert info["accounts_enabled"] is True and info["needs_setup"] is False
    replicated = server.wait_replicated()
    for payload in (replicated["target"], replicated["reached"]):
        _validate(payload, "ReplicationPosition")
    assert replicated["target"]["txid"] >= 1
    nxt = server.replace(CFO_INSTALLATION_INITIALIZED="true")
    nxt.wait_healthy()
    assert any(e["source"] == "restored" for e in nxt.events("database.ready"))
    assert nxt.login()["token"]
    after = nxt.position().json()
    _validate(after, "ReplicationPosition")
    assert after["bootId"] != replicated["target"]["bootId"]  # a new boot after a restore


# ── The response barrier under fault injection ────────────────────────────────────────


def test_acknowledged_security_changes_survive_sigkill(link: Stack, prefix: str) -> None:
    server = link.server(prefix, initialized=False).start()
    server.wait_healthy()
    server.wait_replicated()
    bearer = server.bearer()
    with server.client() as c:
        created = _schedule(c, bearer, "acked-before-kill")
    assert created.status_code in (200, 201) and created.headers["x-cfo-durability"] == "confirmed"
    nxt = server.replace(CFO_INSTALLATION_INITIALIZED="true")  # SIGKILL right after the ack
    nxt.wait_healthy()
    assert "acked-before-kill" in _schedule_names(nxt)


def test_blackholed_replica_answers_424_and_keeps_serving(link: Stack, prefix: str) -> None:
    server = link.server(prefix, initialized=False).start()
    server.wait_healthy()
    server.wait_replicated()
    bearer = server.bearer()
    link.blackhole()
    with server.client() as c:
        started = time.monotonic()
        held = _schedule(c, bearer, "blocked-create")
        elapsed = time.monotonic() - started
        health = c.get("/health")
        browser_login = c.post(
            "/auth/login",
            json={
                "username": OWNER,
                "password": server.env["OMNIGENT_ACCOUNTS_INIT_ADMIN_PASSWORD"],
            },
        )
    assert held.status_code == 424
    assert held.json() == {
        "error": {
            "code": "durability_unconfirmed",
            "message": "The change was applied, but its durability is not yet confirmed. "
            "Check the current state before repeating it.",
        },
        "applied": True,
    }
    assert 4.5 < elapsed < 15
    assert health.status_code == 200
    assert browser_login.status_code == 200  # last_login_at is not held
    assert "blocked-create" in _schedule_names(server)  # applied
    barrier_lines = server.events("barrier.response")
    assert barrier_lines and barrier_lines[-1]["ok"] is False


# ── The transcript barrier (core change 14) with real Litestream ──────────────────────


def test_transcript_item_with_r2_blackholed_answers_503_is_resent_and_never_lost(
    link: Stack, prefix: str
) -> None:
    server = link.server(prefix, initialized=False).start()
    server.wait_healthy()
    bearer = server.bearer()
    with server.client() as c:
        session_id = c.post(
            "/v1/sessions", json={"agent_id": _agent_id(c, bearer)}, headers=bearer
        ).json()["id"]
    server.wait_replicated()
    link.blackhole()
    with server.client() as c:
        started = time.monotonic()
        refused = c.post(f"/v1/sessions/{session_id}/events", json=_item("bh-1"), headers=bearer)
        elapsed = time.monotonic() - started
    assert refused.status_code == 503, refused.text
    assert refused.json()["error"]["code"] == "durability_unconfirmed"
    assert elapsed < 5  # one deadline (3 s here), below the forwarder's 5 s
    link.unblock()
    nxt = server.replace(CFO_INSTALLATION_INITIALIZED="true")
    nxt.wait_healthy()
    assert "item bh-1" not in _item_texts(nxt, session_id)  # it was never acknowledged
    with nxt.client() as c:  # the forwarder still holds the outcome and sends it again
        resent = c.post(
            f"/v1/sessions/{session_id}/events", json=_item("bh-1"), headers=nxt.bearer()
        )
    assert 200 <= resent.status_code < 300, resent.text
    assert _item_texts(nxt, session_id).count("item bh-1") == 1


def test_acknowledged_transcript_item_survives_sigkill(link: Stack, prefix: str) -> None:
    server = link.server(prefix, initialized=False).start()
    server.wait_healthy()
    bearer = server.bearer()
    with server.client() as c:
        session_id = c.post(
            "/v1/sessions", json={"agent_id": _agent_id(c, bearer)}, headers=bearer
        ).json()["id"]
        server.wait_replicated()
        acked = c.post(f"/v1/sessions/{session_id}/events", json=_item("ok-1"), headers=bearer)
    assert 200 <= acked.status_code < 300, acked.text
    nxt = server.replace(CFO_INSTALLATION_INITIALIZED="true")
    nxt.wait_healthy()
    assert _item_texts(nxt, session_id).count("item ok-1") == 1


# ── Recovery mode and the restore deadline ────────────────────────────────────────────


def test_initialized_installation_with_an_empty_replica_enters_recovery_mode(
    link: Stack, prefix: str
) -> None:
    server = link.server(prefix, initialized=True).start()
    status = server.wait_phase("recovery")
    assert status["recovery"]["reason"] == "replica_empty"
    position = server.position()
    assert position.status_code == 503  # Litestream never ran
    _validate(position.json(), "ErrorBody")
    for path in ("/", "/auth/setup", "/v1/info"):
        response = httpx.get(f"{server.url}{path}", timeout=10)
        assert response.status_code == 503
        assert response.json()["error"]["code"] == "recovery_mode"
    setup = httpx.post(
        f"{server.url}/auth/setup", json={"username": "intruder", "password": "x" * 16}, timeout=10
    )
    assert setup.status_code == 503
    assert link.objects(prefix) == []  # nothing replicated: no new installation started


def test_restore_deadline_with_a_blackholed_link(link: Stack, prefix: str) -> None:
    seed = link.server(prefix, initialized=False).start()
    seed.wait_healthy()
    seed.wait_replicated()
    seed.kill("KILL")
    seed.remove()
    link.blackhole()
    server = link.server(prefix, initialized=True, CFO_RESTORE_DEADLINE_S="8").start()
    started = time.monotonic()
    status = server.wait_phase("recovery", timeout=60)
    assert status["recovery"]["reason"] == "restore_deadline"
    assert status["recovery"]["transient"] is True
    assert time.monotonic() - started < 40
    assert httpx.get(f"{server.url}/v1/info", timeout=10).status_code == 503


# ── Final sync ────────────────────────────────────────────────────────────────────────


def test_clean_stop_confirms_the_final_sync(link: Stack, prefix: str) -> None:
    server = link.server(prefix, initialized=False).start()
    server.wait_healthy()
    bearer = server.bearer()
    with server.client() as c:
        _schedule(c, bearer, "before-sigterm")
    server.kill("TERM")
    assert server.wait_exit() == 0
    final = server.events("final_sync")[-1]
    assert final["confirmed"] is True and final["why"] == "signal"


def test_failed_final_sync_is_reported(link: Stack, prefix: str) -> None:
    server = link.server(prefix, initialized=False, CFO_FINAL_SYNC_TIMEOUT_S="5").start()
    server.wait_healthy()
    server.wait_replicated()
    link.blackhole()
    with server.client() as c:  # a write that cannot reach the replica
        c.post(
            "/auth/login",
            json={
                "username": OWNER,
                "password": server.env["OMNIGENT_ACCOUNTS_INIT_ADMIN_PASSWORD"],
                "issue_refresh": True,
            },
        )
    server.kill("TERM")
    assert server.wait_exit() == 75  # Litestream itself would have exited 0
    final = server.events("final_sync")[-1]
    assert final["confirmed"] is False


# ── Authoritative sharing settings, with no Worker in front ───────────────────────────


def test_sharing_settings_refuse_s7_variants_straight_to_the_server(
    link: Stack, prefix: str
) -> None:
    server = link.server(prefix, initialized=False).start()
    server.wait_healthy()
    token = server.login()["token"]
    results = {}
    for variant in variants(server.app_port):
        response = send(server.app_port, variant, token)
        results[variant.id] = response.status
        if variant.id in REACHED_THE_HANDLER:
            assert response.status == 403, (variant.id, response.status, response.body[:200])
        elif not variant.read:
            assert not 200 <= response.status < 300, (variant.id, response.status)
        is_json = response.headers.get("content-type", "").startswith("application/json")
        if (
            variant.read
            and response.status == 200
            and variant.id != "G06"
            and is_json
            and response.body
        ):
            body = json.loads(response.body)
            assert not any(body.get(k) for k in EDITABLE_KEYS), (variant.id, body)
    # Nothing changed, and no override file exists.
    with server.client() as c:
        state = c.get("/v1/sharing", headers={"Authorization": f"Bearer {token}"}).json()
    assert state["sharing_mode"] == "off"
    assert state["public_sharing_enabled"] is False
    assert state["public_sharing_max_level"] == "read"
    assert state["default_public_sessions"] == "off"
    assert not any(state[k] for k in EDITABLE_KEYS)
    listing = server.exec("ls", "-A", "/data/omnigent").stdout.split()
    for name in (
        "sharing_mode",
        "public_sharing",
        "public_sharing_max_level",
        "default_public_sessions",
    ):
        assert name not in listing
    assert len(results) == 87
    print(json.dumps(results, sort_keys=True))


# ── Pinned settings in the running image ──────────────────────────────────────────────


def test_running_image_pins_features_and_wires_no_extra_integrations(
    link: Stack, prefix: str
) -> None:
    server = link.server(
        prefix,
        initialized=False,
        OMNIGENT_FEATURES="harness_install",
        OMNIGENT_DATABRICKS_CLIENT_ID="synthetic",
        OMNIGENT_CREDENTIAL_CIPHER="kms",
    ).start()
    server.wait_healthy()
    info = httpx.get(f"{server.url}/v1/info", timeout=10).json()
    assert not any(info["features"].values())
    assert info["sharing_mode"] == "off" and info["public_sharing_enabled"] is False
    environ = server.exec("sh", "-c", "cat /proc/$(pgrep -f cfo_server.app | head -1)/environ")
    names = {item.split("=", 1)[0] for item in environ.stdout.split("\0") if item}
    assert "OMNIGENT_DATABRICKS_CLIENT_ID" not in names
    assert "OMNIGENT_CREDENTIAL_CIPHER" not in names
    assert "LITESTREAM_SECRET_ACCESS_KEY" not in names
    warnings = [e["message"] for e in server.events("config.warning")]
    assert any("OMNIGENT_FEATURES" in w for w in warnings)


@pytest.mark.parametrize("variable", ["OMNIGENT_SHARING_MODE", "OMNIGENT_DEFAULT_PUBLIC_SESSIONS"])
def test_malformed_setting_stops_the_container_with_78(
    link: Stack, prefix: str, variable: str
) -> None:
    server = link.server(prefix, initialized=False, **{variable: "everyone"}).start()
    assert server.wait_exit(60) == 78
    assert variable in server.events("config.error")[-1]["message"]


def test_request_logs_never_carry_query_strings(link: Stack, prefix: str) -> None:
    """Magic-link tokens travel in the query string; the teardown's canary scan checks every
    server log for the issued token and for a canary built here."""
    server = link.server(prefix, initialized=False).start()
    server.wait_healthy()
    with server.client() as c:
        minted = c.post("/auth/magic", headers=server.bearer())
        token = minted.json()["redeem_url"].split("t=", 1)[1]
        link.extra_canaries.append(token)
        canary = "CFO_CANARY_" + uuid.uuid4().hex  # built at run time, never in source
        c.get("/auth/magic/redeem", params={"t": canary}, follow_redirects=False)
        redeemed = c.get("/auth/magic/redeem", params={"t": token}, follow_redirects=False)
    assert redeemed.status_code == 302
    logs = server.logs()
    assert "/auth/magic/redeem" in logs  # the access line is there, without its query
    assert token not in logs and canary not in logs


def test_new_installation_without_bootstrap_credentials_never_offers_setup(
    link: Stack, prefix: str
) -> None:
    server = link.server(prefix, initialized=False)
    server.env.pop("OMNIGENT_ACCOUNTS_INIT_ADMIN_USERNAME")
    server.env.pop("OMNIGENT_ACCOUNTS_INIT_ADMIN_PASSWORD")
    server.start()
    status = server.wait_phase("recovery")
    assert status["recovery"]["reason"] == "owner_missing"
    assert httpx.get(f"{server.url}/v1/info", timeout=10).status_code == 503
    assert link.objects(prefix) == []
