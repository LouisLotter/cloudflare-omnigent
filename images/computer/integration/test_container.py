"""The built computer image as a container: the supervisor as its main process (ST-01).

Run from the repository root, after building the image (no --target, as Wrangler builds it):

    docker build -f images/computer/Dockerfile -t cfo-computer:dev .
    CFO_IT_IMAGE=cfo-computer:dev uv run --no-project --with pytest==9.1.1 \\
      pytest -p no:cacheprovider images/computer/integration

Each test starts its own containers (named ``cfo-wp34-it-…``) on its own network, with a fake
``computer.internal`` beside them, and removes them. Commands go to the supervisor through its
published command port, as WorkspaceDO's go through the container port. Synthetic values only.
"""

from __future__ import annotations

import json
import os
import secrets
import shutil
import subprocess
import time
import urllib.error
import urllib.request
from pathlib import Path

import pytest

IMAGE = os.environ.get("CFO_IT_IMAGE", "cfo-computer:dev")
HERE = Path(__file__).resolve().parent
ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz"


def _ok() -> bool:
    if shutil.which("docker") is None:
        return False
    return (
        subprocess.run(["docker", "image", "inspect", IMAGE], capture_output=True).returncode == 0
    )


pytestmark = pytest.mark.skipif(not _ok(), reason=f"needs Docker and the image {IMAGE}")


def ulid(prefix: str) -> str:
    return prefix + "_" + "".join(secrets.choice(ALPHABET) for _ in range(26))


def docker(
    *args: str, check: bool = True, timeout: float = 120
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["docker", *args], capture_output=True, text=True, check=check, timeout=timeout
    )


class Computer:
    def __init__(self, env: dict[str, str] | None = None) -> None:
        self.tag = secrets.token_hex(4)
        self.net = f"cfo-wp34-it-{self.tag}"
        self.name = f"cfo-wp34-it-box-{self.tag}"
        self.ws = f"cfo-wp34-it-ws-{self.tag}"
        self.computer_id = ulid("cmp")
        self.generation = 5
        docker("network", "create", self.net)
        docker(
            "run",
            "-d",
            "--name",
            self.ws,
            "--network",
            self.net,
            "--network-alias",
            "computer.internal",
            "-v",
            f"{HERE / 'fake_workspace.py'}:/ws.py:ro",
            "--entrypoint",
            "/usr/local/bin/python3",
            IMAGE,
            "-I",
            "/ws.py",
        )
        base_env = {"CFO_COMPUTER_ID": self.computer_id, "CFO_GENERATION": str(self.generation)}
        base_env.update(env or {})
        # Cloudflare names a durable_object container after its 64-character Durable Object
        # ID, longer than a DNS label: every computer here runs under such a hostname.
        self.hostname = secrets.token_hex(32)
        args = ["run", "-d", "--name", self.name, "--hostname", self.hostname]
        args += ["--network", self.net, "-p", "127.0.0.1::8090"]
        for k, v in base_env.items():
            args += ["-e", f"{k}={v}"]
        docker(*args, IMAGE)
        self.port = None

    def url(self) -> str:
        if self.port is None:
            out = docker("port", self.name, "8090/tcp").stdout.strip().splitlines()[0]
            self.port = out.rsplit(":", 1)[1]
        return f"http://127.0.0.1:{self.port}/v1/commands"

    def post(self, msg_type: str, /, **fields) -> tuple[int, dict]:
        body = {
            "type": msg_type,
            "protocolVersion": 1,
            "computerId": self.computer_id,
            "generation": self.generation,
            "operationId": ulid("op"),
            **fields,
        }
        request = urllib.request.Request(
            self.url(),
            data=json.dumps(body).encode(),
            method="POST",
            headers={"content-type": "application/json"},
        )
        end = time.monotonic() + 30
        while True:
            try:
                with urllib.request.urlopen(request, timeout=60) as response:
                    return response.status, json.loads(response.read())
            except urllib.error.HTTPError as exc:
                return exc.code, json.loads(exc.read())
            except (urllib.error.URLError, ConnectionError):
                if time.monotonic() > end:
                    raise
                time.sleep(0.2)

    def job(self, op: str) -> dict:
        end = time.monotonic() + 120
        while time.monotonic() < end:
            status, reply = self.post("job_status", jobOperationId=op)
            assert status == 200, reply
            if reply["job"]["state"] != "running":
                return reply["job"]
            time.sleep(0.1)
        raise AssertionError("job timed out")

    def messages(self) -> list[dict]:
        out = docker("exec", self.ws, "cat", "/tmp/messages.jsonl", check=False).stdout
        return [json.loads(line) for line in out.splitlines() if line.strip()]

    def exec(self, *argv: str, check: bool = True) -> subprocess.CompletedProcess[str]:
        return docker("exec", self.name, *argv, check=check)

    def running(self) -> bool:
        return (
            docker("inspect", "-f", "{{.State.Running}}", self.name, check=False).stdout.strip()
            == "true"
        )

    def close(self) -> None:
        docker("rm", "-f", self.name, self.ws, check=False)
        docker("network", "rm", self.net, check=False)


