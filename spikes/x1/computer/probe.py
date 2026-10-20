"""X1 probe: one process holding six WebSockets, one per route, independently (pre-registration
section 4).

- Echo: an application message every 1.0 s per route (route, connection number, sequence number,
  send time). The deadline is 1.0 s after sending.
- Protocol ping every 5 s per route. Pong round trips are recorded separately and never count as
  echo replies: an intermediate hop may answer pings itself.
- Silence deadline: if no application frame arrives for 3.0 s while echoes are outstanding, the
  probe closes the socket with code 4000 and reconnects.
- Reconnect: the first attempt is immediate; after a failed attempt it retries every 0.5 s. Every
  attempt is recorded with its result and duration.
- Records: every event goes to a local JSON Lines log with wall-clock and monotonic times. No
  headers, tokens, URLs or bodies other than the echo's own fields are recorded.
- Batches: the log is cut into numbered batches every 10 s and posted to rec.x1.internal, each
  retried until stored. At the end the probe writes a manifest with the batch count, its
  completion marker, and then idles until RunDO stops the container.

P1, P2, P3 and P6 are intercepted virtual hosts. P4 and P5 go over the internet with the
F7-staging service token, and P5 also with the per-computer route credential.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import os
import secrets
import time
import urllib.error
import urllib.request
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path

from websockets.asyncio.client import ClientConnection, connect
from websockets.exceptions import ConnectionClosed, InvalidStatus

SILENCE_CODE = 4000
ROUTES = ("p1", "p2", "p3", "p4", "p5", "p6")
INTERNAL_HOSTS = {r: f"{r}.x1.internal" for r in ("p1", "p2", "p3", "p6")}
RECORDER = "http://rec.x1.internal"
CREDENTIAL_HEADER = "x-x1-route-credential"
IDENTITY_KEYS = (
    "by",
    "boot",
    "start",
    "pid",
    "isolate",
    "build",
    "serverdo",
    "handler",
    "policy",
    "route",
)


@dataclass(frozen=True)
class Params:
    """Section 4's timings. open_timeout and the batch retry back-off are not fixed by the
    pre-registration; they are this probe's choice."""

    echo_interval: float = 1.0
    deadline: float = 1.0
    ping_interval: float = 5.0
    silence: float = 3.0
    retry: float = 0.5
    open_timeout: float = 5.0
    close_timeout: float = 1.0
    batch_interval: float = 10.0
    post_timeout: float = 10.0
    retry_max: float = 10.0


@dataclass
class Config:
    run_id: str
    mode: str
    generation: int
    end_wall: float
    routes: list[str]
    urls: dict[str, str]
    headers: dict[str, dict[str, str]]
    recorder: str = RECORDER
    log_dir: str = "/x1/data"
    blocked: list[tuple[str, str, dict[str, str]]] = field(default_factory=list)
    extra: dict[str, object] = field(default_factory=dict)


def wall_ms() -> float:
    return round(time.time() * 1000, 3)


def mono_ms() -> float:
    return round(time.monotonic() * 1000, 3)


def boot_id() -> str:
    try:
        with open("/proc/sys/kernel/random/boot_id") as fh:
            return fh.read().strip().replace("-", "")[:8]
    except OSError:
        return "00000000"


