"""Shared fixtures for the S3 capture tests. They run inside the spike image
(spikes/s3/bench/run_tests.py), never on the laptop: they pause and resume real
processes, but only the ones they start themselves.
"""

from __future__ import annotations

import hashlib
import importlib.util
import io
import os
import re
import signal
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

import pytest

sys.path.insert(0, "/opt/s3")

S6_CORE = Path(os.environ.get("S3_S6_CORE", "/opt/s3/s6credsync/core.py"))


def load_s6() -> Any:
    """S6's audited credential policy, the single source of the filename families."""
    name = "s6_core_for_tests"
    if name in sys.modules:
        return sys.modules[name]
    spec = importlib.util.spec_from_file_location(name, S6_CORE)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


def sample_name(pattern: str) -> str:
    """A concrete filename that fully matches one of S6's temporary-sibling regexes."""
    out = pattern
    out = re.sub(r"\[0-9a-f\]\{(\d+)\}", lambda m: "0a1b2c3d4e5f6789"[: int(m.group(1))], out)
    out = out.replace(r"\d+", "4242").replace(".+", "x9Yz").replace(r"\.", ".")
    assert re.fullmatch(pattern, out), (pattern, out)
    return out


def credential_family_paths() -> list[str]:
    """Every home-relative credential path the policy covers: main file, temporary siblings, locks."""
    s6 = load_s6()
    out: list[str] = []
    for d in s6.DECLARED_FILES:
        out.append(d.path)
        for pat in d.temp_name_patterns:
            out.append(f"{d.parent}/{sample_name(pat)}")
        for lock in d.lock_names:
            out.append(f"{d.parent}/{lock}")
    return out


def build_home(home: Path, *, plant_credentials: bool = True) -> dict[str, bytes]:
    """A synthetic home: history and workspace files, plus every credential family.

    Returns the credential markers planted, by home-relative path.
    """
    files = {
        "work/project/main.py": b"print('hello')\n" * 200,
        "work/project/README.md": b"# project\n" * 50,
        "work/project/node_modules/dep/index.js": b"cache\n",
        ".claude/projects/-home-agent-work/session-1.jsonl": b'{"type":"message","text":"history"}\n' * 100,
        ".claude/.claude.json": b'{"projects":{}}\n',
        ".codex/sessions/2026/10/18/rollout-1.jsonl": b'{"type":"message"}\n' * 100,
        ".codex/config.toml": b'model = "x"\n',
        ".omnigent/config.yaml": b"runner:\n  idle_timeout_s: 900\n",
    }
    for rel, data in files.items():
        p = home / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(data)
    markers: dict[str, bytes] = {}
    if plant_credentials:
        for i, rel in enumerate(credential_family_paths()):
            marker = b"S3MARKER" + hashlib.sha256(f"{rel}{i}".encode()).hexdigest()[:16].upper().encode()
            p = home / rel
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_bytes(b'{"synthetic":"' + marker + b'"}\n')
            markers[rel] = marker
    return markers


def items_for(home: Path) -> list[dict[str, Any]]:
    """The supervisor's declared directories (main.ITEMS), pointed at a synthetic home."""
    import supervisor.main as M

    out = []
    for it in M.ITEMS:
        rel = os.path.relpath(it["src"], M.HOME)
        out.append({**it, "src": str(home / rel)})
    return out


def home_rel_of(items: list[dict[str, Any]], home: Path) -> dict[str, str]:
    return {it["name"]: os.path.relpath(it["src"], home) for it in items}


def snapshot_files(snap: Path, items: list[dict[str, Any]], home: Path) -> dict[str, bytes]:
    """Snapshot contents keyed by home-relative path."""
    names = home_rel_of(items, home)
    out: dict[str, bytes] = {}
    for item_dir in sorted(snap.iterdir()):
        base = names.get(item_dir.name, item_dir.name)
        for dp, _dn, fns in os.walk(item_dir):
            for fn in fns:
                full = Path(dp) / fn
                rel = os.path.normpath(os.path.join(base, os.path.relpath(full, item_dir)))
                out[rel] = full.read_bytes() if not full.is_symlink() else b"->" + os.readlink(full).encode()
    return out


def source_files(home: Path, items: list[dict[str, Any]], *, skip_dirs: set[str] = frozenset({"node_modules"})) -> dict[str, bytes]:
    out: dict[str, bytes] = {}
    for it in items:
        root = Path(it["src"])
        for dp, dn, fns in os.walk(root):
            dn[:] = [d for d in dn if d not in skip_dirs]
            for fn in fns:
                full = Path(dp) / fn
                out[str(full.relative_to(home))] = full.read_bytes()
    return out


def forbidden_in(paths: list[str]) -> list[str]:
    s6 = load_s6()
    return sorted(p for p in paths if s6.is_credential_or_sibling(p))


def proc_state(pid: int) -> str | None:
    try:
        raw = Path(f"/proc/{pid}/stat").read_text()
    except OSError:
        return None
    return raw[raw.rindex(")") + 2 :].split()[0]