@pytest.fixture
def computer():
    c = Computer()
    yield c
    c.close()


def _wait(predicate, timeout: float = 30.0) -> None:
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if predicate():
            return
        time.sleep(0.2)
    raise AssertionError("timed out")


def test_the_supervisor_is_tinis_child_and_says_hello(computer: Computer) -> None:
    assert computer.post("status")[0] == 200
    procs = computer.exec("ps", "-o", "pid,ppid,user,args", "-e").stdout
    lines = {int(line.split()[0]): line for line in procs.splitlines()[1:]}
    assert "tini" in lines[1]
    supervisor = [pid for pid, line in lines.items() if pid != 1 and "cfo_computer.main" in line]
    assert len(supervisor) == 1 and lines[supervisor[0]].split()[1] == "1"
    _wait(lambda: any(m["type"] == "hello" for m in computer.messages()))
    hello = next(m for m in computer.messages() if m["type"] == "hello")
    assert (hello["computerId"], hello["generation"], hello["protocolVersion"]) == (
        computer.computer_id,
        5,
        1,
    )
    inspect = json.loads(docker("inspect", IMAGE).stdout)[0]["Config"]
    assert inspect["Entrypoint"] == ["/usr/bin/tini", "--"]
    banned = ("OMNIGENT_GITHUB_APP", "OMNIGENT_DATABRICKS", "OMNIGENT_CREDENTIAL", "DATABRICKS_")
    assert not [e for e in inspect["Env"] if e.startswith(banned)]


def test_the_command_port_answers_under_a_durable_object_hostname(computer: Computer) -> None:
    """Under Cloudflare's 64-character hostname, a stock ``http.server`` cannot bind (its
    ``getfqdn`` raises), and the supervisor's command port still answers (WP3.3's staging)."""
    assert computer.exec("hostname").stdout.strip() == computer.hostname
    assert len(computer.hostname) == 64
    stock = computer.exec(
        "/usr/local/bin/python3",
        "-I",
        "-c",
        "from http.server import HTTPServer, BaseHTTPRequestHandler as H\n"
        "HTTPServer(('0.0.0.0', 0), H)",
        check=False,
    )
    assert stock.returncode != 0 and "label too long" in stock.stderr, stock.stderr[-300:]
    assert computer.post("status")[0] == 200


def test_the_supervisors_death_stops_the_container(computer: Computer) -> None:
    assert computer.post("status")[0] == 200
    pid = computer.exec("sh", "-c", "pgrep -P 1 -f cfo_computer.main").stdout.strip()
    computer.exec("kill", "-9", pid, check=False)
    _wait(lambda: not computer.running(), timeout=20)
    code = docker("inspect", "-f", "{{.State.ExitCode}}", computer.name).stdout.strip()
    assert code != "0"


def test_an_invalid_identity_stops_the_container_with_78() -> None:
    c = Computer(env={"CFO_GENERATION": "not-a-number"})
    try:
        _wait(lambda: not c.running(), timeout=20)
        assert docker("inspect", "-f", "{{.State.ExitCode}}", c.name).stdout.strip() == "78"
    finally:
        c.close()


