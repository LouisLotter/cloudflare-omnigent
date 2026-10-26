"""The staging measurement harness: the server image measured against real R2 (WP2.5).

It is the container's main process (``python -m cfo_drill harness``, PID 1) in a ``basic``
container that the harness Worker's Durable Object starts (``scripts/restore-drill/staging``).
It runs the server's own entrypoint as a child, drives it over localhost, and serves its
progress and results on port 8002, which only the Durable Object reaches. Nothing here talks
to Cloudflare except Litestream, through the replica settings it is given.

Measure mode runs the plan in order, each phase on its own replica prefix, and records a JSON
result per phase. Every number the evidence needs comes from here:

``drill``          canary changes through the real routes, the restore drill against R2, a
                   kill right after the last acknowledgement, an in-container replacement,
                   and the canaries checked through the routes (RC-03 against real R2);
``barrier-1s``,    the response and transcript barriers' waits with the sync interval at 1 s
``barrier-200ms``  and at 200 ms, from random-gap security writes and transcript items;
``idle-1s``,       a server left alone, so R2's Class A and B operation counts for the window
``idle-200ms``     can be read from R2's analytics afterwards;
``restore-100mb``, a database grown to size, its upload, a side restore, the loss of the
``restore-1000mb`` server, its replacement within the image's restore deadline, and the
                   re-snapshot window: how long after it is healthy nothing new is durable;
``cf-replacement`` canaries on the 1 GB server, then a wait for the Durable Object to kill the
                   container and start a new one (replaced mode), which restores from R2 and
                   checks them.

Replaced mode is that new container: it restores, measures, checks and reports. No result
holds a credential: canary checks carry labels and verdicts, drill reports carry digests.
"""

from __future__ import annotations

import contextlib
import json
import os
import random
import re
import shutil
import signal
import sqlite3
import subprocess
import sys
import threading
import time
import traceback
from collections import deque
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

import httpx

from cfo_drill import canaries, db, drill, filler, stats

STATUS_PORT = 8002
APP = "http://127.0.0.1:8000"
CONTROL = "http://127.0.0.1:8001"
DATA = Path("/data")
RUN = Path("/run/cfo")
RESULTS = Path(os.environ.get("DRILL_RESULTS", "/tmp/drill-results"))  # noqa: S108
ALL_PHASES = (
    "env",
    "drill",
    "barrier-1s",
    "barrier-200ms",
    "idle-1s",
    "idle-200ms",
    "restore-100mb",
    "restore-1000mb",
    "cf-replacement",
)
#: Environment names whose values are secrets: never in a result or a log line.
SECRET_NAMES = (
    "LITESTREAM_ACCESS_KEY_ID",
    "LITESTREAM_SECRET_ACCESS_KEY",
    "DRILL_OWNER_PASSWORD",
    "DRILL_COOKIE_SECRET",
)


def say(event: str, **fields: Any) -> None:
    """One progress line on stdout. Callers pass phases, counts and timings only."""
    print(json.dumps({"event": f"drill.{event}", "t": round(time.time(), 3), **fields}), flush=True)


@dataclass
class Settings:
    mode: str
    run_id: str
    phases: list[str]
    bucket: str
    endpoint: str
    region: str
    owner_password: str
    cookie_secret: str
    base_url: str
    barrier_writes: int
    barrier_items: int
    idle_s: float
    replaced_prefix: str | None
    replaced_manifest: str | None
    replaced_filler_rows: int | None

    @classmethod
    def from_env(cls, env: dict[str, str]) -> Settings:
        def need(name: str) -> str:
            value = env.get(name, "")
            if not value:
                raise SystemExit(f"{name} is required")
            return value

        plan = env.get("DRILL_PLAN", "all")
        phases = list(ALL_PHASES) if plan == "all" else [p for p in plan.split(",") if p]
        unknown = [p for p in phases if p not in ALL_PHASES and not p.startswith("restore-")]
        if unknown:
            raise SystemExit(f"unknown phases: {unknown}")
        need("LITESTREAM_ACCESS_KEY_ID")
        need("LITESTREAM_SECRET_ACCESS_KEY")
        rows = env.get("DRILL_REPLACED_FILLER_ROWS")
        return cls(
            mode=env.get("DRILL_MODE", "measure"),
            run_id=need("DRILL_RUN_ID"),
            phases=phases,
            bucket=need("DRILL_BUCKET"),
            endpoint=need("DRILL_ENDPOINT"),
            region=env.get("DRILL_REGION", "auto"),
            owner_password=need("DRILL_OWNER_PASSWORD"),
            cookie_secret=need("DRILL_COOKIE_SECRET"),
            base_url=env.get("DRILL_BASE_URL", "http://drill.invalid"),
            barrier_writes=int(env.get("DRILL_BARRIER_WRITES", "300")),
            barrier_items=int(env.get("DRILL_BARRIER_ITEMS", "150")),
            idle_s=float(env.get("DRILL_IDLE_S", "480")),
            replaced_prefix=env.get("DRILL_REPLACED_PREFIX") or None,
            replaced_manifest=env.get("DRILL_REPLACED_MANIFEST") or None,
            replaced_filler_rows=int(rows) if rows else None,
        )


class RecoveryMode(RuntimeError):
    """The server entered recovery mode instead of becoming healthy."""


