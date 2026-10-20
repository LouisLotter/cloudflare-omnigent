"""X1 probe: one process holding six WebSockets, one per route, independently (pre-registration
section 4, with Amendments 1 to 3).

- Echo: an application message every 1.0 s per route (route, connection number, sequence number,
  send time). The deadline is 1.0 s after sending.
- Protocol ping every 5 s per route. Pong round trips are recorded separately and never count as
  echo replies: an intermediate hop may answer pings itself.
- Silence deadline: if no application frame arrives for 3.0 s while echoes are outstanding, the
  probe closes the socket with code 4000 and reconnects.
- Drops (Amendment 3, item 3): a drop's moment is when the close frame arrives (seen at the
  protocol layer, not when TCP shutdown completes), the transport error, or the silence deadline.
  Every connection ends with exactly one close record. The old connection's shutdown finishes in
  the background.
- Reconnect (Amendment 3, item 4): after an established connection (one with an echo answered on
  it) drops, the first attempt is immediate. After a failed attempt or a failed open, the probe
  waits 0.5 s. Every attempt is recorded with its result and duration.
- Clock (Amendment 3, item 2): everything is timed on the monotonic clock and mapped to wall time
  with one offset fixed at the start; the stop time uses the mapping too. Every minute the probe
  records the live wall clock against the mapping, and its skew against the Worker's clock from
  P3's echoes.
- Records: every event goes to a local JSON Lines log. No headers, tokens, URLs or bodies other
  than the echo's own fields are recorded.
- Batches: the log is cut into numbered batches every 10 s and posted to rec.x1.internal, each
  retried until stored (from 0.5 s, doubling to 10 s). At the end the probe writes a manifest with
  the batch count, its completion marker, and then idles until RunDO stops the container.

P1, P2, P3 and P6 are intercepted virtual hosts. P4 and P5 go over the internet with the
F7-staging service token, and P5 also with the per-computer route credential.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import os
import secrets
import statistics
import time
import urllib.error
import urllib.request
from collections import deque
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path

from websockets.asyncio.client import ClientConnection, connect
from websockets.exceptions import ConnectionClosed, InvalidStatus
from websockets.frames import Close, Frame, Opcode

SILENCE_CODE = 4000
ROUTES = ("p1", "p2", "p3", "p4", "p5", "p6")
INTERNAL_HOSTS = {r: f"{r}.x1.internal" for r in ("p1", "p2", "p3", "p6")}
RECORDER = "http://rec.x1.internal"
CREDENTIAL_HEADER = "x-x1-route-credential"
SKEW_ROUTE = "p3"
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
    """Section 4's timings. open_timeout, close_timeout and the batch retry back-off are the
    ones Amendment 1, item 10 records."""

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
    clock_interval: float = 60.0


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


class Clock:
    """The monotonic clock, mapped to wall time with one offset fixed at the probe's start."""

    def __init__(self) -> None:
        self.reset()

    def reset(self) -> None:
        self.offset = time.time() * 1000 - time.monotonic() * 1000

    def mono(self) -> float:
        return round(time.monotonic() * 1000, 3)

    def wall(self, mono: float | None = None) -> float:
        return round((self.mono() if mono is None else mono) + self.offset, 3)


CLOCK = Clock()


def wall_ms() -> float:
    """Wall time from the fixed mapping, never the live wall clock."""
    return CLOCK.wall()


def mono_ms() -> float:
    return CLOCK.mono()


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

    def event(self, ev: str, at_mono: float | None = None, **fields: object) -> dict:
        """One record, timed `at_mono` (when the thing happened) or now. A record timed earlier
        than it is written also carries loggedMono, the moment it was written: a batch cut can
        fall between the two, and the batch's span holds the moment of writing."""
        now = mono_ms()
        mono = now if at_mono is None else at_mono
        record = {"ev": ev, "wall": CLOCK.wall(mono), "mono": mono, **fields}
        if at_mono is not None and at_mono != now:
            record["loggedMono"] = now
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


