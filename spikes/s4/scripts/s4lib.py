"""Shared helpers for the S4 spike driver: the Docker stack, faults, and an
Omnigent HTTP client. Runs on the laptop. See ../README.md.

Nothing here writes a secret to ``results/``: passwords, tokens and keys live
only in memory and in ``.run/s4.env`` (git-ignored).
"""

from __future__ import annotations

import json
import os
import re
import secrets
import subprocess
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import httpx

S4 = Path(__file__).resolve().parents[1]
RUN = S4 / ".run"
RESULTS = S4 / "results"
ENV_FILE = RUN / "s4.env"
BASE = "http://127.0.0.1:18080"
TOXI = "http://127.0.0.1:18474"
MINIO = "http://127.0.0.1:19000"
BUCKET = "s4-replica"


def now() -> float:
    return time.monotonic()


def ms(seconds: float) -> float:
    return round(seconds * 1000, 1)


# ── secrets (runtime-generated, never written to results) ───────────────


def load_env() -> dict[str, str]:
    RUN.mkdir(exist_ok=True)
    if not ENV_FILE.exists():
        values = {
            "S4_MINIO_USER": "s4" + secrets.token_hex(6),
            "S4_MINIO_PASSWORD": secrets.token_urlsafe(24),
            "S4_ADMIN_USER": "s4-owner",
            "S4_ADMIN_PASSWORD": secrets.token_urlsafe(18),
            "S4_COOKIE_SECRET": secrets.token_hex(32),
        }
        ENV_FILE.write_text("".join(f"{k}={v}\n" for k, v in values.items()))
        ENV_FILE.chmod(0o600)
    env = {}
    for line in ENV_FILE.read_text().splitlines():
        if "=" in line:
            k, v = line.split("=", 1)
            env[k] = v
    return env


def secret_values() -> list[str]:
    env = load_env()
    return [v for k, v in env.items() if k != "S4_ADMIN_USER"]


def save_result(name: str, data: Any) -> Path:
    """Write a result file after checking it holds none of the run's secrets."""
    RESULTS.mkdir(exist_ok=True)
    text = json.dumps(data, indent=2, sort_keys=True, default=str) if not isinstance(data, str) else data
    for v in secret_values() + list(_SEEN_SECRETS):
        if v and v in text:
            raise RuntimeError(f"refusing to write {name}: it contains a secret value")
    p = RESULTS / name
    p.write_text(text + ("\n" if not text.endswith("\n") else ""))
    return p


_SEEN_SECRETS: set[str] = set()


def remember_secret(value: str | None) -> None:
    if value:
        _SEEN_SECRETS.add(value)


# ── Docker stack ─────────────────────────────────────────────────────────


