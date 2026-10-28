"""Test harness for the computer supervisor: the real receiver over real HTTP.

- ``Rig`` builds a supervisor rooted in a temporary directory, serves it with the real
  ``CommandServer`` on a loopback port, and sends commands as WorkspaceDO would (JSON over HTTP
  through the container port). Capture workers and lease guards are real processes; captures
  pause only the test's own workload processes (``scope_pids``).
- ``FakeWorkspace`` stands in for WorkspaceDO's side of the computer API
  (``computer.internal``): it records every message, answers per the contract, and can drop a
  number of requests without answering, as "Network connection lost." does.
Every value here is synthetic.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

REPO = Path(__file__).resolve().parents[3]
COMPUTER = REPO / "images" / "computer"
FAKES = COMPUTER / "fakes" / "bin"
sys.path.insert(0, str(COMPUTER))

from cfo_computer.api import ComputerApi  # noqa: E402
from cfo_computer.contract import Contract  # noqa: E402
from cfo_computer.ids import new_operation_id, new_ulid_body  # noqa: E402
from cfo_computer.paths import Account, Layout  # noqa: E402
from cfo_computer.policy import Policy  # noqa: E402
from cfo_computer.server import CommandServer  # noqa: E402
from cfo_computer.supervisor import Supervisor, Tools  # noqa: E402

LEASE = {"targetMs": 20000, "hardMs": 40000}
CANARY = "CFO_" + "CANARY_"


def canary(label: str) -> str:
    return f"{CANARY}T34{label}{os.urandom(8).hex()}"


def new_id(prefix: str) -> str:
    return f"{prefix}_{new_ulid_body()}"


def prepare_contracts(root: Path) -> Path:
    contracts = root / "contracts"
    if not contracts.exists():
        contracts.mkdir(parents=True)
        shutil.copytree(REPO / "contracts" / "schema", contracts / "schema")
        shutil.copy(
            REPO / "contracts" / "fixtures" / "CheckpointPolicy" / "v1.json",
            contracts / "checkpoint-policy-v1.json",
        )
    return contracts


class FakeWorkspace:
    """WorkspaceDO's side of ``POST /v1/messages``, recorded."""

    def __init__(self) -> None:
        self.messages: list[dict[str, Any]] = []
        self.drop: dict[str, int] = {}  # per message type: this many are cut unanswered
        self.refuse: str | None = None  # an ErrorBody code to answer with
        self.pointer: dict[str, Any] | None = None  # the published credential bundle
        self.lock = threading.Lock()
        outer = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def do_POST(self) -> None:  # noqa: N802
                body = self.rfile.read(int(self.headers["content-length"]))
                message = json.loads(body)
                with outer.lock:
                    outer.messages.append(message)
                    if outer.drop.get(message["type"], 0) > 0:
                        outer.drop[message["type"]] -= 1
                        self.close_connection = True
                        self.connection.shutdown(2)
                        return
                    status, reply = outer.answer(message)
                data = json.dumps(reply).encode()
                self.send_response(status)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def log_message(self, *args: Any) -> None:
                return

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        # Readiness can go stale before accept (for example, a client reset). Keep the
        # listener nonblocking so serve_forever can observe shutdown instead of hanging.
        self.server.socket.setblocking(False)
        self.server.daemon_threads = True
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}/v1/messages"

    def answer(self, m: dict[str, Any]) -> tuple[int, dict[str, Any]]:
        if self.refuse:
            return 409, {"error": {"code": self.refuse, "message": "refused", "retryable": False}}
        kind = m["type"]
        if kind == "hello":
            return 200, {"type": "hello", "protocolVersion": 1}
        if kind == "report":
            return 200, {"type": "report", "appliedSeq": m["report"]["seq"]}
        if kind == "save_request":
            return 200, {"type": "save_request", "outcome": "accepted"}
        bundle = m["bundle"]
        if newer(bundle, self.pointer):
            self.pointer = bundle
            return 200, {
                "type": "credential_checkpoint",
                "outcome": "published",
                "checkpointId": new_id("ckp"),
            }
        return 200, {"type": "credential_checkpoint", "outcome": "superseded", "checkpointId": None}

    def of(self, kind: str) -> list[dict[str, Any]]:
        with self.lock:
            return [m for m in self.messages if m["type"] == kind]

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()