def backoff_s(failures: int, params: Params) -> float:
    """The wait after the n-th failed delivery: 0.5 s, 1 s, 2 s, ... up to 10 s."""
    return min(params.retry_max, params.retry * 2 ** min(failures - 1, 10))


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
        self.conflicts: list[int] = []
        # The span each batch accounts for runs from the previous cut (the first from the probe's
        # start) to its own cut, so the analysis can tell which time a missing batch held.
        self.span_from = start or {"wall": wall_ms(), "mono": mono_ms()}

    def cut(self) -> int:
        lines = self.log.take()
        mono = mono_ms()
        cut = {"wall": CLOCK.wall(mono), "mono": mono}
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

    async def deliver(self, path: str, body: bytes, what: str) -> bool:
        """Retries until the recorder stores the body or already holds it. A 409 means it holds
        a different body under this name: that is recorded and not retried."""
        url = f"{self.config.recorder}{path}"
        failures = 0
        while True:
            ok, detail = await asyncio.to_thread(self.post, url, body, self.params.post_timeout)
            if ok:
                return True
            if detail == "409":
                self.log.event("batch-conflict", what=what)
                return False
            failures += 1
            self.log.event("batch-retry", what=what, failures=failures, detail=detail)
            await asyncio.sleep(backoff_s(failures, self.params))

    async def sender(self) -> None:
        while True:
            if not self.queue:
                self.wake.clear()
                await self.wake.wait()
                continue
            n, body = self.queue[0]
            stored = await self.deliver(
                f"/x1/batch/{self.config.run_id}/{self.instance}/{n}", body, f"batch {n}"
            )
            self.queue.pop(0)
            if stored:
                self.stored += 1
            else:
                # The recorder holds another body under this batch's name: never counted as
                # stored, and named in the manifest (review r2, finding 3).
                self.conflicts.append(n)

    async def finish(self, manifest: dict) -> bool:
        """The final cut, every batch delivered, then the manifest: the completion marker. The
        manifest lists every batch the recorder refused as a conflict. If the manifest itself
        conflicts, a failure record takes its place. Returns whether the manifest was stored."""
        self.cut()
        self.log.closed = True
        while self.queue:
            await asyncio.sleep(0.05)
        record = {
            **manifest,
            "runId": self.config.run_id,
            "instance": self.instance,
            "batches": self.number,
            "events": self.events,
            "conflicts": sorted(self.conflicts),
        }
        body = json.dumps(record, separators=(",", ":")).encode()
        path = f"/x1/manifest/{self.config.run_id}/{self.instance}"
        if await self.deliver(path, body, "manifest"):
            return True
        failure = {**record, "failure": "manifest conflict"}
        await self.deliver(
            f"/x1/failure/{self.config.run_id}/{self.instance}",
            json.dumps(failure, separators=(",", ":")).encode(),
            "failure record",
        )
        return False


def sanitize_identity(value: object) -> dict | None:
    if not isinstance(value, dict):
        return None
    out = {}
    for key in IDENTITY_KEYS:
        item = value.get(key)
        if isinstance(item, (str, int)) and not isinstance(item, bool):
            out[key] = item[:40] if isinstance(item, str) else item
    return out


class SkewMeter:
    """Samples of the Worker's clock against the probe's mapped wall time, from P3's echoes: the
    Worker's time minus the midpoint of send and receive."""

    def __init__(self) -> None:
        self.samples: list[float] = []

    def add(self, worker_ms: float, sent_wall: float, received_wall: float) -> None:
        self.samples.append(worker_ms - (sent_wall + received_wall) / 2)

    def take(self) -> list[float]:
        samples, self.samples = self.samples, []
        return samples


async def clock_watch(log: Log, skew: SkewMeter, params: Params, stop: asyncio.Event) -> None:
    """Every minute: the live wall clock against the fixed mapping, and the skew median."""
    while True:
        live = time.time() * 1000
        mono = mono_ms()
        log.event(
            "clock",
            at_mono=mono,
            liveWall=round(live, 3),
            driftMs=round(live - CLOCK.wall(mono), 3),
        )
        samples = skew.take()
        log.event(
            "skew",
            route=SKEW_ROUTE,
            n=len(samples),
            medianMs=round(statistics.median(samples), 3) if samples else None,
        )
        if stop.is_set():
            return
        with contextlib.suppress(TimeoutError):
            await asyncio.wait_for(stop.wait(), params.clock_interval)


DATA_OPCODES = (Opcode.TEXT, Opcode.BINARY, Opcode.CONT)