@dataclass
class Stack:
    overrides: dict[str, str] = field(default_factory=dict)
    tmpfs: bool = False

    def _env(self) -> dict[str, str]:
        return {**os.environ, **load_env(), **self.overrides}

    def compose(self, *args: str, check: bool = True, timeout: float = 600) -> subprocess.CompletedProcess:
        files = ["-f", str(S4 / "compose.yaml")]
        if self.tmpfs:
            files += ["-f", str(S4 / "compose.tmpfs.yaml")]
        cmd = ["docker", "compose", *files, *args]
        return subprocess.run(cmd, env=self._env(), capture_output=True, text=True,
                              check=check, timeout=timeout)

    def docker(self, *args: str, check: bool = True, timeout: float = 600) -> subprocess.CompletedProcess:
        return subprocess.run(["docker", *args], capture_output=True, text=True,
                              check=check, timeout=timeout)

    # infrastructure
    def up_infra(self) -> None:
        self.compose("up", "-d", "minio", "toxiproxy")
        deadline = now() + 60
        while now() < deadline:
            try:
                if httpx.get(f"{MINIO}/minio/health/live", timeout=2).status_code == 200:
                    break
            except httpx.HTTPError:
                pass
            time.sleep(0.5)
        self._bucket()
        self.toxi_reset()

    def _s3(self):  # noqa: ANN202
        import boto3

        env = load_env()
        return boto3.client("s3", endpoint_url=MINIO, region_name="us-east-1",
                            aws_access_key_id=env["S4_MINIO_USER"],
                            aws_secret_access_key=env["S4_MINIO_PASSWORD"])

    def _bucket(self) -> None:
        s3 = self._s3()
        names = {b["Name"] for b in s3.list_buckets().get("Buckets", [])}
        if BUCKET not in names:
            s3.create_bucket(Bucket=BUCKET)

    def replica_objects(self, prefix: str) -> list[dict[str, Any]]:
        s3 = self._s3()
        out: list[dict[str, Any]] = []
        token = None
        while True:
            kw = {"Bucket": BUCKET, "Prefix": prefix.rstrip("/") + "/"}
            if token:
                kw["ContinuationToken"] = token
            r = s3.list_objects_v2(**kw)
            out += [{"key": o["Key"][len(prefix) + 1:], "size": o["Size"]} for o in r.get("Contents", [])]
            if not r.get("IsTruncated"):
                return out
            token = r["NextContinuationToken"]

    def minio_requests(self) -> dict[str, int]:
        """S3 request counters by API name, from MinIO's metrics endpoint."""
        text = httpx.get(f"{MINIO}/minio/v2/metrics/cluster", timeout=5).text
        out: dict[str, int] = {}
        for line in text.splitlines():
            if line.startswith("minio_s3_requests_total{"):
                api = line.split('api="', 1)[1].split('"', 1)[0]
                out[api] = out.get(api, 0) + int(float(line.rsplit(" ", 1)[1]))
        return out

    # toxiproxy: the "R2" link
    def toxi_reset(self) -> None:
        httpx.delete(f"{TOXI}/proxies/r2", timeout=60)
        r = httpx.post(f"{TOXI}/proxies", json={"name": "r2", "listen": "0.0.0.0:9000",
                                               "upstream": "minio:9000", "enabled": True}, timeout=60)
        r.raise_for_status()

    def block(self, mode: str) -> None:
        """Block the server's link to the replica store.

        refuse:    the proxy stops listening, new connections are refused and
                   open ones are closed.
        blackhole: connections are accepted but no data flows (Toxiproxy
                   ``timeout`` toxic with timeout 0), like a silent drop.
        """
        if mode == "refuse":
            httpx.post(f"{TOXI}/proxies/r2", json={"enabled": False}, timeout=60).raise_for_status()
        elif mode == "blackhole":
            for stream in ("upstream", "downstream"):
                httpx.post(f"{TOXI}/proxies/r2/toxics", timeout=60, json={
                    "name": f"bh_{stream}", "type": "timeout", "stream": stream,
                    "attributes": {"timeout": 0}}).raise_for_status()
        else:
            raise ValueError(mode)

    def unblock(self) -> None:
        httpx.post(f"{TOXI}/proxies/r2", json={"enabled": True}, timeout=60).raise_for_status()
        for t in httpx.get(f"{TOXI}/proxies/r2/toxics", timeout=60).json():
            httpx.delete(f"{TOXI}/proxies/r2/toxics/{t['name']}", timeout=60)

    def latency(self, latency_ms: int, jitter_ms: int = 0, rate_kbps: int | None = None) -> None:
        self.unblock()
        for stream in ("upstream", "downstream"):
            httpx.post(f"{TOXI}/proxies/r2/toxics", timeout=60, json={
                "name": f"lat_{stream}", "type": "latency", "stream": stream,
                "attributes": {"latency": latency_ms // 2, "jitter": jitter_ms}}).raise_for_status()
            if rate_kbps:
                httpx.post(f"{TOXI}/proxies/r2/toxics", timeout=60, json={
                    "name": f"bw_{stream}", "type": "bandwidth", "stream": stream,
                    "attributes": {"rate": rate_kbps}}).raise_for_status()

    # server container
    def server_id(self) -> str | None:
        out = self.compose("ps", "-a", "-q", "server", check=False).stdout.strip()
        return out or None

    def server_logs(self) -> str:
        cid = self.server_id()
        if not cid:
            return ""
        r = self.docker("logs", "-t", cid, check=False)
        return r.stdout + r.stderr

    def server_rm(self) -> None:
        self.compose("rm", "-s", "-f", "server", check=False)

    def server_start(self, wait: bool = True, timeout: float = 240) -> dict[str, Any]:
        """Create a fresh server container (empty disk) and wait for /health."""
        t0 = now()
        self.compose("up", "-d", "--no-build", "--no-deps", "server")
        out: dict[str, Any] = {"up_cmd_s": round(now() - t0, 3)}
        if wait:
            out.update(wait_health(t0, timeout))
        return out

    def server_replace(self, timeout: float = 240) -> dict[str, Any]:
        logs = self.server_logs()
        self.server_rm()
        info = self.server_start(timeout=timeout)
        info["previous_logs"] = logs
        return info

    def server_kill(self, signal: str = "KILL", cid: str | None = None) -> float:
        """Signal the server through the Docker Engine API (the CLI adds ~1 s)."""
        cid = cid or self.server_id()
        t0 = now()
        if not cid:
            return 0.0
        with httpx.Client(transport=httpx.HTTPTransport(uds="/var/run/docker.sock"), timeout=30) as c:
            r = c.post(f"http://docker/containers/{cid}/kill", params={"signal": signal})
            if r.status_code != 409:  # 409: the container is not running
                r.raise_for_status()
        return now() - t0

    def server_wait_exit(self, cid: str, timeout: float = 120) -> dict[str, Any]:
        with httpx.Client(transport=httpx.HTTPTransport(uds="/var/run/docker.sock"), timeout=timeout + 5) as c:
            r = c.post(f"http://docker/containers/{cid}/wait", params={"condition": "not-running"})
            return r.json()

    def server_exec(self, *args: str, timeout: float = 600) -> subprocess.CompletedProcess:
        return self.compose("exec", "-T", "server", *args, timeout=timeout, check=False)

    def server_state(self) -> dict[str, Any]:
        cid = self.server_id()
        if not cid:
            return {}
        r = self.docker("inspect", cid, "--format", "{{json .State}}", check=False)
        return json.loads(r.stdout) if r.returncode == 0 else {}

    def lspos(self, wait_caught_up: float = 0.0) -> dict[str, Any]:
        r = self.server_exec("python", "/opt/s4/tools/lspos.py", "--wait-caught-up", str(wait_caught_up))
        try:
            return json.loads(r.stdout.strip().splitlines()[-1])
        except (IndexError, json.JSONDecodeError):
            return {"error": (r.stdout + r.stderr)[-400:]}


# R2 bills these S3 calls as Class A; GetObject and HeadObject are Class B;
# deletes are free (https://developers.cloudflare.com/r2/pricing/).
CLASS_A = {"putobject", "copyobject", "listobjectsv2", "listobjectsv1", "listbuckets",
           "newmultipartupload", "putobjectpart", "completemultipartupload", "listmultipartuploads",
           "listobjectparts", "putbucket"}
CLASS_B = {"getobject", "headobject", "headbucket"}


def request_delta(a: dict[str, int], b: dict[str, int]) -> dict[str, Any]:
    d = {k: b.get(k, 0) - a.get(k, 0) for k in set(a) | set(b)}
    d = {k: v for k, v in d.items() if v}
    return {"by_api": d, "class_a": sum(v for k, v in d.items() if k in CLASS_A),
            "class_b": sum(v for k, v in d.items() if k in CLASS_B)}


def wait_health(t0: float, timeout: float) -> dict[str, Any]:
    deadline = t0 + timeout
    first_conn = None
    while now() < deadline:
        try:
            r = httpx.get(f"{BASE}/health", timeout=2)
            if first_conn is None:
                first_conn = now()
            if r.status_code == 200:
                return {"healthy": True, "health_s": round(now() - t0, 3)}
        except httpx.HTTPError:
            pass
        time.sleep(0.1)
    return {"healthy": False, "health_s": None}


# ── log parsing ──────────────────────────────────────────────────────────


def barrier_events(logs: str) -> list[dict[str, Any]]:
    out = []
    for line in logs.splitlines():
        i = line.find("S4BARRIER ")
        if i >= 0:
            try:
                out.append(json.loads(line[i + len("S4BARRIER "):]))
            except json.JSONDecodeError:
                pass
    return out


_TS = re.compile(r"^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d+)Z ")


def litestream_lines(logs: str, *needles: str) -> list[str]:
    return [ln for ln in logs.splitlines() if any(n in ln for n in needles)]


# ── Omnigent client ──────────────────────────────────────────────────────


@dataclass
class Reply:
    status: int
    body: Any
    seconds: float
    durability: str | None

    @property
    def code(self) -> str | None:
        b = self.body
        if isinstance(b, dict):
            if isinstance(b.get("error"), dict):
                return b["error"].get("code")
            if "code" in b:
                return b["code"]
            if isinstance(b.get("error"), str):
                return b["error"]
        return None

    def summary(self) -> dict[str, Any]:
        return {"status": self.status, "code": self.code, "ms": ms(self.seconds),
                "durability": self.durability}


def _reply(r: httpx.Response, t0: float) -> Reply:
    try:
        body = r.json()
    except ValueError:
        body = r.text[:200]
    return Reply(r.status_code, body, now() - t0, r.headers.get("x-cfo-durability"))


class Omni:
    def __init__(self, timeout: float = 60) -> None:
        # No keep-alive: after an unhandled 500 uvicorn closes the connection,
        # and a reused pooled connection would fail the next request.
        self.c = httpx.Client(base_url=BASE, timeout=timeout,
                              limits=httpx.Limits(max_keepalive_connections=0))

    def _do(self, method: str, path: str, **kw: Any) -> Reply:
        t0 = now()
        r = self.c.request(method, path, **kw)
        return _reply(r, t0)

    def login(self, user: str, password: str, refresh: bool = True) -> Reply:
        rep = self._do("POST", "/auth/login",
                       json={"username": user, "password": password, "issue_refresh": refresh})
        if isinstance(rep.body, dict):
            remember_secret(rep.body.get("token"))
            remember_secret(rep.body.get("refresh_token"))
        self.c.cookies.clear()
        return rep

    def refresh(self, rt: str) -> Reply:
        rep = self._do("POST", "/oauth/token", data={"grant_type": "refresh_token", "refresh_token": rt})
        if isinstance(rep.body, dict):
            remember_secret(rep.body.get("access_token"))
        return rep

    def access(self, rt: str) -> str | None:
        rep = self.refresh(rt)
        return rep.body.get("access_token") if rep.status == 200 else None

    def revoke(self, rt: str) -> Reply:
        return self._do("POST", "/oauth/revoke", data={"refresh_token": rt})

    def change_password(self, bearer: str, old: str, new: str) -> Reply:
        rep = self._do("POST", "/auth/users/me/password",
                       headers={"Authorization": f"Bearer {bearer}"},
                       json={"old_password": old, "new_password": new})
        self.c.cookies.clear()
        return rep

    def get(self, bearer: str, path: str) -> Reply:
        return self._do("GET", path, headers={"Authorization": f"Bearer {bearer}"})

    def agent_id(self, bearer: str) -> str:
        rep = self.get(bearer, "/v1/agents")
        items = rep.body.get("data") or rep.body.get("agents") or rep.body
        return items[0]["id"]

    def create_schedule(self, bearer: str, name: str, agent_id: str) -> Reply:
        return self._do("POST", "/v1/scheduled-tasks", headers={"Authorization": f"Bearer {bearer}"},
                        json={"name": name, "prompt": "S4 synthetic task", "rrule": "FREQ=DAILY;BYHOUR=3",
                              "agent_id": agent_id, "timezone": "UTC"})

    def patch_schedule(self, bearer: str, sid: str, **fields: Any) -> Reply:
        return self._do("PATCH", f"/v1/scheduled-tasks/{sid}",
                        headers={"Authorization": f"Bearer {bearer}"}, json=fields)

    def schedule(self, bearer: str, sid: str) -> Reply:
        return self.get(bearer, f"/v1/scheduled-tasks/{sid}")


class HealthProbe:
    """Measure /health latency in a background thread (event-loop stalls)."""

    def __init__(self, interval: float = 0.1) -> None:
        self.interval = interval
        self.samples: list[tuple[float, float | None]] = []
        self._stop = threading.Event()
        self._t = threading.Thread(target=self._run, daemon=True)

    def _run(self) -> None:
        with httpx.Client(base_url=BASE, timeout=30) as c:
            while not self._stop.is_set():
                t0 = now()
                try:
                    c.get("/health")
                    self.samples.append((t0, now() - t0))
                except httpx.HTTPError:
                    self.samples.append((t0, None))
                time.sleep(self.interval)

    def __enter__(self) -> HealthProbe:
        self._t.start()
        return self

    def __exit__(self, *exc: object) -> None:
        self._stop.set()
        self._t.join(timeout=35)

    def window(self, t_from: float, t_to: float) -> dict[str, Any]:
        """Probes that overlapped [t_from, t_to], including one already in flight."""
        lat = [s for t, s in self.samples if s is not None and t <= t_to and t + s >= t_from]
        errs = sum(1 for t, s in self.samples if s is None and t_from <= t <= t_to)
        if not lat:
            return {"n": 0, "errors": errs}
        lat.sort()
        return {"n": len(lat), "errors": errs, "p50_ms": ms(lat[len(lat) // 2]),
                "max_ms": ms(lat[-1])}


def pct(values: list[float], q: float) -> float | None:
    if not values:
        return None
    v = sorted(values)
    k = min(len(v) - 1, max(0, round(q * (len(v) - 1))))
    return round(v[k], 1)
