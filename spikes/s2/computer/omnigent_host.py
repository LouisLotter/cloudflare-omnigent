"""The real Omnigent host on the S2 computer, and a conversation driver.

- Logs in once with the synthetic admin login (as `omnigent login` would after the person
  typed the password) and writes ~/.omnigent/auth_tokens.json and config.yaml, with the
  host identity the ComputerDO assigned.
- Runs Omnigent's own mock LLM on 127.0.0.1:9999, so runners need no provider account.
- Runs `omnigent host --server http://omnigent.internal` and reports every tunnel connect
  and disconnect it logs, and every runner tunnel event.
- Creates one conversation bound to this host, then sends one message per TURN_S seconds
  and reports whether the reply arrived and how long it took. The same conversation is used
  for the whole run, so "the conversation continues" is a measured fact, not an assumption.
- Polls the server's view of the host (GET /health?session_id=) and reports changes.
"""

from __future__ import annotations

import asyncio
import io
import json
import os
import re
import tarfile
import time
import uuid
from pathlib import Path

import httpx

from s2common import SERVER_URL, now_ms, report

OMNI = Path.home() / ".omnigent"
HOST_ID = os.environ.get("S2_HOST_ID") or uuid.uuid4().hex
HOST_NAME = os.environ.get("S2_HOST_NAME", "s2-computer")
MOCK_PORT = 9999
WORKSPACE = "/s2/ws"
TURN_S = float(os.environ.get("S2_TURN_S", "60"))
LIVENESS_S = 5.0

AGENT_YAML = """\
name: s2-route-agent
description: Spike S2 conversation over the private route; answers from the mock LLM.
executor:
  harness: openai-agents
  model: mock-model
prompt: |
  You are a terse test assistant.
"""

HOST_PATTERNS = [
    ("host-connecting", re.compile(r"Connecting to ")),
    ("host-up", re.compile(r"Host tunnel connected")),
    ("host-down", re.compile(r"Host tunnel disconnected(?P<detail>.*)")),
    ("host-hello", re.compile(r"Connected as '.*?' \((?P<host>[0-9a-f-]+)\), (?P<runners>\d+) live")),
    ("runner-launched", re.compile(r"Launched runner (?P<runner>\S+) for workspace")),
    ("host-auth", re.compile(r"(?i)\b(401|403)\b|unauthori[sz]ed|token refresh")),
]
RUNNER_PATTERNS = [
    ("runner-up", re.compile(r"runner (?P<runner>\S+) connected to")),
    ("runner-down", re.compile(r"runner tunnel disconnected: (?P<detail>.*)")),
]


def client(token: str | None = None) -> httpx.Client:
    headers = {"authorization": f"Bearer {token}"} if token else {}
    return httpx.Client(base_url=SERVER_URL, headers=headers, timeout=30.0)


def wait_for_server() -> None:
    started = time.time()
    attempts = 0
    while True:
        attempts += 1
        try:
            with client() as c:
                if c.get("/health").status_code == 200:
                    report("server-reachable", waitedS=round(time.time() - started, 1))
                    return
        except httpx.HTTPError:
            pass
        if attempts % 30 == 1:
            report("server-wait", attempts=attempts)
        time.sleep(2)


def login() -> dict[str, object]:
    body = {
        "username": os.environ["S2_ADMIN_USER"],
        "password": os.environ["S2_ADMIN_PASSWORD"],
        "issue_refresh": True,
    }
    for attempt in range(60):
        try:
            with client() as c:
                res = c.post("/auth/login", json=body)
            if res.status_code == 200:
                return res.json()
            report("login-retry", status=res.status_code, attempt=attempt)
        except httpx.HTTPError as error:
            report("login-retry", error=type(error).__name__, attempt=attempt)
        time.sleep(3)
    raise RuntimeError("login failed")


def write_host_files(tokens: dict[str, object]) -> None:
    OMNI.mkdir(parents=True, exist_ok=True)
    user = tokens.get("user") or {}
    auth = {
        SERVER_URL.rstrip("/"): {
            "token": tokens["token"],
            "user_id": user.get("id") if isinstance(user, dict) else None,
            "expires_at": time.time() + float(tokens.get("expires_in", 3600)),
            "refresh_token": tokens.get("refresh_token"),
        }
    }
    path = OMNI / "auth_tokens.json"
    path.write_text(json.dumps(auth))
    path.chmod(0o600)
    (OMNI / "config.yaml").write_text(
        f"server: {SERVER_URL}\nhost:\n  host_id: {HOST_ID}\n  name: {HOST_NAME}\n"
    )
    report(
        "host-files",
        hostId=HOST_ID,
        refresh=bool(tokens.get("refresh_token")),
        expiresIn=tokens.get("expires_in"),
    )


