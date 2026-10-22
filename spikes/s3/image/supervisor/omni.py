"""Drive Omnigent conversations from inside the container (staging and local e2e).

The same flow as bench/omni.py, Omnigent's own e2e flow, against the server
and mock LLM that run beside the supervisor (``aio.py``): register an inline
openai-agents agent pointed at the mock, create a session, launch a runner on
this container's host, and send messages. No real account is involved.
Standard library only.
"""

from __future__ import annotations

import gzip
import io
import json
import os
import tarfile
import time
import urllib.error
import urllib.request
import uuid
from typing import Any

SRV = os.environ.get("S3_SERVER_URL", "http://127.0.0.1:8000")
MOCK = os.environ.get("S3_MOCK_URL", "http://127.0.0.1:9999")
HOST_ID = os.environ.get("OMNIGENT_HOST_ID", "6d2f6c1e-3b1a-4c55-9a51-5f3e0a000001")
MODEL = "mock-s3"


def http(method: str, url: str, body: Any = None, timeout: float = 60,
         headers: dict[str, str] | None = None) -> tuple[int, Any]:
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("content-type", "application/json")
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read()
            code = r.status
    except urllib.error.HTTPError as exc:
        raw = exc.read()
        code = exc.code
    try:
        return code, json.loads(raw) if raw else None
    except json.JSONDecodeError:
        return code, raw.decode(errors="replace")


def register_agent(name: str = "s3-agent") -> str:
    """Register an inline agent; returns its agent_id."""
    http("POST", MOCK + "/mock/set_fallback", {"key": MODEL, "text": "ok from mock"})
    cfg = {
        "name": name,
        "prompt": "You are a minimal test assistant. Answer briefly.",
        "executor": {
            "harness": "openai-agents",
            "model": MODEL,
            "profile": "",
            "auth": {"type": "api_key", "api_key": "mock-key", "base_url": MOCK + "/v1"},
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
    req = urllib.request.Request(SRV + "/v1/sessions", data=body, method="POST")
    req.add_header("Content-Type", f"multipart/form-data; boundary={boundary}")
    req.add_header("Origin", "omnigent://internal")
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            r.read()
    except urllib.error.HTTPError as exc:
        if exc.code != 409:
            raise RuntimeError(f"register failed {exc.code}: {exc.read()[:400]!r}") from exc
    code, rows = http("GET", SRV + f"/v1/sessions?visibility=all&agent_name={name}&limit=1")
    if code != 200 or not rows or not rows.get("data"):
        raise RuntimeError(f"agent lookup failed: {code} {str(rows)[:300]}")
    return str(rows["data"][0]["agent_id"])


def new_session(agent_id: str, workspace: str = "/home/agent/work") -> dict[str, Any]:
    t0 = time.monotonic()
    code, s = http("POST", SRV + "/v1/sessions", {"agent_id": agent_id})
    if code not in (200, 201):
        raise RuntimeError(f"session create failed: {code} {str(s)[:300]}")
    sid = s["id"]
    code, launch = http("POST", SRV + f"/v1/hosts/{HOST_ID}/runners",
                        {"session_id": sid, "workspace": workspace}, timeout=120)
    if code != 200:
        raise RuntimeError(f"runner launch failed: {code} {str(launch)[:300]}")
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
    if code != 200:
        raise RuntimeError(f"session runner patch failed: {code}")
    return {"session_id": sid, "runner_id": rid, "launch_s": round(time.monotonic() - t0, 2)}


def send(sid: str, text: str) -> int:
    """Post a user message; a 503 (runner exiting on its idle timeout) is retried."""
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
        raise RuntimeError(f"send failed: {code} {str(out)[:300]}")
    return 5


def snapshot(sid: str) -> dict[str, Any]:
    code, body = http("GET", SRV + f"/v1/sessions/{sid}", timeout=10)
    return body if code == 200 and isinstance(body, dict) else {"status": f"http-{code}"}


def _assistant_ids(body: dict[str, Any]) -> dict[str, str]:
    out = {}
    for item in body.get("items", []):
        data = item.get("data") or {}
        if item.get("type") == "message" and data.get("role") == "assistant":
            out[item.get("id")] = "".join(b.get("text", "") for b in data.get("content", []))
    return out


def turn(sid: str, text: str, timeout: float = 120) -> dict[str, Any]:
    """Send one message and wait for a new assistant reply (by item id)."""
    try:
        before = set(_assistant_ids(snapshot(sid)))
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "s": 0.0, "status": "snapshot_failed", "error": str(exc)[:200]}
    t0 = time.monotonic()
    try:
        attempts = send(sid, text)
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "s": round(time.monotonic() - t0, 2), "status": "send_failed", "error": str(exc)[:200]}
    deadline = t0 + timeout
    body: dict[str, Any] = {}
    while time.monotonic() < deadline:
        try:
            body = snapshot(sid)
        except Exception:  # noqa: BLE001 - a transient error while polling
            time.sleep(0.5)
            continue
        new = {k: v for k, v in _assistant_ids(body).items() if k not in before}
        if new and body.get("status") in ("idle", "completed", "waiting"):
            return {"ok": True, "s": round(time.monotonic() - t0, 2), "status": body.get("status"),
                    "send_attempts": attempts}
        if body.get("status") == "failed":
            break
        time.sleep(0.25)
    return {"ok": False, "s": round(time.monotonic() - t0, 2), "status": body.get("status"),
            "error": str(body.get("error"))[:200]}


def host_status() -> str:
    try:
        code, out = http("GET", SRV + "/v1/hosts", timeout=5)
    except Exception as exc:  # noqa: BLE001
        return f"error:{type(exc).__name__}"
    if code != 200 or not isinstance(out, dict):
        return f"http-{code}"
    for h in out.get("hosts", []):
        if h.get("host_id", "").replace("-", "") == HOST_ID.replace("-", ""):
            return str(h.get("status", "?"))
    return "absent"


def wait_host_online(timeout: float = 180) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if host_status() == "online":
            return True
        time.sleep(1)
    return False