class ProbeConnection(ClientConnection):
    """The pinned websockets client connection, read at the protocol layer, frame by frame in
    the order the frames arrive:

    - application messages go to `inbox` with their arrival time (monotonic seconds), and never
      to the library's receive queue, so recv() only ever reports the connection's end;
    - a close frame's arrival is noted in `close_frame_seen` (monotonic ms), because recv()
      raises only once TCP shutdown completes, which can be much later (review r1, finding 2).

    An echo that arrives in the same read as a close frame is therefore in `inbox` before the
    close is noted, and hold() takes it first (review r2, finding 1)."""

    close_frame_seen: tuple[int | None, str, float] | None = None
    # When the handshake's response arrived: the open is recorded at this moment, so that a
    # close frame arriving right behind it is never recorded before the open.
    opened_mono: float | None = None

    def __init__(self, *args: object, **kwargs: object) -> None:
        super().__init__(*args, **kwargs)  # type: ignore[arg-type]
        self.inbox: deque[tuple[float, str | bytes]] = deque()
        self.arrived = asyncio.Event()  # set by every message and by the close frame
        self.fragments: list[bytes] = []
        self.fragment_opcode: Opcode | None = None

    def process_event(self, event: object) -> None:
        if not isinstance(event, Frame):
            if self.opened_mono is None:
                self.opened_mono = mono_ms()
            super().process_event(event)  # type: ignore[arg-type]
            return
        if event.opcode in DATA_OPCODES:
            if event.opcode is not Opcode.CONT:
                self.fragment_opcode, self.fragments = event.opcode, []
            self.fragments.append(bytes(event.data))
            if event.fin:
                data = b"".join(self.fragments)
                text = self.fragment_opcode is Opcode.TEXT
                message = data.decode("utf-8", errors="replace") if text else data
                self.inbox.append((time.monotonic(), message))
                self.arrived.set()
            return
        if event.opcode is Opcode.CLOSE and self.close_frame_seen is None:
            at = mono_ms()
            try:
                close = Close.parse(bytes(event.data))
                code, reason = close.code, close.reason
            except Exception:  # noqa: BLE001 - the protocol layer rejects it on its own
                code, reason = None, ""
            self.close_frame_seen = (code, reason, at)
            self.arrived.set()
        super().process_event(event)  # type: ignore[arg-type]


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
        skew: SkewMeter | None = None,
    ) -> None:
        self.route = route
        self.url = url
        self.headers = headers
        self.log = log
        self.stop = stop
        self.p = params
        self.skew = skew
        self.seq = 0
        self.conn = 0
        self.attempts = 0
        self.closing: set[asyncio.Task] = set()

    def event(self, ev: str, at_mono: float | None = None, **fields: object) -> None:
        self.log.event(ev, at_mono=at_mono, route=self.route, **fields)

    async def run(self) -> None:
        while not self.stop.is_set():
            established = False
            try:
                ws = await self.attempt()
                if ws is not None:
                    established = await self.hold(ws)
            except Exception as error:  # noqa: BLE001 - a probe bug must not end the route
                self.event("error", error=type(error).__name__)
            if established:
                continue  # an established connection dropped: the first attempt is immediate
            await self.pause(self.p.retry)  # after a failed attempt or a failed open

    async def pause(self, seconds: float) -> None:
        with contextlib.suppress(TimeoutError):
            await asyncio.wait_for(self.stop.wait(), seconds)

    async def attempt(self) -> ProbeConnection | None:
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
                create_connection=ProbeConnection,
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
        self.event("open", at_mono=getattr(ws, "opened_mono", None), conn=self.conn, attempt=n)
        return ws  # type: ignore[return-value]

    async def hold(self, ws: ProbeConnection) -> bool:
        """Holds one connection until it ends, records exactly one close for it, and says whether
        an echo was answered on it (an established connection) or not (a failed open).

        Each pass first takes the messages that have arrived, in arrival order and with their
        arrival times, and only then looks at how the connection may have ended: a close frame
        (timed when it arrived), the end of the transport, the silence deadline or the run's
        end. So an echo answered just before a close frame counts."""
        conn = self.conn
        p = self.p
        state = HoldState()
        opened = time.monotonic()
        last_frame = opened
        next_send = opened
        close_code = 1000
        # recv() never returns a message here (ProbeConnection keeps them): it only reports the
        # connection's end, once the transport has ended.
        recv: asyncio.Future = asyncio.ensure_future(ws.recv())
        arrived = asyncio.ensure_future(ws.arrived.wait())
        stopper = asyncio.ensure_future(self.stop.wait())
        pongs: set[asyncio.Task] = set()
        pinger = asyncio.create_task(self.pings(ws, conn, pongs))
        transport_end: tuple[str, int, dict] | None = None

        def end(by: str, code: int | None, at: float | None = None, **extra: object) -> None:
            if state.terminal:
                return
            state.terminal = True
            self.event("close", at_mono=at, conn=conn, by=by, code=code, **extra)
            self.finish_misses(conn, state)

        try:
            while True:
                # 1. Messages, in the order they arrived.
                while ws.inbox:
                    at, message = ws.inbox.popleft()
                    last_frame = max(last_frame, at)
                    self.on_message(conn, message, state, at)
                # 2. How the connection ended, if it has.
                if ws.close_frame_seen is not None:
                    code, reason, at_ms = ws.close_frame_seen
                    end("peer", code, at=at_ms, reason=reason[:120])
                    return state.answered
                if transport_end is not None:
                    by, code, extra = transport_end
                    end(by, code, **extra)
                    return state.answered
                now = time.monotonic()
                for seq, sent in state.outstanding.items():
                    if seq not in state.missed and now >= sent + p.deadline:
                        state.missed.add(seq)
                        self.event("miss", conn=conn, seq=seq)
                if state.outstanding and now - last_frame >= p.silence:
                    self.event(
                        "silence",
                        conn=conn,
                        quietMs=round((now - last_frame) * 1000, 3),
                        outstanding=len(state.outstanding),
                    )
                    close_code = SILENCE_CODE
                    end("silence", SILENCE_CODE)
                    return state.answered
                if self.stop.is_set():
                    await self.drain(ws, conn, state)
                    end("end", 1000)
                    return state.answered
                # 3. The next echo, when it is due.
                if now >= next_send:
                    self.seq += 1
                    state.outstanding[self.seq] = now
                    send_mono = mono_ms()
                    state.sent_wall[self.seq] = CLOCK.wall(send_mono)
                    self.event("send", at_mono=send_mono, conn=conn, seq=self.seq)
                    message = {
                        "t": "echo",
                        "route": self.route,
                        "conn": conn,
                        "seq": self.seq,
                        "sent": state.sent_wall[self.seq],
                    }
                    with contextlib.suppress(ConnectionClosed):
                        await ws.send(json.dumps(message, separators=(",", ":")))
                    next_send += p.echo_interval
                    if next_send <= now:
                        next_send = now + p.echo_interval
                    continue  # look again at once: the send may have let a frame in
                # 4. Wait for a frame, the transport's end, the run's end or the next deadline.
                wake = [next_send]
                wake += [
                    s + p.deadline for q, s in state.outstanding.items() if q not in state.missed
                ]
                if state.outstanding:
                    wake.append(last_frame + p.silence)
                timeout = max(0.0, min(wake) - time.monotonic())
                done, _ = await asyncio.wait(
                    {recv, arrived, stopper},
                    timeout=timeout,
                    return_when=asyncio.FIRST_COMPLETED,
                )
                if arrived in done:
                    ws.arrived.clear()
                    arrived = asyncio.ensure_future(ws.arrived.wait())
                if recv in done:
                    transport_end = self.transport_end(recv)
        except asyncio.CancelledError:
            end("end", 1000, reason="cancelled")
            raise
        except Exception as error:  # noqa: BLE001 - a probe bug still ends the connection on record
            end("error", 1006, error=type(error).__name__)
            return state.answered
        finally:
            for task in (recv, arrived, stopper, pinger, *pongs):
                task.cancel()
            # The closing handshake runs in the background, so the reconnect is not delayed by a
            # peer that never completes it (close_timeout bounds it).
            task = asyncio.create_task(self.close_quietly(ws, close_code))
            self.closing.add(task)
            task.add_done_callback(self.closing.discard)

    @staticmethod
    def transport_end(recv: asyncio.Future) -> tuple[str, int, dict]:
        """How the connection ended, from recv()'s outcome. The next pass still takes any
        message that arrived first."""
        try:
            recv.result()
        except ConnectionClosed as error:
            if error.rcvd is not None:
                return "peer", error.rcvd.code, {"reason": error.rcvd.reason[:120]}
            return "error", 1006, {"error": type(error).__name__}
        except Exception as error:  # noqa: BLE001 - a transport error ends the connection
            return "error", 1006, {"error": type(error).__name__}
        return "error", 1006, {"error": "UnexpectedMessage"}

    async def close_quietly(self, ws: ClientConnection, code: int) -> None:
        with contextlib.suppress(Exception):
            await asyncio.wait_for(ws.close(code, "x1"), timeout=self.p.close_timeout + 0.5)

    def finish_misses(self, conn: int, state: HoldState) -> None:
        """After a close no reply can come: every unanswered echo misses its deadline."""
        for seq, sent in state.outstanding.items():
            if seq not in state.missed:
                state.missed.add(seq)
                self.event(
                    "miss",
                    conn=conn,
                    seq=seq,
                    afterClose=True,
                    deadlineMono=round((sent + self.p.deadline) * 1000, 3),
                )

    def on_message(
        self, conn: int, message: object, state: HoldState, at: float | None = None
    ) -> None:
        """One application message, received at `at` (monotonic seconds; now if not given)."""
        now = time.monotonic() if at is None else at
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
        if seq in state.outstanding:
            sent = state.outstanding.pop(seq)
            rtt = round((now - sent) * 1000, 3)
            on_time = rtt <= self.p.deadline * 1000
            state.replied.add(seq)
            state.answered = state.answered or on_time
            self.event(
                "reply", at_mono=round(now * 1000, 3), conn=conn, seq=seq, rtt=rtt, late=not on_time
            )
            worker_ms = data.get("at")
            if self.skew is not None and on_time and type(worker_ms) in (int, float):
                self.skew.add(float(worker_ms), state.sent_wall[seq], CLOCK.wall(now * 1000))
            identity = sanitize_identity(data.get("id"))
            if identity != state.ident:
                state.ident = identity
                self.event("ident", conn=conn, id=identity)
        elif seq in state.replied:
            self.event("duplicate", conn=conn, seq=seq)
        else:
            self.event("unexpected", conn=conn, seq=seq, size=size, why="unknown sequence number")

    async def drain(self, ws: ProbeConnection, conn: int, state: HoldState) -> None:
        """The run's end: wait up to one deadline for outstanding replies."""
        until = time.monotonic() + self.p.deadline
        while True:
            while ws.inbox:
                at, message = ws.inbox.popleft()
                self.on_message(conn, message, state, at)
            left = until - time.monotonic()
            if not state.outstanding or left <= 0 or ws.close_frame_seen is not None:
                return
            ws.arrived.clear()
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(ws.arrived.wait(), left)

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