def test_assembled_restore_install_host_capture_and_sigterm(computer: Computer) -> None:
    status, reply = computer.post("restore_workspace", manifest=None, layerDirs=[])
    assert status == 200, reply
    assert computer.job(reply["job"]["jobOperationId"])["state"] == "done"
    assert computer.post("install_credentials", bundle=None)[0] == 200
    status, reply = computer.post(
        "start_host",
        startAttempt=1,
        hostId="0123456789abcdef0123456789abcdef",
        hostName="IT computer",
        token="CFO_CANARY_IT" + secrets.token_hex(16),
        hostConfig={"runner": {"idle_timeout_s": 600}},
    )
    assert reply == {"type": "start_host", "outcome": "taken"}
    _wait(lambda: "omnigent host" in computer.exec("ps", "-e", "-o", "args").stdout)
    # A process the platform starts with exec is outside init's tree: never paused.
    exec_proc = subprocess.Popen(["docker", "exec", computer.name, "sleep", "120"])
    computer.exec(
        "sh",
        "-c",
        "echo hello > /home/omnigent/work/hello.txt"
        " && chown 1000:1000 /home/omnigent/work/hello.txt",
    )
    time.sleep(1)
    status, reply = computer.post(
        "capture",
        layerId=ulid("lyr"),
        kind="base",
        parent=None,
        policyVersion=1,
        lease={"targetMs": 20000, "hardMs": 40000},
    )
    assert status == 200, reply
    job = computer.job(reply["job"]["jobOperationId"])
    assert job["state"] == "staged", job
    result = json.loads(
        computer.exec(
            "cat", f"/var/log/cfo/capture-{reply['job']['jobOperationId']}.result.json"
        ).stdout
    )
    kinds = result["stoppedByKind"]
    assert kinds.get("omnigent-host", 0) >= 1 and kinds.get("terminal", 0) >= 1, kinds
    assert not any(k.startswith("other:sleep") for k in kinds), kinds
    assert not any(k in ("supervisor", "capture-worker", "lease-guard", "init") for k in kinds), (
        kinds
    )
    index = json.loads(computer.exec("cat", f"{job['layerDir']}/.cfo-layer/index.json").stdout)
    entry = next(e for e in index["entries"] if e["path"] == "work/hello.txt")
    assert (entry["uid"], entry["gid"]) == (1000, 1000)
    states = computer.exec("ps", "-e", "-o", "stat=").stdout.split()
    assert not any(s.startswith("T") for s in states), "everything resumed"
    exec_proc.kill()
    # A report carries the state; SIGTERM asks for a save and the supervisor keeps serving.
    _wait(
        lambda: any(
            m["type"] == "report" and m["report"]["host"]["state"] == "running"
            for m in computer.messages()
        )
    )
    docker("kill", "--signal", "TERM", computer.name)
    _wait(lambda: any(m["type"] == "save_request" for m in computer.messages()))
    save = next(m for m in computer.messages() if m["type"] == "save_request")
    assert save["reason"] == "sigterm"
    assert computer.post("status")[0] == 200


DB = HERE / "directory-backup"


@pytest.mark.skipif(
    not (DB / "node_modules" / "@cloudflare" / "sandbox").exists() or shutil.which("node") is None,
    reason="needs node and `npm ci --prefix images/computer/integration/directory-backup`",
)
def test_layers_round_trip_through_directory_backup(tmp_path: Path) -> None:
    """The Sandbox SDK's real DirectoryBackup and the image's sandbox-shim carry a base and a
    delta from one computer to another; the restored tree equals the captured one."""
    out = tmp_path / "result.json"
    proc = subprocess.run(
        [str(DB / "run.sh"), IMAGE, str(out)],
        capture_output=True,
        text=True,
        timeout=900,
        env={**os.environ, "RT_SCRATCH": str(tmp_path / "scratch")},
    )
    result = json.loads(out.read_text())
    assert proc.returncode == 0 and result["ok"], [c for c in result["checks"] if not c["ok"]]
    assert result["record0"]["format"] == "tar+zstd/1" and result["objects"] == 2
    # WP3.22: the real shim's failed parts, which WorkspaceDO repeats, left nothing behind.
    assert [f["code"] for f in result["partFailures"]] == ["BACKUP_TRANSFER"] * 2