# ── Processes ─────────────────────────────────────────────────────────────────────────────


def kill_everything_else() -> int:
    """SIGKILL every other process in the container: the server is lost at once, as when a
    container dies. Only as PID 1, so it can never run outside a container."""
    if os.getpid() != 1:
        raise RuntimeError("kill_everything_else runs only as the container's PID 1")
    killed = 0
    for entry in Path("/proc").iterdir():
        if entry.name.isdigit() and int(entry.name) != 1:
            with contextlib.suppress(ProcessLookupError, PermissionError):
                os.kill(int(entry.name), signal.SIGKILL)
                killed += 1
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        reap()
        alive = [e for e in Path("/proc").iterdir() if e.name.isdigit() and e.name != "1"]
        alive = [e for e in alive if not _zombie(e)]
        if not alive:
            break
        time.sleep(0.05)
    reap()
    return killed


def _zombie(entry: Path) -> bool:
    try:
        return (entry / "stat").read_text().split(") ", 1)[1].startswith("Z")
    except (OSError, IndexError):
        return True


def reap() -> None:
    while True:
        try:
            pid, _ = os.waitpid(-1, os.WNOHANG)
        except ChildProcessError:
            return
        if pid == 0:
            return


def wipe() -> None:
    """Remove the server's local state: the next server starts from the replica."""
    for path in (DATA, RUN):
        if path.exists():
            for child in path.iterdir():
                if child.is_dir():
                    shutil.rmtree(child, ignore_errors=True)
                else:
                    with contextlib.suppress(FileNotFoundError):
                        child.unlink()


def disk_usage() -> dict[str, int]:
    def size(path: Path) -> int:
        if path.is_file():
            return path.stat().st_size
        return sum(f.stat().st_size for f in path.rglob("*") if f.is_file()) if path.exists() else 0

    usage = shutil.disk_usage("/")
    return {
        "db_bytes": size(DATA / "omnigent.db"),
        "wal_bytes": size(DATA / "omnigent.db-wal"),
        "litestream_bytes": size(DATA / ".omnigent.db-litestream"),
        "disk_used_bytes": usage.used,
        "disk_total_bytes": usage.total,
    }


@dataclass
class Event:
    name: str
    fields: dict[str, Any]
    mono: float


@dataclass
class Server:
    """One run of the server image's own entrypoint, as a child of the harness."""

    settings: Settings
    prefix: str
    initialized: bool
    sync: str = "1s"
    response_timeout_s: float = 10.0
    transcript_timeout_s: float = 3.0
    restore_deadline_s: float = 300.0
    proc: subprocess.Popen[str] | None = None
    events: list[Event] = field(default_factory=list)
    tail: deque[str] = field(default_factory=lambda: deque(maxlen=40))
    #: (seconds since start, line) for the startup's own log lines, request logs left out.
    lines: list[tuple[float, str]] = field(default_factory=list)
    started_mono: float = 0.0

    @property
    def replica_url(self) -> str:
        return f"s3://{self.settings.bucket}/{self.settings.run_id}/{self.prefix}"

    def env(self) -> dict[str, str]:
        base = {k: v for k, v in os.environ.items() if not k.startswith("DRILL_")}
        base.update(
            {
                "CFO_INSTALLATION_INITIALIZED": "true" if self.initialized else "false",
                "CFO_REPLICA_URL": self.replica_url,
                "CFO_REPLICA_ENDPOINT": self.settings.endpoint,
                "CFO_REPLICA_REGION": self.settings.region,
                "CFO_SYNC_INTERVAL": self.sync,
                "CFO_RESPONSE_BARRIER_TIMEOUT_S": f"{self.response_timeout_s:g}",
                "CFO_TRANSCRIPT_BARRIER_TIMEOUT_S": f"{self.transcript_timeout_s:g}",
                "CFO_RESTORE_DEADLINE_S": f"{self.restore_deadline_s:g}",
                # The drill measures the database's durability and uploads no file; its
                # servers keep artifacts on disk, which the image allows for tests only.
                "CFO_ALLOW_LOCAL_ARTIFACTS": "true",
                "OMNIGENT_ACCOUNTS_BASE_URL": self.settings.base_url,
                "OMNIGENT_ACCOUNTS_COOKIE_SECRET": self.settings.cookie_secret,
                "OMNIGENT_ACCOUNTS_INIT_ADMIN_USERNAME": canaries.OWNER,
                "OMNIGENT_ACCOUNTS_INIT_ADMIN_PASSWORD": self.settings.owner_password,
            }
        )
        return base

    def start(self) -> Server:
        self.started_mono = time.monotonic()
        self.proc = subprocess.Popen(  # noqa: S603
            [sys.executable, "-m", "cfo_server.entrypoint"],
            env=self.env(),
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            start_new_session=True,
        )
        threading.Thread(target=self._read, daemon=True).start()
        return self

    def _read(self) -> None:
        assert self.proc is not None and self.proc.stdout is not None
        for line in self.proc.stdout:
            line = line.rstrip("\n")
            self.tail.append(_redact(line)[:400])
            if (
                len(self.lines) < MAX_STARTUP_LINES
                and line.strip()
                and not _REQUEST_LINE.search(line)
            ):
                self.lines.append(
                    (round(time.monotonic() - self.started_mono, 2), _redact(line)[:200])
                )
            if line.startswith("{"):
                try:
                    data = json.loads(line)
                except ValueError:
                    continue
                name = str(data.get("event", ""))
                if name.startswith("cfo."):
                    self.events.append(Event(name[4:], data, time.monotonic()))

    def of(self, name: str) -> list[dict[str, Any]]:
        return [e.fields for e in self.events if e.name == name]

    def status(self) -> dict[str, Any] | None:
        try:
            return httpx.get(f"{CONTROL}/status", timeout=10).json()
        except (httpx.HTTPError, ValueError):
            return None

    def wait_healthy(self, timeout_s: float) -> float:
        """Seconds from start to the first healthy answer; raises on recovery mode."""
        deadline = self.started_mono + timeout_s
        while time.monotonic() < deadline:
            if self.proc is not None and self.proc.poll() is not None:
                raise RuntimeError(f"the entrypoint exited with {self.proc.returncode}")
            with contextlib.suppress(httpx.HTTPError):
                if httpx.get(f"{APP}/health", timeout=5).status_code == 200:
                    return time.monotonic() - self.started_mono
            status = self.status()
            if status and status.get("phase") == "recovery":
                raise RecoveryMode(json.dumps(status.get("recovery")))
            time.sleep(0.25)
        raise TimeoutError(f"not healthy within {timeout_s:g} s")

    def position(self) -> dict[str, Any] | None:
        try:
            response = httpx.get(f"{CONTROL}/position", timeout=30)
        except httpx.HTTPError:
            return None
        return response.json() if response.status_code == 200 else None

    def wait_replicated(self, timeout_s: float) -> float:
        """Seconds until the replica holds the position current at the call."""
        started = time.monotonic()
        target: int | None = None
        while time.monotonic() - started < timeout_s:
            position = self.position()
            if position is not None:
                target = position["txid"] if target is None else target
                if position["replicatedTxid"] >= target:
                    return time.monotonic() - started
            time.sleep(0.25)
        raise TimeoutError(f"not replicated within {timeout_s:g} s")