@dataclass
class HoldState:
    """One connection's echoes while it is held."""

    outstanding: dict[int, float] = field(default_factory=dict)
    sent_wall: dict[int, float] = field(default_factory=dict)
    missed: set[int] = field(default_factory=set)
    replied: set[int] = field(default_factory=set)
    ident: dict | None = None
    answered: bool = False
    terminal: bool = False


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
    """Until the mapped wall time reaches end_wall: a step of the live clock changes nothing."""
    while wall_ms() < end_wall and not stop.is_set():
        await asyncio.sleep(min(0.5, max(0.0, end_wall - wall_ms()) / 1000))


async def run_probe(
    config: Config,
    params: Params | None = None,
    post: Callable[[str, bytes, float], tuple[bool, str]] = http_post,
    instance: str | None = None,
    idle: bool = True,
) -> dict:
    params = params or Params()
    CLOCK.reset()
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
        clockOffset=round(CLOCK.offset, 3),
        params=params.__dict__,
        **config.extra,
    )
    batcher = Batcher(log, config, instance, params, post, start=started)
    stop = asyncio.Event()
    skew = SkewMeter()
    background = [asyncio.create_task(batcher.cutter(stop)), asyncio.create_task(batcher.sender())]
    watch = asyncio.create_task(clock_watch(log, skew, params, stop))
    probes = []
    if wall_ms() >= config.end_wall:
        log.event("late-start", end=config.end_wall)
    else:
        background.append(asyncio.create_task(blocked_checks(config, log)))
        for route in config.routes:
            probe = RouteProbe(
                route,
                config.urls[route],
                config.headers.get(route, {}),
                log,
                stop,
                params,
                skew if route == SKEW_ROUTE else None,
            )
            probes.append(asyncio.create_task(probe.run(), name=route))
        await wait_until(config.end_wall, stop)
    stop.set()
    if probes:
        # A route in the middle of a connection attempt notices the stop when it ends.
        _, late = await asyncio.wait(probes, timeout=params.open_timeout + params.deadline + 1.0)
        for task in late:
            task.cancel()
        await asyncio.gather(*late, return_exceptions=True)
    await watch  # the last clock and skew records
    log.event("end", reason="schedule")
    background[0].cancel()
    stored = await batcher.finish(
        {"generation": config.generation, "boot": boot, "routes": config.routes}
    )
    for task in background:
        task.cancel()
    manifest = {
        "instance": instance,
        "batches": batcher.number,
        "events": batcher.events,
        "conflicts": sorted(batcher.conflicts),
        "manifestStored": stored,
    }
    if idle:
        await asyncio.Event().wait()  # RunDO stops the container once it sees the manifest
    return manifest


def main() -> None:
    asyncio.run(run_probe(config_from_env(dict(os.environ))))


if __name__ == "__main__":
    main()
