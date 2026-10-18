"""Spike S7 emulated computer: replays every variant against the private host route.

Runs inside a staging container whose outbound requests to ``omnigent.internal`` are
intercepted to the Worker's ComputerRoute entrypoint, and to ``results.internal`` to the
Worker's result sink. It holds the owner's Omnigent login, as a real computer would, and
behaves like a hostile process on that computer: it tries every request shape in
``variants.json`` (exported from scripts/variants.ts) with raw sockets, then posts the results.

Standard library only. Never prints the password or the token.
"""

from __future__ import annotations

import base64
import json
import os
import socket
import time
import urllib.request

HOST = "omnigent.internal"
# Where to connect. On staging the name itself is intercepted; locally scripts/computer-local.sh
# points this at the emulated private route on the host.
CONNECT_HOST, _, CONNECT_PORT = os.environ.get("S7_CONNECT", f"{HOST}:80").partition(":")
PORT = int(CONNECT_PORT or 80)
RESULTS_URL = os.environ.get("S7_RESULTS_URL", "http://results.internal/")
EDITABLE_KEYS = (
    "editable",
    "public_sharing_editable",
    "public_sharing_max_level_editable",
    "default_public_sessions_editable",
)


def _complete(data: bytes, is_head: bool) -> bool:
    """True once a whole response has arrived; some proxies keep the connection open after it."""
    head, sep, rest = data.partition(b"\r\n\r\n")
    if not sep:
        return False
    text = head.decode("latin-1").lower()
    try:
        status = int(text.split(" ")[1])
    except (IndexError, ValueError):
        return False
    if is_head or status in (204, 304) or 100 <= status < 200:
        return True
    for item in text.split("\r\n")[1:]:
        name, _, value = item.partition(":")
        if name.strip() == "content-length":
            return len(rest) >= int(value.strip() or 0)
        if name.strip() == "transfer-encoding" and "chunked" in value:
            return b"0\r\n\r\n" in rest
    return False


def raw(line: str, headers: list[list[str]], body: bytes | None, chunked: bool) -> dict:
    """Sends one request on a fresh connection and reads until the peer closes it."""
    try:
        sock = socket.create_connection((CONNECT_HOST, PORT), timeout=30)
    except OSError as exc:
        return {"status": 0, "headers": {}, "body": f"connect failed: {exc}"}
    lines = [line, f"Host: {HOST}"]
    lines += [f"{name}: {value}" for name, value in headers]
    if body is not None and chunked:
        lines.append("Transfer-Encoding: chunked")
    elif body is not None:
        lines.append(f"Content-Length: {len(body)}")
    lines += ["Connection: close", "", ""]
    data = "\r\n".join(lines).encode("latin-1")
    if body is not None and chunked:
        half = (len(body) + 1) // 2
        for part in (body[:half], body[half:]):
            if part:
                data += f"{len(part):x}\r\n".encode() + part + b"\r\n"
        data += b"0\r\n\r\n"
    elif body is not None:
        data += body
    chunks = []
    is_head = line.upper().startswith("HEAD ")
    try:
        sock.sendall(data)
        while True:
            chunk = sock.recv(65536)
            if not chunk:
                break
            chunks.append(chunk)
            if _complete(b"".join(chunks), is_head):
                break
    except OSError:
        pass
    finally:
        sock.close()
    response = b"".join(chunks)
    head, _, rest = response.partition(b"\r\n\r\n")
    head_lines = head.decode("latin-1").split("\r\n")
    try:
        status = int(head_lines[0].split(" ")[1])
    except (IndexError, ValueError):
        return {"status": 0, "headers": {}, "body": response[:200].decode("utf-8", "replace")}
    parsed = {}
    for item in head_lines[1:]:
        name, _, value = item.partition(":")
        parsed[name.strip().lower()] = value.strip()
    if "chunked" in parsed.get("transfer-encoding", "").lower():
        decoded, offset = b"", 0
        while offset < len(rest):
            end = rest.find(b"\r\n", offset)
            if end < 0:
                break
            size = int(rest[offset:end].split(b";")[0] or b"0", 16)
            if size == 0:
                break
            decoded += rest[end + 2 : end + 2 + size]
            offset = end + 2 + size + 2
        rest = decoded
    return {"status": status, "headers": parsed, "body": rest.decode("utf-8", "replace")}