def wait_state(pid: int, ok: set[str], timeout: float) -> str | None:
    deadline = time.monotonic() + timeout
    st = proc_state(pid)
    while time.monotonic() < deadline:
        st = proc_state(pid)
        if st in ok:
            return st
        time.sleep(0.01)
    return st


class Target:
    """A small process tree to pause: a shell with one sleeping child."""

    def __init__(self) -> None:
        self.proc = subprocess.Popen(["bash", "-c", "sleep 1000 & wait"], start_new_session=True)
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline and not self.children():
            time.sleep(0.01)

    @property
    def pid(self) -> int:
        return self.proc.pid

    def children(self) -> list[int]:
        try:
            return [int(x) for x in Path(f"/proc/{self.pid}/task/{self.pid}/children").read_text().split()]
        except OSError:
            return []

    def pids(self) -> list[int]:
        return [self.pid, *self.children()]

    def kill(self) -> None:
        for pid in self.pids():
            try:
                os.kill(pid, signal.SIGCONT)
            except OSError:
                pass
        try:
            os.killpg(self.pid, signal.SIGKILL)
        except OSError:
            pass
        self.proc.wait(timeout=5)


@pytest.fixture
def target() -> Any:
    t = Target()
    yield t
    t.kill()


def base_spec(tmp: Path, items: list[dict[str, Any]], snap_root: Path, target: Target | None, **kw: Any) -> dict[str, Any]:
    snap_root.mkdir(parents=True, exist_ok=True)
    spec: dict[str, Any] = {
        "snapshot_root": str(snap_root),
        "method": "rsync",
        "budget_s": 20.0,
        "items": items,
        "supervisor_pid": os.getpid(),
        "workload_pids": [],
        "log_dir": str(tmp),
        "margin_bytes": 0,
    }
    if target is not None:
        # The target tree is workload (like the host daemon under the supervisor):
        # pausable even though the test process started it. Scope keeps the
        # freezer away from everything else in the container.
        spec["scope_pid"] = target.pid
        spec["workload_pids"] = [target.pid]
    spec.update(kw)
    return spec


class NoSuchKey(Exception):
    pass


class FakeS3:
    """In-memory stand-in for the S3 calls the supervisor makes."""

    class exceptions:  # noqa: N801 - mirrors boto3's attribute
        NoSuchKey = NoSuchKey

    def __init__(self) -> None:
        self.objects: dict[str, bytes] = {}
        self.uploads: dict[str, dict[str, Any]] = {}
        self.aborted: list[str] = []
        self.parts_uploaded = 0

    def create_multipart_upload(self, Bucket: str, Key: str) -> dict[str, str]:  # noqa: N803
        uid = f"u{len(self.uploads) + len(self.aborted)}-{time.monotonic_ns()}"
        self.uploads[uid] = {"key": Key, "parts": {}}
        return {"UploadId": uid}

    def upload_part(self, Bucket: str, Key: str, UploadId: str, PartNumber: int, Body: bytes) -> dict[str, str]:  # noqa: N803
        self.uploads[UploadId]["parts"][PartNumber] = bytes(Body)
        self.parts_uploaded += 1
        return {"ETag": hashlib.md5(Body).hexdigest()}  # noqa: S324 - an ETag, not security

    def complete_multipart_upload(self, Bucket: str, Key: str, UploadId: str, MultipartUpload: dict[str, Any]) -> None:  # noqa: N803
        up = self.uploads.pop(UploadId)
        self.objects[Key] = b"".join(up["parts"][p["PartNumber"]] for p in MultipartUpload["Parts"])

    def abort_multipart_upload(self, Bucket: str, Key: str, UploadId: str) -> None:  # noqa: N803
        self.uploads.pop(UploadId, None)
        self.aborted.append(Key)

    def head_object(self, Bucket: str, Key: str) -> dict[str, int]:  # noqa: N803
        return {"ContentLength": len(self.objects[Key])}

    def put_object(self, Bucket: str, Key: str, Body: bytes) -> None:  # noqa: N803
        self.objects[Key] = bytes(Body)

    def get_object(self, Bucket: str, Key: str) -> dict[str, Any]:  # noqa: N803
        if Key not in self.objects:
            raise NoSuchKey(Key)
        return {"Body": io.BytesIO(self.objects[Key])}


def zstd_tar_members(blob: bytes) -> dict[str, bytes]:
    """Decompress a tar+zstd object and return its regular files."""
    import tarfile

    raw = subprocess.run(["zstd", "-q", "-d", "-c"], input=blob, capture_output=True, check=True).stdout
    out = {}
    with tarfile.open(fileobj=io.BytesIO(raw)) as tf:
        for m in tf.getmembers():
            if m.isfile():
                f = tf.extractfile(m)
                out[os.path.normpath(m.name)] = f.read() if f else b""
    return out
