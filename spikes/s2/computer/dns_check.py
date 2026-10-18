"""DNS and routing check with internet on: do public names still resolve, and do virtual hosts
reach the Worker rather than the internet?

Run at boot (before and after the first intercept could matter) and again later. Each check
is one report record. No request carries credentials.
"""

from __future__ import annotations

import json
import socket
import ssl
import time
import urllib.request

from s2common import report

VIRTUAL = "omnigent.internal"
# Names the computer needs (providers), a plain public name, an unregistered platform-style
# virtual host, and a name that exists nowhere.
NAMES = [
    VIRTUAL,
    "example.com",
    "api.anthropic.com",
    "chatgpt.com",
    "mcp.internal",
    "nonexistent-s2-check.internal",
]


def resolve(name: str, family: int) -> dict[str, object]:
    started = time.perf_counter()
    try:
        infos = socket.getaddrinfo(name, 80, family, socket.SOCK_STREAM)
        addrs = sorted({info[4][0] for info in infos})
        return {"ok": True, "addrs": addrs[:4], "ms": round((time.perf_counter() - started) * 1000)}
    except OSError as error:
        return {
            "ok": False,
            "error": f"{type(error).__name__}: {error}"[:120],
            "ms": round((time.perf_counter() - started) * 1000),
        }


def http(url: str) -> dict[str, object]:
    started = time.perf_counter()
    try:
        ctx = ssl.create_default_context()
        with urllib.request.urlopen(url, timeout=10, context=ctx) as res:
            body = res.read(4096).decode(errors="replace")
            return {
                "ok": True,
                "status": res.status,
                "server": res.headers.get("server"),
                "body": body[:200],
                "ms": round((time.perf_counter() - started) * 1000),
            }
    except Exception as error:  # noqa: BLE001 - the failure is the measurement
        return {
            "ok": False,
            "error": f"{type(error).__name__}: {error}"[:160],
            "ms": round((time.perf_counter() - started) * 1000),
        }


def check(phase: str) -> None:
    try:
        resolv = open("/etc/resolv.conf").read()  # noqa: SIM115
        nameservers = [line.split()[1] for line in resolv.splitlines() if line.startswith("nameserver")]
        options = [line for line in resolv.splitlines() if line.startswith(("search", "options"))]
    except OSError:
        nameservers, options = [], []
    hosts = [line for line in open("/etc/hosts").read().splitlines() if "internal" in line]  # noqa: SIM115
    report("dns-config", phase=phase, nameservers=nameservers, options=options, hostsInternal=hosts)
    for name in NAMES:
        report(
            "dns",
            phase=phase,
            name=name,
            a=resolve(name, socket.AF_INET),
            aaaa=resolve(name, socket.AF_INET6),
        )
    whoami = http(f"http://{VIRTUAL}/_s2/whoami")
    if whoami.get("ok"):
        try:
            whoami["json"] = json.loads(str(whoami.pop("body")))
        except ValueError:
            pass
    report("route-http", phase=phase, url=f"http://{VIRTUAL}/_s2/whoami", result=whoami)
    # Port 80 to a public name must reach the internet, not the Worker.
    report("route-http", phase=phase, url="http://example.com/", result=http("http://example.com/"))
    # HTTPS is never intercepted: the public certificate must verify.
    report("route-http", phase=phase, url="https://example.com/", result=http("https://example.com/"))
    # A virtual host on another port is not intercepted.
    report(
        "route-http",
        phase=phase,
        url=f"http://{VIRTUAL}:8080/",
        result=http(f"http://{VIRTUAL}:8080/"),
    )
    # HTTPS to the virtual host: no HTTPS intercept is registered.
    report("route-http", phase=phase, url=f"https://{VIRTUAL}/", result=http(f"https://{VIRTUAL}/"))