MAX_STARTUP_LINES = 600
#: Request logs (uvicorn's access lines), left out of the startup timeline.
_REQUEST_LINE = re.compile(r'"(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) /')


class StartupProbe:
    """Where a server's start goes: resource samples every 5 s and Python stacks every 20 s.

    Reads /proc (CPU, including steal and iowait; load; memory; disk sectors; each server
    process's CPU time and state) and, when the container allows ptrace, ``py-spy dump`` of
    the app process. Stops at the first healthy answer. Holds no environment and no secret:
    process names, numbers and stack frames only.
    """

    SAMPLE_S = 5.0
    STACK_EVERY_S = 20.0

    def __init__(self, server: Server) -> None:
        self.server = server
        self.samples: list[dict[str, Any]] = []
        self.stacks: list[dict[str, Any]] = []
        self.stack_error: str | None = None
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, daemon=True)

    def start(self) -> StartupProbe:
        self._thread.start()
        return self

    def stop(self) -> dict[str, Any]:
        self._stop.set()
        self._thread.join(timeout=60)
        return {
            "samples": self.samples,
            "stacks": self.stacks,
            "stack_error": self.stack_error,
            "lines": [{"at_s": t, "line": line} for t, line in self.server.lines],
            "events": [
                {"event": e.name, "at_s": round(e.mono - self.server.started_mono, 2)}
                for e in self.server.events
                if e.name
                in ("boot", "restore", "database.ready", "started", "app.built", "recovery")
            ],
        }

    @staticmethod
    def _cpu() -> list[int]:
        fields = Path("/proc/stat").read_text().splitlines()[0].split()[1:]
        return [int(x) for x in fields]

    @staticmethod
    def _disk() -> tuple[int, int]:
        read = written = 0
        for line in Path("/proc/diskstats").read_text().splitlines():
            parts = line.split()
            if len(parts) > 9 and re.fullmatch(
                r"(vd|sd|xvd|nvme\d+n)[a-z0-9]*?[a-z]|nvme\d+n\d+", parts[2]
            ):
                read += int(parts[5])
                written += int(parts[9])
        return read, written

    @staticmethod
    def _processes() -> dict[str, dict[str, Any]]:
        found: dict[str, dict[str, Any]] = {}
        for entry in Path("/proc").iterdir():
            if not entry.name.isdigit() or entry.name == "1":
                continue
            try:
                cmd = (entry / "cmdline").read_bytes().replace(b"\0", b" ").decode(errors="replace")
                stat = (entry / "stat").read_text().split(") ", 1)[1].split()
            except (OSError, IndexError):
                continue
            name = (
                "app"
                if "cfo_server.app" in cmd
                else "litestream"
                if "litestream" in cmd
                else "entrypoint"
                if "cfo_server.entrypoint" in cmd
                else None
            )
            if name is None:
                continue
            found[name] = {
                "pid": int(entry.name),
                "state": stat[0],
                "cpu_ticks": int(stat[11]) + int(stat[12]),
                "rss_mb": round(int(stat[21]) * 4096 / 1e6, 1),
            }
        return found

    def _run(self) -> None:
        started = self.server.started_mono
        last_cpu = self._cpu()
        last_disk = self._disk()
        last_procs = self._processes()
        last_stack = 0.0
        while not self._stop.wait(self.SAMPLE_S):
            try:
                cpu = self._cpu()
                delta = [b - a for a, b in zip(last_cpu, cpu, strict=False)]
                total = sum(delta) or 1
                disk = self._disk()
                procs = self._processes()
                sample: dict[str, Any] = {
                    "at_s": round(time.monotonic() - started, 1),
                    "cpu_pct": {
                        k: round(100 * delta[i] / total, 1)
                        for i, k in enumerate(
                            ("user", "nice", "system", "idle", "iowait", "irq", "softirq", "steal")
                        )
                        if i < len(delta)
                    },
                    "load1": float(Path("/proc/loadavg").read_text().split()[0]),
                    "mem_available_mb": next(
                        round(int(line.split()[1]) / 1024)
                        for line in Path("/proc/meminfo").read_text().splitlines()
                        if line.startswith("MemAvailable")
                    ),
                    "disk_read_mb": round((disk[0] - last_disk[0]) * 512 / 1e6, 1),
                    "disk_write_mb": round((disk[1] - last_disk[1]) * 512 / 1e6, 1),
                    "processes": {
                        name: {
                            "state": p["state"],
                            "cpu_s": round(
                                (p["cpu_ticks"] - last_procs.get(name, {}).get("cpu_ticks", 0))
                                / os.sysconf("SC_CLK_TCK"),
                                2,
                            ),
                            "rss_mb": p["rss_mb"],
                        }
                        for name, p in procs.items()
                    },
                }
                with contextlib.suppress(OSError):
                    sample["cgroup_cpu"] = Path("/sys/fs/cgroup/cpu.stat").read_text().split()[:12]
                self.samples.append(sample)
                last_cpu, last_disk, last_procs = cpu, disk, procs
                app = procs.get("app")
                now = time.monotonic()
                if app and self.stack_error is None and now - last_stack >= self.STACK_EVERY_S:
                    last_stack = now
                    self._stack(app["pid"], round(now - started, 1))
            except Exception as exc:  # noqa: BLE001 - a missed sample, not a failed phase
                self.samples.append({"error": f"{type(exc).__name__}: {exc}"[:200]})

    def _stack(self, pid: int, at_s: float) -> None:
        try:
            result = subprocess.run(  # noqa: S603
                ["py-spy", "dump", "--pid", str(pid), "--nonblocking"],
                capture_output=True,
                text=True,
                timeout=30,
            )
        except (OSError, subprocess.TimeoutExpired) as exc:
            self.stack_error = f"{type(exc).__name__}: {exc}"[:200]
            return
        if result.returncode != 0:
            self.stack_error = _redact(result.stderr or result.stdout)[:300]
            return
        frames = [line for line in result.stdout.splitlines() if line.strip()][:40]
        self.stacks.append({"at_s": at_s, "frames": [_redact(f)[:160] for f in frames]})