async def pipe_lines(stream: asyncio.StreamReader, prefix: str, patterns) -> None:
    while True:
        raw = await stream.readline()
        if not raw:
            return
        line = raw.decode(errors="replace").rstrip()
        print(f"{prefix} {line}", flush=True)
        for kind, pattern in patterns:
            match = pattern.search(line)
            if match:
                report(kind, **{k: v[:200] for k, v in match.groupdict().items() if v})
                if kind == "host-hello":
                    RECONNECTED.set()
                break


# Set on every host hello, so the driver sends a turn as soon as the host is back instead of
# waiting for its next scheduled turn. That measures "the conversation continues" directly.
RECONNECTED = asyncio.Event()


async def run_mock() -> None:
    proc = await asyncio.create_subprocess_exec(
        "python",
        "/s2/mock_llm_server.py",
        str(MOCK_PORT),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
    )
    assert proc.stdout is not None
    await pipe_lines(proc.stdout, "MOCK", [])
    report("mock-exit", code=await proc.wait())


async def run_host() -> None:
    env = {
        **os.environ,
        "OPENAI_BASE_URL": f"http://127.0.0.1:{MOCK_PORT}/v1",
        "OPENAI_API_KEY": "mock-key",
        "OMNIGENT_LOG_TTY_FD": "2",
        "OMNIGENT_HOST_NO_OPEN": "1",
    }
    env.pop("S2_ADMIN_PASSWORD", None)
    restarts = 0
    while True:
        proc = await asyncio.create_subprocess_exec(
            "omnigent",
            "host",
            "--server",
            SERVER_URL,
            "--no-open",
            "--non-interactive",
            env=env,
            cwd=WORKSPACE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        report("host-process", pid=proc.pid, restarts=restarts)
        assert proc.stdout is not None and proc.stderr is not None
        await asyncio.gather(
            pipe_lines(proc.stdout, "HOST", HOST_PATTERNS),
            pipe_lines(proc.stderr, "HOST", HOST_PATTERNS),
        )
        code = await proc.wait()
        restarts += 1
        report("host-process-exit", code=code, restarts=restarts)
        await asyncio.sleep(5)


async def tail_logs(kind: str, patterns) -> None:
    """Reports tunnel connects and drops from the host's or the runners' own log files."""
    offsets: dict[Path, int] = {}
    logs = OMNI / "logs" / kind
    while True:
        await asyncio.sleep(1)
        for path in sorted(logs.glob("*.log")) if logs.exists() else []:
            offset = offsets.get(path, 0)
            with path.open("rb") as fh:
                fh.seek(offset)
                data = fh.read()
            offsets[path] = offset + len(data)
            for line in data.decode(errors="replace").splitlines():
                for event, pattern in patterns:
                    match = pattern.search(line)
                    if match:
                        fields = {k: v[:200] for k, v in match.groupdict().items() if v}
                        report(event, file=path.name[-24:], logTime=line[:24], **fields)
                        break


def create_conversation(token: str) -> str:
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w:gz") as tar:
        data = AGENT_YAML.encode()
        info = tarfile.TarInfo("s2-route-agent.yaml")
        info.size = len(data)
        tar.addfile(info, io.BytesIO(data))
    with client(token) as c:
        res = c.post(
            "/v1/sessions",
            data={"metadata": "{}"},
            files={"bundle": ("agent.tar.gz", buffer.getvalue(), "application/gzip")},
            headers={"origin": "omnigent://internal"},
        )
        if res.status_code == 409:
            # Registered by an earlier boot of this computer: look it up by name.
            listed = c.get(
                "/v1/sessions",
                params={"visibility": "all", "agent_name": "s2-route-agent", "limit": 1},
            )
            listed.raise_for_status()
            agent_id = listed.json()["data"][0]["agent_id"]
        else:
            res.raise_for_status()
            upload_session = res.json()["session_id"]
            agent_id = c.get(f"/v1/sessions/{upload_session}").json()["agent_id"]
        res = c.post(
            "/v1/sessions",
            json={"agent_id": agent_id, "host_id": HOST_ID, "workspace": WORKSPACE},
            timeout=120.0,
        )
        res.raise_for_status()
        session_id = res.json()["id"]
    report("conv-created", session=session_id, agent=agent_id)
    return session_id


def assistant_count(snapshot: dict[str, object]) -> int:
    items = snapshot.get("items") or []
    return sum(
        1
        for i in items
        if isinstance(i, dict) and (i.get("data") or {}).get("role") == "assistant"
    )


def one_turn(token: str, session_id: str, n: int, trigger: str) -> None:
    started = now_ms()
    with client(token) as c:
        before = c.get(f"/v1/sessions/{session_id}", params={"include_usage": "false"})
        before.raise_for_status()
        count = assistant_count(before.json())
        res = c.post(
            f"/v1/sessions/{session_id}/events",
            json={
                "type": "message",
                "data": {
                    "role": "user",
                    "content": [{"type": "input_text", "text": f"s2 turn {n}"}],
                },
            },
            timeout=120.0,
        )
        res.raise_for_status()
        posted = now_ms()
        deadline = time.time() + 180
        while time.time() < deadline:
            snap = c.get(f"/v1/sessions/{session_id}", params={"include_usage": "false"}).json()
            if snap.get("status") == "idle" and assistant_count(snap) > count:
                report(
                    "conv-turn",
                    n=n,
                    ok=True,
                    trigger=trigger,
                    ms=now_ms() - started,
                    replyMs=now_ms() - posted,
                    assistantItems=assistant_count(snap),
                    items=len(snap.get("items") or []),
                )
                return
            if snap.get("status") == "failed":
                raise RuntimeError("session failed")
            time.sleep(1)
        raise TimeoutError("no reply within 180 s")


async def drive_conversation(token: str) -> None:
    session_id = None
    while session_id is None:
        try:
            session_id = await asyncio.to_thread(create_conversation, token)
        except Exception as error:  # noqa: BLE001 - retried; the error is reported
            report("conv-create-error", error=f"{type(error).__name__}: {error}"[:200])
            await asyncio.sleep(10)
    asyncio.create_task(watch_liveness(token, session_id))
    n = 0
    trigger = "scheduled"
    RECONNECTED.clear()
    while True:
        n += 1
        try:
            await asyncio.to_thread(one_turn, token, session_id, n, trigger)
        except Exception as error:  # noqa: BLE001 - a failed turn is a measurement
            message = f"{type(error).__name__}: {error}"[:200]
            report("conv-turn", n=n, ok=False, trigger=trigger, error=message)
            if isinstance(error, httpx.HTTPStatusError) and error.response.status_code == 401:
                token = str((await asyncio.to_thread(login))["token"])
                report("driver-relogin")
        try:
            await asyncio.wait_for(RECONNECTED.wait(), timeout=TURN_S)
            trigger = "reconnect"
        except TimeoutError:
            trigger = "scheduled"
        RECONNECTED.clear()


async def watch_liveness(token: str, session_id: str) -> None:
    """The server's own view of this host and runner, polled through the route."""
    last: tuple[object, object] | None = None
    while True:
        state: tuple[object, object]
        try:
            with client(token) as c:
                body = c.get("/health", params={"session_id": session_id}, timeout=10).json()
            session = body.get("session") or {}
            state = (session.get("host_online"), session.get("runner_online"))
        except Exception as error:  # noqa: BLE001 - unreachable is a state too
            state = ("unreachable", type(error).__name__)
        if state != last:
            report("server-view", host=state[0], runner=state[1])
            last = state
        await asyncio.sleep(LIVENESS_S)


async def run() -> None:
    Path(WORKSPACE).mkdir(parents=True, exist_ok=True)
    await asyncio.to_thread(wait_for_server)
    tokens = await asyncio.to_thread(login)
    write_host_files(tokens)
    driver_tokens = await asyncio.to_thread(login)
    asyncio.create_task(run_mock())
    asyncio.create_task(tail_logs("runner", RUNNER_PATTERNS))
    asyncio.create_task(tail_logs("host", HOST_PATTERNS))
    asyncio.create_task(run_host())
    await asyncio.sleep(5)
    await drive_conversation(str(driver_tokens["token"]))