def flags(response: dict) -> str | None:
    if "json" not in response["headers"].get("content-type", ""):
        return None
    try:
        data = json.loads(response["body"])
    except ValueError:
        return "unparseable"
    if not isinstance(data, dict) or "sharing_mode" not in data:
        return None
    return " ".join(f"{k}={data.get(k)}" for k in EDITABLE_KEYS)


def judge(variant: dict, response: dict) -> tuple[bool, str]:
    guard = response["headers"].get("x-s7-guard", "")
    status = response["status"]
    expect = variant["expect"]
    if expect == "refuse":
        if guard == "refused" and status == 403:
            return True, "refused by guard"
        # The HTTP stack in front of the Worker (Cloudflare's, or Wrangler's dev proxy) may
        # reject malformed requests itself; the guard header shows the Worker never answered.
        if guard == "" and status in (0, 400, 405, 500, 501):
            return True, f"rejected before the Worker ({status})"
        return False, f"not refused (status {status}, guard {guard or 'none'})"
    if expect == "rewrite":
        f = flags(response)
        if guard == "rewritten":
            ok = f is None or "=True" not in f
            return ok, "rewritten as managed" if ok else f"editable flag left: {f}"
        return guard == "managed-passthrough", f"upstream {status}"
    return guard == "forwarded", f"forwarded, upstream {status}"


def login() -> str:
    body = json.dumps(
        {"username": os.environ["S7_USERNAME"], "password": os.environ["S7_PASSWORD"]}
    ).encode()
    for _ in range(90):
        response = raw(
            "POST /auth/login HTTP/1.1", [["Content-Type", "application/json"]], body, False
        )
        if response["status"] == 200:
            return json.loads(response["body"])["token"]
        time.sleep(2)
    raise RuntimeError(f"login through the private route failed: {response['status']}")


def main() -> None:
    label = os.environ.get("S7_LABEL", "run")
    started = time.time()
    with open(os.path.join(os.path.dirname(__file__), "variants.json"), encoding="utf-8") as fh:
        variants = json.load(fh)
    rows = []
    error = ""
    try:
        token = login()
        auth = f"Bearer {token}"
        for variant in variants:
            headers = [[n, auth if v == "__S7_AUTH__" else v] for n, v in variant["headers"]]
            body = base64.b64decode(variant["bodyBase64"]) if variant["bodyBase64"] else None
            line = variant["line"].replace("http://127.0.0.1:80", f"http://{HOST}")
            response = raw(line, headers, body, variant["chunked"])
            ok, note = judge(variant, response)
            rows.append(
                {
                    "id": variant["id"],
                    "description": variant["description"],
                    "expect": variant["expect"],
                    "status": response["status"],
                    "guard": response["headers"].get("x-s7-guard", ""),
                    "flags": flags(response),
                    "pass": ok,
                    "note": note,
                }
            )
        final = raw("GET /v1/sharing HTTP/1.1", [["Authorization", auth]], None, False)
        state = json.loads(final["body"]) if final["status"] == 200 else {"status": final["status"]}
    except Exception as exc:  # noqa: BLE001 - report every failure back to the Worker
        error = repr(exc)
        state = {}
    result = {
        "label": label,
        "seconds": round(time.time() - started, 1),
        "passed": sum(1 for r in rows if r["pass"]),
        "total": len(rows),
        "error": error,
        "finalState": {
            k: state.get(k)
            for k in (
                "sharing_mode",
                "public_sharing_enabled",
                "public_sharing_max_level",
                "default_public_sessions",
                "managed",
                *EDITABLE_KEYS,
            )
        },
        "rows": rows,
    }
    if RESULTS_URL == "-":
        print(json.dumps(result))
        return
    request = urllib.request.Request(
        RESULTS_URL,
        data=json.dumps(result).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    for _ in range(10):
        try:
            urllib.request.urlopen(request, timeout=30).read()
            break
        except OSError:
            time.sleep(3)
    # Stay up briefly so the controller sees a clean exit after delivery.
    time.sleep(5)


if __name__ == "__main__":
    main()