def test_a_durable_object_container_gets_its_hostname_and_root_directory_fixed(
    tmp_path: Path,
) -> None:
    """WP3.22 and WP3.27, under the real supervisor: started as Cloudflare's ``durable_object``
    runtime leaves a container (a 64-character hostname; ``/etc/hosts`` a read-only mount that
    does not name it; ``/`` owned by uid 2346, recreated here before tini starts), the hostname
    resolves through the image's NSS ``myhostname``, so ``sudo`` prints no "unable to resolve
    host" and the supervisor's status says ``resolved``, and ``/`` goes back to root, so Claude
    Code 2.1.311 binds its cross-session messaging sockets instead of refusing them."""
    tag = secrets.token_hex(4)
    name = f"cfo-wp34-it-do-{tag}"
    hostname = secrets.token_hex(32)
    computer_id = ulid("cmp")
    # Cloudflare's /etc/hosts, as the 28 Oct sitting found it: read-only, without the hostname.
    hosts_file = tmp_path / "hosts"
    hosts_file.write_text("127.0.0.1\tlocalhost\n::1\tlocalhost ip6-localhost ip6-loopback\n")
    hosts_file.chmod(0o644)
    script = (
        "chown 2346:2346 / && exec /usr/bin/tini -- /usr/local/bin/python3 -I -m cfo_computer.main"
    )
    docker(
        "run",
        "-d",
        "--name",
        name,
        "--hostname",
        hostname,
        "--network",
        "none",
        "-v",
        f"{hosts_file}:/etc/hosts:ro",
        "-e",
        f"CFO_COMPUTER_ID={computer_id}",
        "-e",
        "CFO_GENERATION=1",
        "--entrypoint",
        "/bin/sh",
        IMAGE,
        "-c",
        script,
    )
    try:
        _wait(lambda: "start fixes" in docker("logs", name, check=False).stderr)
        assert "hostname resolved, root owner was 2346:2346" in docker("logs", name).stderr
        assert docker("exec", name, "stat", "-c", "%u:%g %a", "/").stdout.split() == ["0:0", "755"]
        assert docker("exec", name, "cat", "/etc/hosts").stdout == hosts_file.read_text()
        touch = docker("exec", name, "sh", "-c", "echo x >> /etc/hosts", check=False)
        assert touch.returncode != 0, "the test's /etc/hosts must be read-only"
        sudo = docker("exec", "-u", "omnigent", name, "sudo", "-n", "true")
        assert sudo.stderr == "", sudo.stderr
        # The supervisor's own computer_status, asked on its command port inside the container.
        ask = (
            "import json, urllib.request\n"
            "body = {'type': 'computer_status', 'protocolVersion': 1, 'computerId': "
            f"{computer_id!r}, 'generation': 1, 'operationId': {ulid('op')!r}}}\n"
            "request = urllib.request.Request('http://127.0.0.1:8090/v1/commands', "
            "data=json.dumps(body).encode(), headers={'content-type': 'application/json'})\n"
            "print(json.load(urllib.request.urlopen(request, timeout=30))['status']['hostname'])"
        )
        answer = docker("exec", name, "/usr/local/bin/python3", "-I", "-c", ask).stdout.strip()
        assert answer == "resolved", answer
        # Claude Code's sockets directory, vetted up to "/", in a throwaway home.
        claude = " && ".join(
            [
                "export HOME=$(mktemp -d)",
                "cd $HOME",
                "(timeout 40 script -qfc 'claude --debug-file d.log' /dev/null >/dev/null &)",
                "for i in $(seq 1 150); do grep -q 'uds-messaging\\]' d.log 2>/dev/null && break;"
                " sleep 0.2; done",
                "grep -a 'uds-messaging\\]' d.log | head -3",
            ]
        )
        out = docker("exec", "-u", "omnigent", name, "bash", "-c", claude, timeout=60).stdout
        assert "[uds-messaging] Listening:" in out, out
        assert "Failed to set up sockets directory" not in out, out
    finally:
        docker("rm", "-f", name, check=False)