def newer(candidate: dict[str, Any], current: dict[str, Any] | None) -> bool:
    """``credentialIsNewer`` of manifests.ts."""
    if current is None or candidate["generation"] > current["generation"]:
        return True
    if candidate["generation"] < current["generation"] or candidate["order"] <= current["order"]:
        return False
    return all(
        candidate["files"][p]["copyOrder"] >= current["files"][p]["copyOrder"]
        for p in candidate["files"]
    )


class Rig:
    """One supervisor, served over HTTP, rooted under ``root``."""

    def __init__(
        self,
        root: Path,
        *,
        computer_id: str | None = None,
        generation: int = 3,
        workspace: FakeWorkspace | None = None,
        scope_pids: list[int] | None = None,
        tools: Tools | None = None,
        **kwargs: Any,
    ) -> None:
        self.root = root
        root.mkdir(parents=True, exist_ok=True)
        contracts = prepare_contracts(root)
        self.home = root / "home"
        self.home.mkdir(exist_ok=True)
        self.layout = Layout(
            home=self.home, state=root / "state", log=root / "log", contracts=contracts
        )
        self.computer_id = computer_id or new_id("cmp")
        self.generation = generation
        self.contract = Contract(contracts / "schema")
        self.workspace = workspace
        api = ComputerApi(workspace.url, self.contract, timeout=5) if workspace else None
        self.sup = Supervisor(
            computer_id=self.computer_id,
            generation=generation,
            layout=self.layout,
            account=Account.current(self.home),
            contract=self.contract,
            policy=Policy.load(contracts / "checkpoint-policy-v1.json"),
            api=api,
            tools=tools or Tools(claude=str(FAKES / "claude"), codex=str(FAKES / "codex")),
            scope_pids=scope_pids if scope_pids is not None else [],
            **kwargs,
        )
        self.server = CommandServer(("127.0.0.1", 0), self.sup)
        self.server.start_in_thread()
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}/v1/commands"

    # -- commands --------------------------------------------------------------------------

    def post(self, body: bytes | dict[str, Any]) -> tuple[int, dict[str, Any]]:
        data = body if isinstance(body, bytes) else json.dumps(body).encode()
        request = urllib.request.Request(
            self.url, data=data, method="POST", headers={"content-type": "application/json"}
        )
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                return response.status, json.loads(response.read())
        except urllib.error.HTTPError as exc:
            return exc.code, json.loads(exc.read())

    def command(self, msg_type: str, /, *, op: str | None = None, **fields: Any) -> dict[str, Any]:
        return {
            "type": msg_type,
            "protocolVersion": 1,
            "computerId": self.computer_id,
            "generation": self.generation,
            "operationId": op or new_operation_id(),
            **fields,
        }

    def send(self, msg_type: str, /, **fields: Any) -> tuple[int, dict[str, Any]]:
        return self.post(self.command(msg_type, **fields))

    def ok(self, msg_type: str, /, **fields: Any) -> dict[str, Any]:
        status, reply = self.send(msg_type, **fields)
        assert status == 200, reply
        return reply

    def wait_job(self, op: str, timeout: float = 120) -> dict[str, Any]:
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            job = self.ok("job_status", jobOperationId=op)["job"]
            if job["state"] != "running":
                return job
            time.sleep(0.02)
        raise AssertionError("job did not finish")

    def restore(
        self, manifest: dict[str, Any] | None = None, layer_dirs: list[str] | None = None
    ) -> dict[str, Any]:
        op = new_operation_id()
        status, reply = self.send(
            "restore_workspace", op=op, manifest=manifest, layerDirs=layer_dirs or []
        )
        assert status == 200, reply
        return self.wait_job(op)

    def install(self, bundle: dict[str, Any] | None = None) -> dict[str, Any]:
        return self.ok("install_credentials", bundle=bundle)

    def boot(self) -> None:
        """A new computer: nothing to restore, no credentials."""
        assert self.restore()["state"] == "done"
        self.install()

    def capture(
        self,
        kind: str = "base",
        parent: dict[str, Any] | None = None,
        lease: dict[str, int] | None = None,
        layer_id: str | None = None,
    ) -> tuple[str, dict[str, Any]]:
        op = new_operation_id()
        status, reply = self.send(
            "capture",
            op=op,
            layerId=layer_id or new_id("lyr"),
            kind=kind,
            parent=parent,
            policyVersion=1,
            lease=lease or LEASE,
        )
        assert status == 200, reply
        return op, self.wait_job(op)

    def finish(self, op: str, outcome: str = "published") -> None:
        self.ok(
            "finish_capture",
            captureOperationId=op,
            outcome=outcome,
            checkpointId=new_id("ckp") if outcome == "published" else None,
        )

    def result(self, op: str) -> dict[str, Any]:
        """The capture worker's own result file (pause evidence)."""
        return json.loads((self.layout.log / f"capture-{op}.result.json").read_text())

    def close(self) -> None:
        self.sup.stop()
        self.server.shutdown()
        self.server.server_close()


