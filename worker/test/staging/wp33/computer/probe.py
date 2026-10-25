"""WP3.3 staging: a stand-in for a computer's live connection (not Omnigent's host).

It holds one WebSocket per route host in WP33_HOSTS (each an intercepted virtual host that leads
through a route of the platform Worker to OmnigentServer and the stand-in server's echo), and:

- sends an echo every second, and a binary echo every fifth, checking each binary reply is the
  bytes it sent;
- records when each connection ends and how: a close frame (its code), the transport's end, or
  its own silence deadline. The deadline is 75 s, longer than core change 12's 45 s, so a drop
  that is never signalled shows as `by: "silence"` rather than being cut short by the probe
  (WP2.2's design change 7: tell "not signalled" from "slow");
- on a dropped connection, aborts the socket (no closing handshake to wait for) and reconnects;
- once per route, on a separate connection, sends binary messages of growing size and checks the
  echo (WP33_LADDER), for the 32 MiB limit on messages a Worker receives;
- with WP33_FLOOD, holds one more connection per named route that sends 2 KiB messages as fast
  as WP33_FLOOD_RATE allows, and reports the counts every 30 s.

With WP33_CHECKS (the final run, through the production route), it first checks once what a
computer may and may not do on omnigent.internal and computer.internal: an ordinary read, the
block list, a method override, its own host tunnel with its launch token, another computer's host
tunnel, its own without a launch token, and the computer API's hello (current and older
generation). Each check records the status it got and whether that was the expected one.

Records go to http://rec.internal/batch every 5 s (the intercept's props name this computer), and
to stdout. No headers or bodies are recorded.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import secrets
import time
import urllib.error
import urllib.request

from websockets.asyncio.client import ClientConnection, connect
from websockets.exceptions import ConnectionClosed, InvalidStatus

HOSTS = [h for h in os.environ.get("WP33_HOSTS", "native.internal").split(",") if h]
FLOOD = [h for h in os.environ.get("WP33_FLOOD", "").split(",") if h]
FLOOD_RATE = float(os.environ.get("WP33_FLOOD_RATE", "200"))
LADDER = os.environ.get("WP33_LADDER", "") == "1"
LADDER_MIB = [1, 8, 31, 33]
VARIANT = os.environ.get("WP33_VARIANT", "unknown")[:20]
SILENCE_S = 75.0
ECHO_DEADLINE_S = 1.0
REC_URL = "http://rec.internal/batch"
BOOT = secrets.token_hex(8)

PENDING: list[dict] = []


def wall_ms() -> float:
    return round(time.time() * 1000, 3)


def record(ev: str, **fields: object) -> None:
    row = {"ev": ev, "wall": wall_ms(), "boot": BOOT, "variant": VARIANT, **fields}
    PENDING.append(row)
    print(json.dumps(row, separators=(",", ":")), flush=True)


def post(body: bytes) -> bool:
    request = urllib.request.Request(REC_URL, data=body, method="POST")
    request.add_header("content-type", "application/x-ndjson")
    try:
        with urllib.request.urlopen(request, timeout=10) as response:  # noqa: S310 - fixed scheme
            return 200 <= response.status < 300
    except Exception:  # noqa: BLE001 - kept and retried
        return False


async def shipper() -> None:
    while True:
        await asyncio.sleep(5)
        if not PENDING:
            continue
        batch = PENDING[:2000]
        body = "".join(json.dumps(r, separators=(",", ":")) + "\n" for r in batch).encode()
        if await asyncio.to_thread(post, body):
            del PENDING[: len(batch)]


def ended_how(error: BaseException | None) -> dict:
    if isinstance(error, ConnectionClosed):
        if error.rcvd is not None:
            return {"by": "close_frame", "code": error.rcvd.code, "reason": error.rcvd.reason[:80]}
        return {"by": "transport", "error": type(error).__name__}
    if error is None:
        return {"by": "unknown"}
    return {"by": "transport", "error": type(error).__name__}


async def hold(host: str) -> None:
    """One measured connection per route, reconnected after every drop."""
    attempt = 0
    while True:
        attempt += 1
        url = f"ws://{host}/ws?client={VARIANT}-{host.split('.')[0]}"
        opened_at = time.monotonic()
        try:
            ws = await connect(
                url, open_timeout=10, ping_interval=None, close_timeout=1, max_size=None
            )
        except Exception as error:  # noqa: BLE001
            record("open_failed", host=host, attempt=attempt, error=type(error).__name__,
                   ms=round((time.monotonic() - opened_at) * 1000))
            await asyncio.sleep(0.5)
            continue
        record("open", host=host, attempt=attempt, ms=round((time.monotonic() - opened_at) * 1000))
        await measure(ws, host, attempt)
        await asyncio.sleep(0.2)


async def measure(ws: ClientConnection, host: str, attempt: int) -> None:
    seq = 0
    outstanding: dict[int, float] = {}
    binary_sent: dict[str, int] = {}
    last_reply_wall = wall_ms()
    last_reply = time.monotonic()
    first_miss_wall: float | None = None
    replies = 0
    binary_ok = 0
    binary_bad = 0
    recv = asyncio.ensure_future(ws.recv())
    next_send = time.monotonic()
    error: BaseException | None = None
    try:
        while True:
            now = time.monotonic()
            if now >= next_send:
                seq += 1
                if seq % 5 == 0:
                    payload = secrets.token_bytes(64)
                    binary_sent[hashlib.sha256(payload).hexdigest()] = seq
                    outstanding[seq] = now
                    await ws.send(payload)
                else:
                    outstanding[seq] = now
                    await ws.send(f"echo {seq}")
                next_send = max(next_send + 1.0, now)
            for s, sent in outstanding.items():
                if first_miss_wall is None and now - sent > ECHO_DEADLINE_S:
                    first_miss_wall = wall_ms() - (now - sent - ECHO_DEADLINE_S) * 1000
            if now - last_reply > SILENCE_S:
                record("end", host=host, attempt=attempt, by="silence", wall_last_reply=last_reply_wall,
                       first_miss=first_miss_wall, replies=replies, binary_ok=binary_ok,
                       binary_bad=binary_bad)
                ws.transport.abort()
                return
            done, _ = await asyncio.wait({recv}, timeout=max(0.0, min(next_send, last_reply + SILENCE_S) - time.monotonic()))
            if recv in done:
                try:
                    message = recv.result()
                except BaseException as e:  # noqa: BLE001
                    error = e
                    break
                recv = asyncio.ensure_future(ws.recv())
                last_reply = time.monotonic()
                last_reply_wall = wall_ms()
                replies += 1
                if isinstance(message, bytes):
                    digest = hashlib.sha256(message).hexdigest()
                    s = binary_sent.pop(digest, None)
                    if s is None:
                        binary_bad += 1
                    else:
                        binary_ok += 1
                        outstanding.pop(s, None)
                elif message.startswith("echo "):
                    try:
                        outstanding.pop(int(message[5:]), None)
                    except ValueError:
                        pass
    except BaseException as e:  # noqa: BLE001
        error = e
    finally:
        recv.cancel()
    record("end", host=host, attempt=attempt, wall_last_reply=last_reply_wall,
           first_miss=first_miss_wall, replies=replies, binary_ok=binary_ok,
           binary_bad=binary_bad, **ended_how(error))
    ws.transport.abort()


async def ladder(host: str) -> None:
    url = f"ws://{host}/ws?client={VARIANT}-{host.split('.')[0]}-ladder"
    for mib in LADDER_MIB:
        payload = secrets.token_bytes(mib * 1024 * 1024)
        digest = hashlib.sha256(payload).hexdigest()
        ws = None
        for _ in range(60):  # wait for the route to be up before each rung
            try:
                ws = await connect(url, open_timeout=10, ping_interval=None, close_timeout=1,
                                   max_size=None)
                break
            except Exception:  # noqa: BLE001
                await asyncio.sleep(2)
        if ws is None:
            record("ladder", host=host, mib=mib, ok=False, by="open_failed")
            continue
        started = time.monotonic()
        try:
            async with ws:
                await ws.send(payload)
                reply = await asyncio.wait_for(ws.recv(), timeout=60)
                ok = isinstance(reply, bytes) and hashlib.sha256(reply).hexdigest() == digest
                record("ladder", host=host, mib=mib, ok=ok,
                       ms=round((time.monotonic() - started) * 1000))
        except Exception as error:  # noqa: BLE001
            record("ladder", host=host, mib=mib, ok=False, **ended_how(error),
                   ms=round((time.monotonic() - started) * 1000))
        await asyncio.sleep(1)


async def flood(host: str) -> None:
    url = f"ws://{host}/ws?client={VARIANT}-{host.split('.')[0]}-flood"
    payload = b"f" * 2048
    attempt = 0
    while True:
        attempt += 1
        sent = 0
        received = 0
        started = time.monotonic()
        last_report = started
        try:
            async with connect(url, open_timeout=10, ping_interval=None, close_timeout=1,
                               max_size=None) as ws:
                record("flood_open", host=host, attempt=attempt)

                async def reader() -> None:
                    nonlocal received
                    async for _ in ws:
                        received += 1

                task = asyncio.create_task(reader())
                interval = 1.0 / FLOOD_RATE
                next_send = time.monotonic()
                while True:
                    if task.done():
                        task.result()
                        raise ConnectionError("reader ended")
                    await ws.send(payload)
                    sent += 1
                    next_send += interval
                    delay = next_send - time.monotonic()
                    if delay > 0:
                        await asyncio.sleep(delay)
                    now = time.monotonic()
                    if now - last_report >= 30:
                        last_report = now
                        record("flood", host=host, attempt=attempt, sent=sent, received=received,
                               s=round(now - started))
        except BaseException as error:  # noqa: BLE001
            record("flood_end", host=host, attempt=attempt, sent=sent, received=received,
                   s=round(time.monotonic() - started), **ended_how(error))
        await asyncio.sleep(1)


def http_status(method: str, url: str, headers: dict[str, str], body: bytes | None) -> int:
    request = urllib.request.Request(url, data=body, method=method, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=15) as response:  # noqa: S310 - fixed scheme
            return response.status
    except urllib.error.HTTPError as error:
        return error.code
    except Exception:  # noqa: BLE001
        return -1


async def ws_status(url: str, headers: dict[str, str]) -> int:
    try:
        async with connect(url, additional_headers=headers, open_timeout=15, close_timeout=1) as ws:
            payload = secrets.token_bytes(32)
            await ws.send(payload)
            echoed = await asyncio.wait_for(ws.recv(), timeout=10)
            return 101 if echoed == payload else -2
    except InvalidStatus as error:
        return error.response.status_code
    except Exception:  # noqa: BLE001
        return -1


async def checks() -> None:
    own = os.environ["WP33_HOST_ID"]
    other = os.environ["WP33_OTHER_HOST_ID"]
    token = os.environ["WP33_LAUNCH_TOKEN"]
    computer = os.environ["WP33_COMPUTER_ID"]
    generation = int(os.environ["WP33_GENERATION"])
    base = "http://omnigent.internal"
    json_headers = {"content-type": "application/json"}
    # The server may still be starting: wait for an ordinary read to pass first.
    for _ in range(60):
        if await asyncio.to_thread(http_status, "GET", f"{base}/v1/info", {}, None) == 200:
            break
        await asyncio.sleep(2)

    def hello(gen: int) -> bytes:
        return json.dumps({
            "type": "hello", "protocolVersion": 1, "computerId": computer, "generation": gen,
            "operationId": "op_01hzy3m8k6q4t2v9w7x5r0s1n3", "supervisorVersion": "wp33-probe",
        }).encode()

    http_cases = [
        ("read", "GET", f"{base}/v1/info", {}, None, 200),
        ("account_setup", "POST", f"{base}/auth/setup", json_headers, b"{}", 403),
        ("account_setup_encoded", "POST", f"{base}/AUTH%2Fsetup", json_headers, b"{}", 403),
        ("approval", "POST", f"{base}/v1/sessions/s1/elicitations/e1/resolve", json_headers, b"{}", 403),
        ("sharing", "PUT", f"{base}/v1/sharing", json_headers, b"{}", 403),
        ("override", "GET", f"{base}/v1/info", {"X-HTTP-Method-Override": "PUT"}, None, 403),
        ("computer_api_hello", "POST", "http://computer.internal/v1/messages", json_headers, hello(generation), 200),
        ("computer_api_older", "POST", "http://computer.internal/v1/messages", json_headers, hello(generation - 1), 409),
    ]
    for name, method, url, headers, body, expected in http_cases:
        status = await asyncio.to_thread(http_status, method, url, headers, body)
        record("check", name=name, status=status, ok=status == expected)
    ws_base = "ws://omnigent.internal/v1/hosts"
    ws_cases = [
        ("own_tunnel", f"{ws_base}/{own}/tunnel", {"X-Omnigent-Host-Token": token}, 101),
        ("other_tunnel", f"{ws_base}/{other}/tunnel", {"X-Omnigent-Host-Token": token}, 403),
        ("own_tunnel_no_token", f"{ws_base}/{own}/tunnel", {"Authorization": "Bearer x"}, 403),
        ("own_tunnel_both", f"{ws_base}/{own}/tunnel", {"X-Omnigent-Host-Token": token, "Authorization": "Bearer x"}, 403),
    ]
    for name, url, headers, expected in ws_cases:
        status = await ws_status(url, headers)
        record("check", name=name, status=status, ok=status == expected)


async def main() -> None:
    record("boot", hosts=HOSTS, flood=FLOOD, ladder=LADDER)
    if os.environ.get("WP33_CHECKS") == "1":
        await checks()
    tasks = [asyncio.create_task(shipper())]
    tasks += [asyncio.create_task(hold(h)) for h in HOSTS]
    if LADDER:
        for h in HOSTS:
            await ladder(h)
    tasks += [asyncio.create_task(flood(h)) for h in FLOOD]
    await asyncio.gather(*tasks)


if __name__ == "__main__":
    asyncio.run(main())
