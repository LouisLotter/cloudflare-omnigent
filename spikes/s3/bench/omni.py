"""Drive Omnigent conversations on the S3 host, the way its own e2e tests do.

Agent: openai-agents harness pointed at Omnigent's mock LLM, so no real
account is involved. Flow (tests/e2e/test_host_zygote_cwd_e2e.py):
register agent -> POST /v1/sessions -> POST /v1/hosts/{id}/runners ->
wait runner online -> PATCH session runner -> POST events -> poll status.
"""

from __future__ import annotations

import gzip
import io
import json
import tarfile
import time
import uuid
from typing import Any

from common import MOCK, SRV, http

HOST_ID = "6d2f6c1e-3b1a-4c55-9a51-5f3e0a000001"
MODEL = "mock-s3"
ORIGIN = {"Origin": "omnigent://internal"}


def register_agent(name: str = "s3-agent", model: str = MODEL, delay_s: float = 0.0) -> str:
    """Register an inline agent; returns its agent_id."""
    http("POST", MOCK + "/mock/set_fallback", {"key": model, "text": "ok from mock"})
    if delay_s:
        http("POST", MOCK + "/mock/configure", {"key": model, "responses": [{"text": "slow ok", "delay": delay_s}] * 50})
    cfg = {
        "name": name,
        "prompt": "You are a minimal test assistant. Answer briefly.",
        "executor": {
            "harness": "openai-agents",
            "model": model,
            "profile": "",
            "auth": {"type": "api_key", "api_key": "mock-key", "base_url": "http://mockllm:9999/v1"},
        },
        "os_env": {"type": "caller_process", "cwd": ".", "sandbox": {"type": "none", "allow_network": True}},
    }
    raw = io.BytesIO()
    with tarfile.open(fileobj=raw, mode="w") as tar:
        data = json.dumps(cfg).encode()
        info = tarfile.TarInfo(f"{name}.yaml")
        info.size = len(data)
        tar.addfile(info, io.BytesIO(data))
    bundle = gzip.compress(raw.getvalue())
    boundary = uuid.uuid4().hex
    body = (
        f"--{boundary}\r\nContent-Disposition: form-data; name=\"metadata\"\r\n\r\n{{}}\r\n"
        f"--{boundary}\r\nContent-Disposition: form-data; name=\"bundle\"; filename=\"agent.tar.gz\"\r\n"
        f"Content-Type: application/gzip\r\n\r\n"
    ).encode() + bundle + f"\r\n--{boundary}--\r\n".encode()
    import urllib.request

    req = urllib.request.Request(SRV + "/v1/sessions", data=body, method="POST")
    req.add_header("Content-Type", f"multipart/form-data; boundary={boundary}")
    req.add_header("Origin", "omnigent://internal")
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            r.read()
    except urllib.error.HTTPError as exc:  # type: ignore[attr-defined]
        if exc.code != 409:
            raise RuntimeError(f"register failed {exc.code}: {exc.read()[:400]!r}") from exc
    code, rows = http("GET", SRV + f"/v1/sessions?visibility=all&agent_name={name}&limit=1")
    return str(rows["data"][0]["agent_id"])


def new_session(agent_id: str, workspace: str = "/home/agent/work") -> dict[str, Any]:
    t0 = time.monotonic()
    code, s = http("POST", SRV + "/v1/sessions", {"agent_id": agent_id})
    assert code in (200, 201), (code, s)
    sid = s["id"]
    code, launch = http("POST", SRV + f"/v1/hosts/{HOST_ID}/runners", {"session_id": sid, "workspace": workspace}, timeout=120)
    assert code == 200, (code, launch)
    rid = launch["runner_id"]
    deadline = time.monotonic() + 90
    while time.monotonic() < deadline:
        code, st = http("GET", SRV + f"/v1/runners/{rid}/status", timeout=10)
        if code == 200 and st.get("online") is True:
            break
        time.sleep(0.3)
    else:
        raise TimeoutError(f"runner {rid} never online")
    code, _ = http("PATCH", SRV + f"/v1/sessions/{sid}", {"runner_id": rid})
    assert code == 200, code
    return {"session_id": sid, "runner_id": rid, "launch_s": round(time.monotonic() - t0, 2)}


def send(sid: str, text: str) -> int:
    """Post a user message. A 503 runner_unavailable (the runner was exiting on
    its idle timeout) is retried after a pause, as a client would. Returns the
    number of attempts."""
    for attempt in range(1, 6):
        code, out = http("POST", SRV + f"/v1/sessions/{sid}/events", {
            "type": "message",
            "data": {"role": "user", "content": [{"type": "input_text", "text": text}]},
        })
        if code in (200, 201, 202):
            return attempt
        if code == 503 and attempt < 5:
            time.sleep(3)
            continue
        raise AssertionError((code, out))
    return 5


def snapshot(sid: str) -> dict[str, Any]:
    code, body = http("GET", SRV + f"/v1/sessions/{sid}", timeout=10)
    return body if code == 200 else {"status": f"http-{code}"}


def assistant_texts(body: dict[str, Any]) -> list[str]:
    out = []
    for item in body.get("items", []):
        data = item.get("data") or {}
        if item.get("type") == "message" and data.get("role") == "assistant":
            for block in data.get("content", []):
                if block.get("text"):
                    out.append(block["text"])
    return out


def _assistant_ids(body: dict[str, Any]) -> dict[str, str]:
    out = {}
    for item in body.get("items", []):
        data = item.get("data") or {}
        if item.get("type") == "message" and data.get("role") == "assistant":
            out[item.get("id")] = "".join(b.get("text", "") for b in data.get("content", []))
    return out


def turn(sid: str, text: str, timeout: float = 120) -> dict[str, Any]:
    """Send one message and wait for a new assistant reply.

    The session snapshot holds only the latest 100 items, so a new reply is
    detected by item id, not by counting.
    """
    before = set(_assistant_ids(snapshot(sid)))
    t0 = time.monotonic()
    try:
        attempts = send(sid, text)
    except AssertionError as exc:
        return {"ok": False, "s": round(time.monotonic() - t0, 2), "status": "send_failed", "error": str(exc)[:300]}
    deadline = t0 + timeout
    body: dict[str, Any] = {}
    while time.monotonic() < deadline:
        body = snapshot(sid)
        new = {k: v for k, v in _assistant_ids(body).items() if k not in before}
        if new and body.get("status") in ("idle", "completed", "waiting"):
            return {"ok": True, "s": round(time.monotonic() - t0, 2), "status": body.get("status"),
                    "reply": list(new.values())[-1][:80], "send_attempts": attempts}
        if body.get("status") == "failed":
            break
        time.sleep(0.25)
    return {"ok": False, "s": round(time.monotonic() - t0, 2), "status": body.get("status"), "error": str(body.get("error"))[:300]}


def host_status() -> str:
    code, out = http("GET", SRV + "/v1/hosts", timeout=5)
    for h in (out or {}).get("hosts", []):
        if h.get("host_id", "").replace("-", "") == HOST_ID.replace("-", ""):
            return h.get("status", "?")
    return "absent"


def omnigent_runner_view(session_ids: list[str]) -> dict[str, Any]:
    """Omnigent's own view: sessions whose runner the server sees online."""
    online = []
    for sid in session_ids:
        b = snapshot(sid)
        if b.get("runner_online") is True:
            online.append(sid)
    return {"runner_online_sessions": len(online)}