def config_from_env(env: dict[str, str]) -> Config:
    """The run's settings from the environment ComputerDO gives the container."""
    routes = [r for r in env.get("X1_ROUTES", "").split(",") if r in ROUTES]
    urls = {
        r: env.get(f"X1_URL_{r.upper()}", f"ws://{host}/x1/echo")
        for r, host in INTERNAL_HOSTS.items()
    }
    headers: dict[str, dict[str, str]] = {r: {} for r in ROUTES}
    blocked = [
        (r, f"http://{INTERNAL_HOSTS[r]}/x1/blocked", {}) for r in ("p1", "p2", "p6") if r in routes
    ]
    if "p4" in routes or "p5" in routes:
        access = {
            "CF-Access-Client-Id": env.get("X1_ACCESS_CLIENT_ID", ""),
            "CF-Access-Client-Secret": env.get("X1_ACCESS_CLIENT_SECRET", ""),
        }
        urls["p4"] = env.get("X1_P4_URL", "")
        urls["p5"] = env.get("X1_P5_URL", "")
        headers["p4"] = dict(access)
        headers["p5"] = {**access, CREDENTIAL_HEADER: env.get("X1_ROUTE_CREDENTIAL", "")}
        if "p5" in routes and urls["p5"].startswith("wss://"):
            base = "https://" + urls["p5"][len("wss://") :].split("/", 1)[0]
            blocked.append(("p5", f"{base}/x1/blocked", headers["p5"]))
            bad = {**access, CREDENTIAL_HEADER: "c1.0." + "0" * 64}
            blocked.append(("p5-badcred", f"{base}/x1/echo", bad))
    return Config(
        run_id=env.get("X1_RUN_ID", "run-local"),
        mode=env.get("X1_MODE", "run"),
        generation=int(env.get("X1_GENERATION", "0")),
        end_wall=float(env.get("X1_END", "0")),
        routes=routes,
        urls=urls,
        headers=headers,
        recorder=env.get("X1_RECORDER_URL", RECORDER),
        log_dir=env.get("X1_LOG_DIR", "/x1/data"),
        blocked=blocked,
        extra={
            k: env.get(v)
            for k, v in (
                ("t0", "X1_T0"),
                ("soakStart", "X1_SOAK_START"),
                ("soakEnd", "X1_SOAK_END"),
            )
        },
    )


