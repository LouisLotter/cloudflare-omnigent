"""The transcript barrier (core change 14) as the image installs it, on Omnigent's routes.

Omnigent acknowledges a transcript item or a turn-end status edge only once the barrier says
it is durable. With the replica blocked the sender gets 503 ``durability_unconfirmed`` and
sends the same outcome again, which lands exactly once. The image tests repeat this with real
Litestream across a server kill.
"""

from __future__ import annotations

import asyncio
import time

from conftest import AppHarness, requires_omnigent

pytestmark = requires_omnigent


def _session(h: AppHarness, bearer: dict[str, str]) -> str:
    agents = h.client.get("/v1/agents", headers=bearer).json()
    items = agents.get("data") or agents.get("agents") or agents
    created = h.client.post("/v1/sessions", json={"agent_id": items[0]["id"]}, headers=bearer)
    assert created.status_code in (200, 201), created.text
    return created.json()["id"]


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


def _texts(h: AppHarness, session_id: str, bearer: dict[str, str]) -> list[str]:
    response = h.client.get(f"/v1/sessions/{session_id}/items", headers=bearer)
    assert response.status_code == 200, response.text
    return [
        block.get("text", "")
        for item in response.json()["data"]
        for block in item.get("content", [])
        if isinstance(block, dict)
    ]


def test_item_is_acknowledged_once_durable(app_harness: AppHarness) -> None:
    h = app_harness
    h.fake.mode = "healthy"
    bearer = h.bearer()
    session_id = _session(h, bearer)
    response = h.client.post(
        f"/v1/sessions/{session_id}/events", json=_item("ok-1"), headers=bearer
    )
    assert 200 <= response.status_code < 300, response.text
    assert "x-cfo-durability" not in response.headers  # not a security write
    assert _texts(h, session_id, bearer).count("item ok-1") == 1


def test_item_answers_503_while_blocked_and_the_resend_lands_once(app_harness: AppHarness) -> None:
    h = app_harness
    h.fake.mode = "healthy"
    bearer = h.bearer()
    session_id = _session(h, bearer)
    h.fake.mode = "blocked"
    started = time.monotonic()
    response = h.client.post(
        f"/v1/sessions/{session_id}/events", json=_item("blocked-1"), headers=bearer
    )
    elapsed = time.monotonic() - started
    assert response.status_code == 503, response.text
    assert response.json()["error"]["code"] == "durability_unconfirmed"
    # One deadline over the whole wait (1.0 s in this harness), below the senders' 5 s.
    assert elapsed < 3.0
    h.fake.mode = "healthy"
    again = h.client.post(
        f"/v1/sessions/{session_id}/events", json=_item("blocked-1"), headers=bearer
    )
    assert 200 <= again.status_code < 300, again.text
    assert _texts(h, session_id, bearer).count("item blocked-1") == 1


def test_turn_end_failure_edge_is_held_until_durable(app_harness: AppHarness) -> None:
    h = app_harness
    h.fake.mode = "healthy"
    bearer = h.bearer()
    session_id = _session(h, bearer)
    edge = {"type": "external_session_status", "data": {"status": "failed", "output": "synthetic"}}
    headers = {**bearer, "Idempotency-Key": "synthetic-edge-1"}
    h.fake.mode = "blocked"
    response = h.client.post(f"/v1/sessions/{session_id}/events", json=edge, headers=headers)
    assert response.status_code == 503, response.text
    h.fake.mode = "healthy"
    again = h.client.post(f"/v1/sessions/{session_id}/events", json=edge, headers=headers)
    assert 200 <= again.status_code < 300, again.text


def test_the_installed_barrier_never_raises_and_answers_within_its_deadline(
    app_harness: AppHarness,
) -> None:
    from omnigent.server.durability import commits_durable, durability_barrier

    barrier = durability_barrier(app_harness.app)
    app_harness.fake.mode = "error"
    try:
        started = time.monotonic()
        assert asyncio.run(commits_durable(barrier)) is False
        assert time.monotonic() - started < 2.5
    finally:
        app_harness.fake.mode = "healthy"