def layer_record(job: dict[str, Any], index: dict[str, Any]) -> dict[str, Any]:
    """The manifest's record of an uploaded layer (``WorkspaceLayer``)."""
    return {
        "layerId": index["layerId"],
        "kind": index["kind"],
        "backup": {
            "id": "1b4e28ba-2fa1-41d2-883f-0016d3cca400",
            "dir": job["layerDir"],
            "size": 1,
            "sha256": "0" * 64,
            "format": "tar+zstd/1",
        },
        "indexSha256": job["indexSha256"],
        "treeDigest": job["treeDigest"],
        "entries": job["entries"],
        "deleted": job["deleted"],
        "bytes": job["bytes"],
    }


class Uploads:
    """Stands in for R2 behind DirectoryBackup: a staged layer is copied out whole (``cp -a``,
    owners, modes, links and hard links kept) before ``finish_capture`` deletes it."""

    def __init__(self, root: Path) -> None:
        self.root = root
        root.mkdir(parents=True, exist_ok=True)
        self.jobs: list[tuple[dict[str, Any], dict[str, Any]]] = []

    def upload(self, job: dict[str, Any]) -> dict[str, Any]:
        name = Path(job["layerDir"]).name
        subprocess.run(["cp", "-a", job["layerDir"], str(self.root / name)], check=True)
        index = json.loads((self.root / name / ".cfo-layer" / "index.json").read_text())
        self.jobs.append((job, index))
        return index

    def manifest(
        self, computer_id: str, generation: int, chain: list[int] | None = None
    ) -> dict[str, Any]:
        picked = [self.jobs[i] for i in chain] if chain is not None else self.jobs
        layers = [layer_record(job, index) for job, index in picked]
        last = picked[-1][0]
        return {
            "formatVersion": 1,
            "checkpointId": new_id("ckp"),
            "computerId": computer_id,
            "generation": generation,
            "policyVersion": 1,
            "parentCheckpointId": None,
            "cutAt": last["cutAt"],
            "createdAt": last["cutAt"],
            "roots": ["work", ".claude", ".claude.json", ".codex", ".omnigent"],
            "layers": layers,
            "treeDigest": last["treeDigest"],
        }

    def restore_into(self, rig: Rig, chain: list[int] | None = None) -> list[str]:
        """Copy the chosen layers into the rig's restore root, as DirectoryBackup restores."""
        picked = [self.jobs[i] for i in chain] if chain is not None else self.jobs
        dirs = []
        for _job, index in picked:
            dst = rig.layout.restore / index["layerId"]
            subprocess.run(["cp", "-a", str(self.root / index["layerId"]), str(dst)], check=True)
            dirs.append(str(dst))
        return dirs


def tree_files(home: Path, skip_credentials: bool = True) -> dict[str, Any]:
    """Every path under the policy's roots with type, mode and bytes (or link target)."""
    out: dict[str, Any] = {}
    for root in ("work", ".claude", ".claude.json", ".codex", ".omnigent"):
        top = home / root
        if not os.path.lexists(top):
            continue
        paths = [top, *sorted(top.rglob("*"))] if top.is_dir() and not top.is_symlink() else [top]
        for p in paths:
            rel = str(p.relative_to(home))
            st = os.lstat(p)
            if p.is_symlink():
                out[rel] = ("link", os.readlink(p))
            elif p.is_dir():
                out[rel] = ("dir", st.st_mode & 0o7777)
            else:
                out[rel] = ("file", st.st_mode & 0o7777, p.read_bytes())
    return out


def scan_for(values: list[str], top: Path) -> list[str]:
    """Paths under ``top`` whose bytes hold any of ``values``, raw (the RC-53 tool does more)."""
    found = []
    for dirpath, _dirs, files in os.walk(top):
        for name in files:
            full = Path(dirpath) / name
            if full.is_symlink():
                continue
            data = full.read_bytes()
            if any(v.encode() in data for v in values):
                found.append(str(full.relative_to(top)))
    return found