def _redact(text: str) -> str:
    for name in SECRET_NAMES:
        value = os.environ.get(name)
        if value and len(value) >= 4:
            text = text.replace(value, "[redacted]")
    # The R2 endpoint names the account; Litestream logs it. Not a secret, but kept out too.
    host = os.environ.get("DRILL_ENDPOINT", "").split("//", 1)[-1]
    if len(host) >= 4:
        text = text.replace(host, "[endpoint]")
    return text


def live_query(sql: str, params: Any) -> list[tuple[Any, ...]]:
    conn = db.connect_readonly(DATA / "omnigent.db")
    try:
        return conn.execute(sql, tuple(params)).fetchall()
    finally:
        conn.close()


def filler_rows(path: Path = DATA / "omnigent.db") -> int:
    conn = db.connect_readonly(path)
    try:
        (count,) = conn.execute(f"SELECT COUNT(*) FROM {filler.TABLE}").fetchone()  # noqa: S608
        return int(count)
    except sqlite3.OperationalError:
        return 0
    finally:
        conn.close()


class ResnapshotProbe:
    """After a restore, how long until a new commit can be durable (D1's window).

    Started the moment the replaced server first answers healthy, it measures two views of
    the same window, both from that moment:

    - **the replica's:** one ordinary commit at once, then the time until the replica's
      position covers it (Litestream must first upload a whole new snapshot, spike S4);
    - **a person's:** a security write every 2 s, each answering 424 until the upload is
      done, as S4 measured it ("first confirmed security write after a restore").
    """

    def __init__(self, server: Server, password: str) -> None:
        self.server = server
        self.password = password
        self.started = time.monotonic()
        self.writes: list[dict[str, Any]] = []
        self.commit_sent_s: float | None = None
        self.durable_after_s: float | None = None
        self.error: str | None = None
        self._stop = threading.Event()
        self._threads = [
            threading.Thread(target=self._replica_view, daemon=True),
            threading.Thread(target=self._person_view, daemon=True),
        ]

    def start(self) -> ResnapshotProbe:
        for thread in self._threads:
            thread.start()
        return self

    def _since(self) -> float:
        return round(time.monotonic() - self.started, 2)

    def _replica_view(self) -> None:
        try:
            with canaries.Omnigent(APP) as client:
                bearer = client.bearer(self.password)
                agent = client.agent_id(bearer)
                self.commit_sent_s = self._since()
                client.http.post(
                    "/v1/sessions", json={"agent_id": agent}, headers=bearer
                ).raise_for_status()
            self.server.wait_replicated(3600)  # a position read after that commit
            self.durable_after_s = self._since()
        except Exception as exc:  # noqa: BLE001 - reported in the result
            self.error = f"{type(exc).__name__}: {exc}"[:300]

    def _person_view(self) -> None:
        try:
            with canaries.Omnigent(APP) as client:
                bearer = client.bearer(self.password)
                agent = client.agent_id(bearer)
                n = 0
                while not self._stop.is_set():
                    sent = time.monotonic()
                    response = client.http.post(
                        "/v1/scheduled-tasks",
                        headers=bearer,
                        json={
                            "name": f"resnapshot-{n}",
                            "prompt": "window",
                            "rrule": canaries.RRULE,
                            "agent_id": agent,
                            "timezone": "UTC",
                        },
                    )
                    self.writes.append(
                        {
                            "at_s": round(sent - self.started, 2),
                            "status": response.status_code,
                            "ms": round((time.monotonic() - sent) * 1000, 1),
                        }
                    )
                    n += 1
                    if response.status_code == 200:
                        return
                    self._stop.wait(2.0)
        except Exception as exc:  # noqa: BLE001 - reported in the result
            self.error = f"{type(exc).__name__}: {exc}"[:300]

    def result(self, timeout_s: float = 3600) -> dict[str, Any]:
        self._threads[0].join(timeout=timeout_s)
        self._threads[1].join(timeout=120)  # the next write after the upload is confirmed
        self._stop.set()
        self._threads[1].join(timeout=60)
        confirmed = next((w for w in self.writes if w["status"] == 200), None)
        return {
            "measured_from": "first healthy answer",
            "commit_sent_s": self.commit_sent_s,
            "new_commit_durable_after_s": self.durable_after_s,
            "first_confirmed_write_sent_s": confirmed["at_s"] if confirmed else None,
            "first_confirmed_write_answered_s": (
                round(confirmed["at_s"] + confirmed["ms"] / 1000, 2) if confirmed else None
            ),
            "unconfirmed_writes_before": sum(1 for w in self.writes if w["status"] == 424),
            "writes": self.writes,
            "error": self.error,
        }