class Log:
    """The local JSON Lines log, and the lines waiting for the next batch. Used from the event
    loop's thread only. After the final cut, events go to the local file only."""

    def __init__(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        self.fh = path.open("a", buffering=1)
        self.pending: list[str] = []
        self.closed = False
        self.total = 0

    def event(self, ev: str, **fields: object) -> dict:
        record = {"ev": ev, "wall": wall_ms(), "mono": mono_ms(), **fields}
        line = json.dumps(record, separators=(",", ":"))
        self.fh.write(line + "\n")
        if not self.closed:
            self.pending.append(line)
            self.total += 1
        return record

    def take(self) -> list[str]:
        lines, self.pending = self.pending, []
        return lines


def http_post(url: str, body: bytes, timeout: float) -> tuple[bool, str]:
    request = urllib.request.Request(url, data=body, method="POST")
    request.add_header("content-type", "application/x-ndjson")
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:  # noqa: S310 - fixed scheme
            return 200 <= response.status < 300, str(response.status)
    except urllib.error.HTTPError as error:
        return False, str(error.code)
    except Exception as error:  # noqa: BLE001 - every failure is retried
        return False, type(error).__name__


class Batcher:
    """Numbered batches every batch_interval, sent in order, each retried until stored."""

    def __init__(
        self,
        log: Log,
        config: Config,
        instance: str,
        params: Params,
        post: Callable[[str, bytes, float], tuple[bool, str]] = http_post,
        start: dict | None = None,
    ) -> None:
        self.log = log
        self.config = config
        self.instance = instance
        self.params = params
        self.post = post
        self.queue: list[tuple[int, bytes]] = []
        self.wake = asyncio.Event()
        self.number = 0
        self.stored = 0
        self.events = 0
        # The span each batch accounts for runs from the previous cut (the first from the probe's
        # start) to its own cut, so the analysis can tell which time a missing batch held.
        self.span_from = start or {"wall": wall_ms(), "mono": mono_ms()}

    def cut(self) -> int:
        lines = self.log.take()
        cut = {"wall": wall_ms(), "mono": mono_ms()}
        self.number += 1
        self.events += len(lines)
        header = {
            "batch": self.number,
            "instance": self.instance,
            "runId": self.config.run_id,
            "events": len(lines),
            "fromWall": self.span_from["wall"],
            "fromMono": self.span_from["mono"],
            "cutWall": cut["wall"],
            "cutMono": cut["mono"],
        }
        self.span_from = cut
        body = "\n".join([json.dumps(header, separators=(",", ":")), *lines]) + "\n"
        self.queue.append((self.number, body.encode()))
        self.wake.set()
        return self.number

    async def cutter(self, stop: asyncio.Event) -> None:
        while not stop.is_set():
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(stop.wait(), self.params.batch_interval)
            if not stop.is_set():
                self.cut()

    async def deliver(self, path: str, body: bytes, what: str) -> None:
        url = f"{self.config.recorder}{path}"
        failures = 0
        while True:
            ok, detail = await asyncio.to_thread(self.post, url, body, self.params.post_timeout)
            if ok:
                return
            failures += 1
            self.log.event("batch-retry", what=what, failures=failures, detail=detail)
            await asyncio.sleep(
                min(self.params.retry_max, self.params.retry * 2 ** min(failures, 6))
            )

    async def sender(self) -> None:
        while True:
            if not self.queue:
                self.wake.clear()
                await self.wake.wait()
                continue
            n, body = self.queue[0]
            await self.deliver(
                f"/x1/batch/{self.config.run_id}/{self.instance}/{n}", body, f"batch {n}"
            )
            self.queue.pop(0)
            self.stored += 1

    async def finish(self, manifest: dict) -> None:
        """The final cut, every batch stored, then the manifest: the completion marker."""
        self.cut()
        self.log.closed = True
        while self.queue:
            await asyncio.sleep(0.05)
        body = json.dumps(
            {**manifest, "batches": self.number, "events": self.events, "instance": self.instance},
            separators=(",", ":"),
        ).encode()
        await self.deliver(f"/x1/manifest/{self.config.run_id}/{self.instance}", body, "manifest")


def sanitize_identity(value: object) -> dict | None:
    if not isinstance(value, dict):
        return None
    out = {}
    for key in IDENTITY_KEYS:
        item = value.get(key)
        if isinstance(item, (str, int)) and not isinstance(item, bool):
            out[key] = item[:40] if isinstance(item, str) else item
    return out


class RouteProbe:
    """One route's WebSocket, reconnected for the whole run."""

    def __init__(
        self,
        route: str,
        url: str,
        headers: dict[str, str],
        log: Log,
        stop: asyncio.Event,
        params: Params,
    ) -> None:
        self.route = route
        self.url = url
        self.headers = headers
        self.log = log
        self.stop = stop
        self.p = params
        self.seq = 0
        self.conn = 0
        self.attempts = 0
        self.closing: set[asyncio.Task] = set()

    def event(self, ev: str, **fields: object) -> None:
        self.log.event(ev, route=self.route, **fields)

    async def run(self) -> None:
        while not self.stop.is_set():
            try:
                ws = await self.attempt()
                if ws is not None:
                    await self.hold(ws)
                    continue  # after a drop, the first attempt is immediate
            except Exception as error:  # noqa: BLE001 - a probe bug must not end the route
                self.event("error", error=type(error).__name__)
            await self.pause(self.p.retry)

    async def pause(self, seconds: float) -> None:
        with contextlib.suppress(TimeoutError):
            await asyncio.wait_for(self.stop.wait(), seconds)

    async def attempt(self) -> ClientConnection | None:
        self.attempts += 1
        n = self.attempts
        started = time.monotonic()

        def took() -> float:
            return round((time.monotonic() - started) * 1000, 3)

        try:
            ws = await connect(
                self.url,
                additional_headers=self.headers,
                user_agent_header=None,
                compression=None,
                proxy=None,
                open_timeout=self.p.open_timeout,
                ping_interval=None,
                ping_timeout=None,
                close_timeout=self.p.close_timeout,
                max_size=1 << 16,
            )
        except InvalidStatus as error:
            self.event(
                "attempt",
                n=n,
                ok=False,
                ms=took(),
                status=error.response.status_code,
                error="InvalidStatus",
            )
            return None
        except Exception as error:  # noqa: BLE001 - recorded by type only: messages may hold URLs
            self.event("attempt", n=n, ok=False, ms=took(), error=type(error).__name__)
            return None
        self.conn += 1
        self.event("attempt", n=n, ok=True, ms=took(), conn=self.conn)
        self.event("open", conn=self.conn, attempt=n)
        return ws

    async def hold(self, ws: ClientConnection) -> None:
        conn = self.conn
        p = self.p
        outstanding: dict[int, float] = {}
        missed: set[int] = set()
        replied: set[int] = set()
        state: dict[str, object] = {"ident": None}
        opened = time.monotonic()
        last_frame = opened
        next_send = opened
        close_code = 1000
        recv: asyncio.Future = asyncio.ensure_future(ws.recv())
        stopper = asyncio.ensure_future(self.stop.wait())
        pongs: set[asyncio.Task] = set()
        pinger = asyncio.create_task(self.pings(ws, conn, pongs))
        try:
            while True:
                now = time.monotonic()
                for seq, sent in outstanding.items():
                    if seq not in missed and now >= sent + p.deadline:
                        missed.add(seq)
                        self.event("miss", conn=conn, seq=seq)
                if outstanding and now - last_frame >= p.silence:
                    self.event(
                        "silence",
                        conn=conn,
                        quietMs=round((now - last_frame) * 1000, 3),
                        outstanding=len(outstanding),
                    )
                    self.event("close", conn=conn, by="silence", code=SILENCE_CODE)
                    self.finish_misses(conn, outstanding, missed)
                    close_code = SILENCE_CODE
                    return
                if self.stop.is_set():
                    await self.drain(ws, conn, recv, outstanding, missed, replied, state)
                    return
                if now >= next_send:
                    self.seq += 1
                    outstanding[self.seq] = now
                    self.event("send", conn=conn, seq=self.seq)
                    message = {
                        "t": "echo",
                        "route": self.route,
                        "conn": conn,
                        "seq": self.seq,
                        "sent": wall_ms(),
                    }
                    with contextlib.suppress(ConnectionClosed):
                        await ws.send(json.dumps(message, separators=(",", ":")))
                    next_send += p.echo_interval
                    if next_send <= now:
                        next_send = now + p.echo_interval
                wake = [next_send]
                wake += [s + p.deadline for q, s in outstanding.items() if q not in missed]
                if outstanding:
                    wake.append(last_frame + p.silence)
                timeout = max(0.0, min(wake) - time.monotonic())
                done, _ = await asyncio.wait(
                    {recv, stopper}, timeout=timeout, return_when=asyncio.FIRST_COMPLETED
                )
                if recv in done:
                    try:
                        message = recv.result()
                    except ConnectionClosed as error:
                        self.closed(conn, error)
                        self.finish_misses(conn, outstanding, missed)
                        return
                    except Exception as error:  # noqa: BLE001 - a transport error ends the connection
                        self.event(
                            "close", conn=conn, by="error", code=1006, error=type(error).__name__
                        )
                        self.finish_misses(conn, outstanding, missed)
                        return
                    last_frame = time.monotonic()
                    self.on_message(conn, message, outstanding, missed, replied, state)
                    recv = asyncio.ensure_future(ws.recv())
        finally:
            for task in (recv, stopper, pinger, *pongs):
                task.cancel()
            # The closing handshake runs in the background, so the reconnect is not delayed by a
            # peer that never answers it (close_timeout bounds it).
            task = asyncio.create_task(self.close_quietly(ws, close_code))
            self.closing.add(task)
            task.add_done_callback(self.closing.discard)

    async def close_quietly(self, ws: ClientConnection, code: int) -> None:
        with contextlib.suppress(Exception):
            await asyncio.wait_for(ws.close(code, "x1"), timeout=self.p.close_timeout + 0.5)

    def closed(self, conn: int, error: ConnectionClosed) -> None:
        if error.rcvd is not None:
            self.event(
                "close", conn=conn, by="peer", code=error.rcvd.code, reason=error.rcvd.reason[:120]
            )
        else:
            self.event("close", conn=conn, by="error", code=1006, error=type(error).__name__)

    def finish_misses(self, conn: int, outstanding: dict[int, float], missed: set[int]) -> None:
        """After a close no reply can come: every unanswered echo misses its deadline."""
        for seq, sent in outstanding.items():
            if seq not in missed:
                missed.add(seq)
                self.event(
                    "miss",
                    conn=conn,
                    seq=seq,
                    afterClose=True,
                    deadlineMono=round((sent + self.p.deadline) * 1000, 3),
                )

    def on_message(
        self,
        conn: int,
        message: object,
        outstanding: dict[int, float],
        missed: set[int],
        replied: set[int],
        state: dict[str, object],
    ) -> None:
        now = time.monotonic()
        try:
            data = json.loads(message) if isinstance(message, str) else None
        except ValueError:
            data = None
        size = len(message) if isinstance(message, (str, bytes)) else 0
        if (
            not isinstance(data, dict)
            or data.get("t") != "echo"
            or type(data.get("seq")) is not int
        ):
            self.event("unexpected", conn=conn, size=size, why="not an echo")
            return
        seq = data["seq"]
        if data.get("route") != self.route or data.get("conn") != conn:
            self.event(
                "unexpected", conn=conn, seq=seq, size=size, why="another route or connection"
            )
            return
        if seq in outstanding:
            sent = outstanding.pop(seq)
            rtt = round((now - sent) * 1000, 3)
            replied.add(seq)
            self.event("reply", conn=conn, seq=seq, rtt=rtt, late=rtt > self.p.deadline * 1000)
            identity = sanitize_identity(data.get("id"))
            if identity != state["ident"]:
                state["ident"] = identity
                self.event("ident", conn=conn, id=identity)
        elif seq in replied:
            self.event("duplicate", conn=conn, seq=seq)
        else:
            self.event("unexpected", conn=conn, seq=seq, size=size, why="unknown sequence number")

    async def drain(
        self,
        ws: ClientConnection,
        conn: int,
        recv: asyncio.Future,
        outstanding: dict[int, float],
        missed: set[int],
        replied: set[int],
        state: dict[str, object],
    ) -> None:
        """The run's end: wait up to one deadline for outstanding replies, then close."""
        until = time.monotonic() + self.p.deadline
        while outstanding and time.monotonic() < until:
            done, _ = await asyncio.wait({recv}, timeout=max(0.0, until - time.monotonic()))
            if recv not in done:
                break
            try:
                message = recv.result()
            except Exception:  # noqa: BLE001 - the connection ended during the drain
                break
            self.on_message(conn, message, outstanding, missed, replied, state)
            recv = asyncio.ensure_future(ws.recv())
        recv.cancel()
        self.finish_misses(conn, outstanding, missed)
        self.event("close", conn=conn, by="end", code=1000)

    async def pings(self, ws: ClientConnection, conn: int, pongs: set[asyncio.Task]) -> None:
        n = 0
        while True:
            await asyncio.sleep(self.p.ping_interval)
            n += 1
            sent = time.monotonic()
            try:
                waiter = await ws.ping()
            except Exception:  # noqa: BLE001 - the connection is closing
                return
            self.event("ping", conn=conn, n=n)
            task = asyncio.create_task(self.pong(waiter, conn, n, sent))
            pongs.add(task)
            task.add_done_callback(pongs.discard)

    async def pong(self, waiter: asyncio.Future, conn: int, n: int, sent: float) -> None:
        try:
            await asyncio.wait_for(waiter, timeout=self.p.ping_interval)
        except TimeoutError:
            self.event("pong-missing", conn=conn, n=n)
            return
        except Exception:  # noqa: BLE001 - the connection closed before the pong
            return
        self.event("pong", conn=conn, n=n, rtt=round((time.monotonic() - sent) * 1000, 3))


def http_get(
    url: str, headers: dict[str, str], timeout: float
) -> tuple[int | None, str | None, str | None]:
    """Status and the refusing hop's header of one GET, or the error type."""
    request = urllib.request.Request(url, method="GET", headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:  # noqa: S310 - fixed schemes
            return response.status, response.headers.get("x-x1-refused-by"), None
    except urllib.error.HTTPError as error:
        return error.code, error.headers.get("x-x1-refused-by"), None
    except Exception as error:  # noqa: BLE001 - recorded by type only
        return None, None, type(error).__name__


async def blocked_checks(
    config: Config,
    log: Log,
    get: Callable[
        [str, dict[str, str], float], tuple[int | None, str | None, str | None]
    ] = http_get,
    tries: int = 5,
    pause: float = 2.0,
) -> None:
    """Section 7's check: each policy point refuses GET /x1/blocked with 403 and names itself.
    P5 is also asked with a wrong route credential."""
    for target, url, headers in config.blocked:
        for attempt in range(1, tries + 1):
            status, hop, error = await asyncio.to_thread(get, url, headers, 10.0)
            if status is not None or attempt == tries:
                log.event(
                    "blocked-check",
                    target=target,
                    status=status,
                    refusedBy=hop,
                    error=error,
                    tries=attempt,
                )
                break
            await asyncio.sleep(pause)


async def wait_until(end_wall: float, stop: asyncio.Event) -> None:
    while time.time() * 1000 < end_wall and not stop.is_set():
        await asyncio.sleep(min(0.5, max(0.0, end_wall - time.time() * 1000) / 1000))


async def run_probe(
    config: Config,
    params: Params | None = None,
    post: Callable[[str, bytes, float], tuple[bool, str]] = http_post,
    instance: str | None = None,
    idle: bool = True,
) -> dict:
    params = params or Params()
    boot = boot_id()
    instance = instance or f"g{config.generation}-{boot}-{secrets.token_hex(3)}"
    log = Log(Path(config.log_dir) / f"probe-{instance}.jsonl")
    started = log.event(
        "probe-start",
        instance=instance,
        runId=config.run_id,
        mode=config.mode,
        generation=config.generation,
        boot=boot,
        routes=config.routes,
        end=config.end_wall,
        params=params.__dict__,
        **config.extra,
    )
    batcher = Batcher(log, config, instance, params, post, start=started)
    stop = asyncio.Event()
    background = [asyncio.create_task(batcher.cutter(stop)), asyncio.create_task(batcher.sender())]
    probes = []
    if time.time() * 1000 >= config.end_wall:
        log.event("late-start", end=config.end_wall)
    else:
        background.append(asyncio.create_task(blocked_checks(config, log)))
        for route in config.routes:
            probe = RouteProbe(
                route, config.urls[route], config.headers.get(route, {}), log, stop, params
            )
            probes.append(asyncio.create_task(probe.run(), name=route))
        await wait_until(config.end_wall, stop)
    stop.set()
    if probes:
        # A route in the middle of a connection attempt notices the stop when it ends.
        _, late = await asyncio.wait(probes, timeout=params.open_timeout + params.deadline + 1.0)
        for task in late:
            task.cancel()
    log.event("end", reason="schedule")
    background[0].cancel()
    await batcher.finish(
        {
            "runId": config.run_id,
            "generation": config.generation,
            "boot": boot,
            "routes": config.routes,
        }
    )
    for task in background:
        task.cancel()
    manifest = {"instance": instance, "batches": batcher.number, "events": batcher.events}
    if idle:
        await asyncio.Event().wait()  # RunDO stops the container once it sees the manifest
    return manifest


def main() -> None:
    asyncio.run(run_probe(config_from_env(dict(os.environ))))


if __name__ == "__main__":
    main()