# ── The harness ────────────────────────────────────────────────────────────────────────


class Harness:
    def __init__(self, settings: Settings) -> None:
        self.s = settings
        self.lock = threading.Lock()
        self.results: dict[str, Any] = {}
        self.state: dict[str, Any] = {
            "protocol": 1,
            "run_id": settings.run_id,
            "mode": settings.mode,
            "phases": settings.phases,
            "phase": None,
            "done": False,
            "awaiting_replacement": None,
            "errors": {},
            "started_at": time.time(),
        }
        self.server: Server | None = None
        self.probe: ResnapshotProbe | None = None
        self.password = settings.owner_password

    # Status ------------------------------------------------------------------------------
    def update(self, **fields: Any) -> None:
        with self.lock:
            self.state.update(fields, updated_at=time.time())

    def snapshot(self) -> dict[str, Any]:
        with self.lock:
            return {**self.state, "results": sorted(self.results)}

    def record(self, name: str, result: dict[str, Any]) -> None:
        text = json.dumps(result, sort_keys=True, default=str)
        for secret in SECRET_NAMES:
            value = os.environ.get(secret)
            if value and len(value) >= 4 and value in text:
                raise RuntimeError(f"refusing to record {name}: it contains {secret}")
        if self.password != self.s.owner_password and self.password in text:
            raise RuntimeError(f"refusing to record {name}: it contains the owner password")
        RESULTS.mkdir(parents=True, exist_ok=True)
        (RESULTS / f"{name}.json").write_text(text + "\n")
        with self.lock:
            self.results[name] = json.loads(text)
        say("result", name=name)

    def serve(self) -> ThreadingHTTPServer:
        harness = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args: Any) -> None:
                pass

            def _send(self, status: int, payload: Any) -> None:
                body = json.dumps(payload, default=str).encode()
                self.send_response(status)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_GET(self) -> None:  # noqa: N802
                path = self.path.split("?", 1)[0]
                if path == "/status":
                    self._send(200, harness.snapshot())
                elif path.startswith("/results/"):
                    with harness.lock:
                        result = harness.results.get(path.removeprefix("/results/"))
                    self._send(200 if result is not None else 404, result or {"error": "none"})
                else:
                    self._send(404, {"error": "not found"})

        class _Server(ThreadingHTTPServer):
            daemon_threads = True
            allow_reuse_address = True

        server = _Server(("0.0.0.0", STATUS_PORT), Handler)  # noqa: S104
        threading.Thread(target=server.serve_forever, daemon=True).start()
        return server

    # Helpers ------------------------------------------------------------------------------
    def fresh(self, prefix: str, **kw: Any) -> Server:
        self.lose()
        wipe()
        self.server = Server(self.s, prefix, initialized=False, **kw).start()
        self.server.wait_healthy(300)
        self.server.wait_replicated(120)
        self.password = self.s.owner_password
        return self.server

    def lose(self) -> float | None:
        """The server dies at once (SIGKILL to every process). Returns when it happened."""
        if self.server is None:
            return None
        kill_everything_else()
        self.server = None
        return time.monotonic()

    def replace(self, prefix: str, **kw: Any) -> tuple[Server, dict[str, Any]]:
        """A new server on the same replica after a loss, with its timings.

        The re-snapshot probe (:class:`ResnapshotProbe`) starts the moment the server first
        answers healthy, before any check reads or writes anything; ``self.probe`` holds it.
        """
        wipe()
        server = Server(self.s, prefix, initialized=True, **kw).start()
        self.server = server
        self.probe = None
        startup = StartupProbe(server).start()
        timing: dict[str, Any] = {}
        try:
            timing["to_healthy_s"] = round(
                server.wait_healthy(kw.get("restore_deadline_s", 300) + 900), 2
            )
            timing["healthy_at"] = time.time()
            self.probe = ResnapshotProbe(server, self.password).start()
        except RecoveryMode as exc:
            timing["recovery"] = json.loads(str(exc))
        finally:
            timing["startup"] = startup.stop()
        restores = server.of("restore")
        if restores:
            timing["restore_s"] = restores[-1].get("seconds")
            timing["restore_timed_out"] = restores[-1].get("timed_out")
        ready = server.of("database.ready")
        timing["source"] = ready[-1].get("source") if ready else None
        return server, timing

    def client(self) -> canaries.Omnigent:
        return canaries.Omnigent(APP)

    # Phases -------------------------------------------------------------------------------
    def phase_env(self) -> dict[str, Any]:
        meminfo = Path("/proc/meminfo").read_text().splitlines()[:3]
        limit = None
        for path in ("/sys/fs/cgroup/memory.max", "/sys/fs/cgroup/memory/memory.limit_in_bytes"):
            with contextlib.suppress(OSError):
                limit = Path(path).read_text().strip()
                break
        cpu = None
        with contextlib.suppress(OSError):
            cpu = Path("/sys/fs/cgroup/cpu.max").read_text().strip()
        version = subprocess.run(  # noqa: S603
            ["/usr/local/bin/litestream", "version"], capture_output=True, text=True, timeout=30
        ).stdout.strip()
        usage = shutil.disk_usage("/")
        return {
            "nproc": os.cpu_count(),
            "cpu_max": cpu,
            "memory_limit": limit,
            "meminfo": meminfo,
            "disk_total_bytes": usage.total,
            "disk_free_bytes": usage.free,
            "litestream": version,
            "python": sys.version.split()[0],
            "endpoint_host": self.s.endpoint.split("//", 1)[-1].split(".", 1)[-1],
            "region": self.s.region,
            "plan": self.s.phases,
        }

    def phase_drill(self) -> dict[str, Any]:
        server = self.fresh("drill")
        result: dict[str, Any] = {"prefix": server.prefix}
        with self.client() as client:
            first = canaries.write_canaries(client, self.password, items=5, live=live_query)
            self.password = first.secrets.password
            result["first"] = first.summary()
            report = drill.run_drill(
                canaries=first.canaries, conversations=[c for c in [first.conversation] if c]
            )
            result["drill_side_restore"] = report
            second = canaries.write_canaries(
                client, self.password, items=5, change_password=False, live=live_query
            )
            result["second"] = second.summary()
        lost_at = self.lose()
        assert lost_at is not None and second.last_ack_at is not None
        result["kill_after_last_ack_ms"] = round((lost_at - second.last_ack_at) * 1000, 1)
        server, timing = self.replace("drill")
        result["replacement"] = timing
        with self.client() as client:
            checks = canaries.verify_http(client, first) + canaries.verify_http(client, second)
        result["http_checks"] = [c.to_json() for c in checks]
        result["resnapshot"] = self.resnapshot()
        both = first.canaries + second.canaries
        conversations = [c for c in (first.conversation, second.conversation) if c]
        result["drill_after_replacement"] = drill.run_drill(
            canaries=both, conversations=conversations
        )
        result["ok"] = (
            report["ok"] and all(c.ok for c in checks) and result["drill_after_replacement"]["ok"]
        )
        return result

    def phase_barrier(self, sync: str) -> dict[str, Any]:
        server = self.fresh(
            f"barrier-{sync}", sync=sync, response_timeout_s=30.0, transcript_timeout_s=4.9
        )
        rng = random.Random(25)
        with self.client() as client:
            bearer = client.bearer(self.password)
            agent = client.agent_id(bearer)
            created = client.http.post(
                "/v1/scheduled-tasks",
                headers=bearer,
                json={
                    "name": "barrier-start",
                    "prompt": "barrier measurement",
                    "rrule": canaries.RRULE,
                    "agent_id": agent,
                    "timezone": "UTC",
                },
            )
            created.raise_for_status()
            task = created.json()["id"]
            session = client.http.post("/v1/sessions", json={"agent_id": agent}, headers=bearer)
            session.raise_for_status()
            conversation = session.json()["id"]
            kinds = ["write"] * self.s.barrier_writes + ["item"] * self.s.barrier_items
            rng.shuffle(kinds)
            samples: dict[str, list[dict[str, Any]]] = {"write": [], "item": [], "plain": []}
            for n, kind in enumerate(["write"] * 5 + kinds):  # five warm-up writes, unrecorded
                time.sleep(rng.uniform(0.2, 2.0))
                started = time.monotonic()
                if kind == "write":
                    response = client.http.patch(
                        f"/v1/scheduled-tasks/{task}",
                        json={"name": f"barrier-{n}"},
                        headers=bearer,
                    )
                else:
                    response = client.http.post(
                        f"/v1/sessions/{conversation}/events",
                        json=canaries.item_event(f"barrier-{n}"),
                        headers=bearer,
                    )
                elapsed = (time.monotonic() - started) * 1000
                if n >= 5:
                    samples[kind].append(
                        {
                            "ms": round(elapsed, 1),
                            "status": response.status_code,
                            "durability": response.headers.get("x-cfo-durability"),
                        }
                    )
                if n % 7 == 0:  # an unheld request next to them: the latency without a wait
                    started = time.monotonic()
                    client.http.get("/v1/scheduled-tasks", headers=bearer)
                    samples["plain"].append({"ms": round((time.monotonic() - started) * 1000, 1)})

            # The server's own log of each held write (read by another thread: let it catch up).
            def patches() -> list[dict[str, Any]]:
                return [
                    e
                    for e in server.of("barrier.response")
                    if e.get("method") == "PATCH" and e.get("path") == f"/v1/scheduled-tasks/{task}"
                ]

            deadline = time.monotonic() + 10
            while len(patches()) < 5 + self.s.barrier_writes and time.monotonic() < deadline:
                time.sleep(0.1)
            waits = [e["elapsed_ms"] for e in patches()[5:]]
        return {
            "prefix": server.prefix,
            "sync_interval": sync,
            # The server's own wait for each held security write (cfo.barrier.response).
            "barrier_wait_ms": stats.summary(waits),
            # Client-side request latencies: the waits plus Omnigent's own handling. The image
            # logs only failed transcript waits, so the items' wait is seen through these.
            "write_latency_ms": stats.summary(s["ms"] for s in samples["write"]),
            "writes_unconfirmed": sum(1 for s in samples["write"] if s["status"] != 200),
            "item_latency_ms": stats.summary(s["ms"] for s in samples["item"]),
            "items_refused": sum(1 for s in samples["item"] if s["status"] >= 300),
            "unheld_latency_ms": stats.summary(s["ms"] for s in samples["plain"]),
            "raw": {
                "write_ms": [s["ms"] for s in samples["write"]],
                "item_ms": [s["ms"] for s in samples["item"]],
                "wait_ms": waits,
            },
            "transcript_timeouts_logged": len(server.of("barrier.transcript")),
        }

    def phase_idle(self, sync: str) -> dict[str, Any]:
        server = self.fresh(f"idle-{sync}", sync=sync)
        time.sleep(30)  # let the start's own uploads settle
        start = time.time()
        time.sleep(self.s.idle_s)  # no request of any kind meanwhile
        end = time.time()
        return {
            "prefix": server.prefix,
            "sync_interval": sync,
            "window_start": start,
            "window_end": end,
            "window_start_iso": _iso(start),
            "window_end_iso": _iso(end),
            "seconds": round(end - start, 1),
        }

    def phase_restore(self, megabytes: int, *, keep_running: bool) -> dict[str, Any]:
        prefix = f"restore-{megabytes}mb"
        server = self.fresh(prefix)
        result: dict[str, Any] = {"prefix": prefix, "megabytes": megabytes}
        result["seed"] = filler.seed(DATA / "omnigent.db", megabytes)
        result["upload_catch_up_s"] = round(server.wait_replicated(3600), 2)
        result["disk_after_seed"] = disk_usage()
        rows = filler_rows()
        result["filler_rows"] = rows
        side_while_running = megabytes <= 200
        if side_while_running:
            result["drill_side_restore"] = drill.run_drill(deadline_s=3600)
        self.lose()
        shutil.rmtree(DATA, ignore_errors=True)
        DATA.mkdir(parents=True, exist_ok=True)
        if not side_while_running:
            # Disk: the live server, its WAL and its LTX files take about twice the database,
            # so the side restore runs after the loss, alone on the disk.
            out = Path("/tmp/drill-side/restored.db")  # noqa: S108
            side = drill.side_restore(out, deadline_s=3600)
            entry: dict[str, Any] = {
                "ok": side.ok,
                "seconds": round(side.seconds, 2),
                "output": side.output_tail,
            }
            if side.ok:
                conn = db.connect_readonly(out)
                try:
                    entry["integrity"] = db.integrity(conn)
                finally:
                    conn.close()
                entry["filler_rows"] = filler_rows(out)
                entry["bytes"] = out.stat().st_size
            shutil.rmtree(out.parent, ignore_errors=True)
            result["side_restore"] = entry
        server, timing = self.replace(prefix)
        result["replacement"] = timing
        if "recovery" in timing:
            result["ok"] = False
            return result
        result["resnapshot"] = self.resnapshot()
        result["filler_rows_after_replacement"] = filler_rows()
        result["disk_after_replacement"] = disk_usage()
        result["ok"] = result["filler_rows_after_replacement"] == rows
        if not keep_running:
            self.lose()
        return result

    def resnapshot(self) -> dict[str, Any]:
        """The re-snapshot probe's result, measured from the first healthy answer."""
        if self.probe is None:
            return {"error": "no probe: the server never became healthy"}
        return self.probe.result()

    def phase_cf_replacement(self) -> dict[str, Any]:
        server = self.server
        if server is None or not server.prefix.startswith("restore-"):
            server = self.fresh("cf-replacement")
        with self.client() as client:
            run = canaries.write_canaries(
                client, self.password, items=3, change_password=False, live=live_query
            )
        # The canaries' rows as the server holds them once replicated: the replaced container
        # must restore exactly these. Nothing writes after this point; the Durable Object kills
        # the container next.
        conversations = [run.conversation] if run.conversation else []
        snap, txid, _ = drill.confirmed_snapshot(conversations=conversations)
        canary_list = [c.with_expected(snap) for c in run.canaries]
        manifest = {
            "canaries": [c.to_json() for c in canary_list],
            "conversations": conversations,
        }
        rows = filler_rows()
        return {
            "prefix": server.prefix,
            "canaries": run.summary(),
            "confirmed_txid": txid,
            "filler_rows": rows,
            "written_at": time.time(),
            # What the Durable Object passes to the replaced container (no credentials).
            "awaiting": {
                "prefix": server.prefix,
                "manifest": json.dumps(manifest),
                "filler_rows": rows,
            },
        }

    # Replaced mode --------------------------------------------------------------------------
    def run_replaced(self) -> None:
        assert self.s.replaced_prefix is not None
        self.update(phase="replaced")
        result: dict[str, Any] = {
            "prefix": self.s.replaced_prefix,
            "process_started_at": time.time(),
        }
        try:
            _server, timing = self.replace(self.s.replaced_prefix)
            result["replacement"] = timing
            if "recovery" not in timing:
                # The probe's writes add rows of their own; they never touch a canary's row.
                manifest = json.loads(self.s.replaced_manifest or "{}")
                restored = db.snapshot_file(
                    DATA / "omnigent.db", conversations=manifest.get("conversations", [])
                )
                canary_list = [db.Canary.from_json(c) for c in manifest.get("canaries", [])]
                check = db.check_canaries(canary_list, None, restored)
                result["acknowledged_changes"] = check.to_json()
                rows = filler_rows()
                result["filler_rows"] = rows
                result["filler_rows_expected"] = self.s.replaced_filler_rows
                result["resnapshot"] = self.resnapshot()
                result["ok"] = (
                    check.ok
                    and all(c.expected is not None for c in canary_list if c.expect == "present")
                    and (self.s.replaced_filler_rows is None or rows == self.s.replaced_filler_rows)
                )
            else:
                result["ok"] = False
        except Exception as exc:  # noqa: BLE001 - reported, the run goes on
            result["error"] = _error(exc)
            result["ok"] = False
        self.record("cf-replacement-container", result)
        self.lose()
        self.update(done=True, phase=None)

    # The plan -------------------------------------------------------------------------------
    def run(self) -> None:
        sizes = [p for p in self.s.phases if p.startswith("restore-")]
        for phase in self.s.phases:
            self.update(phase=phase)
            say("phase", name=phase)
            try:
                if phase == "env":
                    result = self.phase_env()
                elif phase == "drill":
                    result = self.phase_drill()
                elif phase.startswith("barrier-"):
                    result = self.phase_barrier(phase.removeprefix("barrier-"))
                elif phase.startswith("idle-"):
                    result = self.phase_idle(phase.removeprefix("idle-"))
                elif phase.startswith("restore-"):
                    megabytes = int(phase.removeprefix("restore-").removesuffix("mb"))
                    keep = phase == sizes[-1] and "cf-replacement" in self.s.phases
                    result = self.phase_restore(megabytes, keep_running=keep)
                elif phase == "cf-replacement":
                    result = self.phase_cf_replacement()
                    self.record(phase, {"phase": phase, **result})
                    # Only once the result is recorded: the Durable Object stores the results
                    # it has not stored yet, then kills this container.
                    self.update(
                        phase="awaiting-replacement", awaiting_replacement=result["awaiting"]
                    )
                    return
                else:
                    raise ValueError(phase)
            except Exception as exc:  # noqa: BLE001 - one failed phase never stops the plan
                result = {"error": _error(exc), "server_tail": self._tail()}
                with self.lock:
                    self.state["errors"][phase] = result["error"]["type"]
                with contextlib.suppress(Exception):
                    self.lose()
            self.record(phase, {"phase": phase, **result})
        self.lose()
        self.update(done=True, phase=None)

    def _tail(self) -> list[str]:
        return list(self.server.tail) if self.server is not None else []


def _iso(t: float) -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(t))


def _error(exc: BaseException) -> dict[str, Any]:
    return {
        "type": type(exc).__name__,
        "message": _redact(str(exc))[:500],
        "where": _redact("".join(traceback.format_tb(exc.__traceback__)[-3:]))[-1500:],
    }


def main() -> int:
    settings = Settings.from_env(dict(os.environ))
    if os.getpid() != 1:
        raise SystemExit("the harness runs only as a container's main process (PID 1)")
    harness = Harness(settings)
    harness.serve()
    say("start", mode=settings.mode, run_id=settings.run_id, phases=settings.phases)
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    if settings.mode == "replaced":
        harness.run_replaced()
    else:
        harness.run()
    say("done", errors=harness.state["errors"])
    while True:  # keep answering the Durable Object until it stops the container
        reap()
        time.sleep(5)
