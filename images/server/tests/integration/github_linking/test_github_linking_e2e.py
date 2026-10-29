"""GitHub linking end to end, locally (WP5.9; RC-55 and RC-53's GitHub parts).

The pieces, each the real one except GitHub:
- **the key service:** the platform Worker's real ``PlatformInternal`` entrypoint under
  ``wrangler dev`` (workerd), with Worker secrets from an env file, reached by the server as
  ``http://platform.internal:<port>/key-service/v1``, as the server container reaches it through
  its intercept on Cloudflare (``worker/test/e2e/key-service-e2e.ts``);
- **the server:** the server image (its final target, as Wrangler builds it), with the GitHub
  App's and the key service's settings as the Worker would pass them;
- **a computer:** the computer image, with the real ``omnigent host`` started as the supervisor
  starts it (``cfo_computer.host.host_env`` and ``host_argv``, as the person's account), and the
  image's own git and gh wrapper;
- **GitHub:** ``fake_github.py`` under the names ``github.com`` and ``api.github.com`` on the
  test's Docker network, with a certificate from the test's own authority.

Flow: sign in as the owner; Connect GitHub (Omnigent's redirect, the fake's authorize, Omnigent's
callback and code exchange); the token set stored only as ciphertext through the key service, in
the database and in its replica; the launch token minted for the computer's host (directly in
Omnigent's host store: the launcher's provisioning is tested elsewhere); git clone and gh on the
computer through the host's credential broker; no token on the computer's disk, in
``~/.gitconfig``, gh's configuration or any argv; unlink in Omnigent; then no new token on the
computer. A second computer whose host cannot reach the server at start (the failed probe) is
checked for the same: no token on disk.

Run from the repository root, after building the images and installing the worker's packages:

    docker build -f images/server/Dockerfile -t cfo-wp59-server:runtime .
    docker build -f images/computer/Dockerfile -t cfo-wp59-computer:runtime .
    pnpm install
    uv run --no-project --with pytest==9.1.1 --with httpx==0.28.1 --with cryptography==46.0.3 \\
      pytest -p no:cacheprovider -s images/server/tests/integration/github_linking

Every value is generated for the run; containers, the network and the temporary directory
(``CFO_E2E_TMP`` or the system's) are removed afterwards. Docker resources are named
``cfo-wp59-e2e-*``.
"""

from __future__ import annotations

import base64
import datetime
import json
import os
import secrets
import shutil
import socket
import subprocess
import tempfile
import time
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import httpx
import pytest

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[4]
SERVER_IMAGE = os.environ.get("CFO_E2E_SERVER_IMAGE", "cfo-wp59-server:runtime")
COMPUTER_IMAGE = os.environ.get("CFO_E2E_COMPUTER_IMAGE", "cfo-wp59-computer:runtime")
PREFIX = "cfo-wp59-e2e"
NETWORK = f"{PREFIX}-net"
OWNER = "owner"
LOGIN = "octo-cfotest"
REPO_NAME = "hello"
HOME = "/home/omnigent"
#: The Node image the server's Dockerfile builds its web UI with, by digest, for `wrangler dev`.
NODE_IMAGE = next(
    line.split("=", 1)[1].strip()
    for line in (REPO / "images" / "server" / "Dockerfile").read_text().splitlines()
    if line.startswith("ARG NODE_IMAGE=")
)
KEY_SERVICE_PORT = 8787


def _docker(*args: str, check: bool = True, input: str | None = None, timeout: float = 300):
    return subprocess.run(
        ["docker", *args], capture_output=True, text=True, check=check, input=input, timeout=timeout
    )


def _images_present() -> bool:
    if shutil.which("docker") is None:
        return False
    return (
        all(
            _docker("image", "inspect", image, check=False).returncode == 0
            for image in (SERVER_IMAGE, COMPUTER_IMAGE)
        )
        and (REPO / "worker" / "node_modules" / ".bin" / "wrangler").exists()
    )


pytestmark = pytest.mark.skipif(
    not _images_present(), reason="needs Docker, both images and the worker's packages"
)


def _free_port(host: str = "127.0.0.1") -> int:
    with socket.socket() as s:
        s.bind((host, 0))
        return s.getsockname()[1]


def _until(what: str, check, timeout: float = 120.0, every: float = 0.5):  # noqa: ANN001, ANN202
    deadline = time.monotonic() + timeout
    last: object = None
    while time.monotonic() < deadline:
        try:
            last = check()
            if last:
                return last
        except Exception as error:  # noqa: BLE001 - keep trying until the deadline
            last = error
        time.sleep(every)
    raise AssertionError(f"timed out waiting for {what}: {last!r}")


@dataclass
class Values:
    """Every secret of the run: synthetic, generated now, never printed."""

    client_id: str
    client_secret: str
    access: str
    refresh: str
    launch: str
    signing_key: str
    owner_password: str

    @classmethod
    def new(cls) -> Values:
        return cls(
            client_id=f"Iv23li{secrets.token_hex(7)}",
            client_secret=secrets.token_hex(20),
            access=f"ghu_{secrets.token_urlsafe(27)}",
            refresh=f"ghr_{secrets.token_urlsafe(54)}",
            launch=secrets.token_urlsafe(32),
            signing_key=secrets.token_hex(32),
            owner_password=secrets.token_urlsafe(18),
        )

    def tokens(self) -> dict[str, str]:
        return {"GitHub access token": self.access, "GitHub refresh token": self.refresh}


def _ca(tmp: Path) -> None:
    """A test authority, and a certificate for github.com and api.github.com from it."""
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.x509.oid import NameOID

    now = datetime.datetime.now(datetime.UTC)
    ca_key = ec.generate_private_key(ec.SECP256R1())
    ca_name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "cfo-wp59 e2e test authority")])
    ca = (
        x509.CertificateBuilder()
        .subject_name(ca_name)
        .issuer_name(ca_name)
        .public_key(ca_key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - datetime.timedelta(minutes=5))
        .not_valid_after(now + datetime.timedelta(days=1))
        .add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
        .add_extension(
            x509.KeyUsage(
                digital_signature=True,
                key_cert_sign=True,
                crl_sign=True,
                content_commitment=False,
                key_encipherment=False,
                data_encipherment=False,
                key_agreement=False,
                encipher_only=False,
                decipher_only=False,
            ),
            critical=True,
        )
        .sign(ca_key, hashes.SHA256())
    )
    key = ec.generate_private_key(ec.SECP256R1())
    cert = (
        x509.CertificateBuilder()
        .subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "github.com")]))
        .issuer_name(ca_name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - datetime.timedelta(minutes=5))
        .not_valid_after(now + datetime.timedelta(days=1))
        .add_extension(
            x509.SubjectAlternativeName(
                [x509.DNSName("github.com"), x509.DNSName("api.github.com")]
            ),
            critical=False,
        )
        .add_extension(x509.ExtendedKeyUsage([x509.oid.ExtendedKeyUsageOID.SERVER_AUTH]), False)
        .sign(ca_key, hashes.SHA256())
    )
    (tmp / "ca").mkdir()
    (tmp / "ca" / "ca.pem").write_bytes(ca.public_bytes(serialization.Encoding.PEM))
    (tmp / "fake").mkdir()
    (tmp / "fake" / "cert.pem").write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    (tmp / "fake" / "key.pem").write_bytes(
        key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        )
    )
    for path in (tmp / "ca", tmp / "fake"):
        path.chmod(0o755)
    for path in (tmp / "ca" / "ca.pem", tmp / "fake" / "cert.pem", tmp / "fake" / "key.pem"):
        path.chmod(0o644)


def _bare_repository(tmp: Path) -> str:
    """A repository with one commit, served over git's dumb HTTP protocol."""
    marker = secrets.token_hex(8)
    env = {
        "PATH": os.environ["PATH"],
        "HOME": str(tmp),
        "GIT_CONFIG_GLOBAL": "/dev/null",
        "GIT_CONFIG_NOSYSTEM": "1",
    }
    work = tmp / "work"
    git = ["git", "-c", "user.name=cfo e2e", "-c", "user.email=e2e@example.test"]
    git += ["-c", "init.defaultBranch=main", "-c", "commit.gpgsign=false"]
    subprocess.run([*git, "init", "-q", str(work)], check=True, env=env)
    (work / "README.md").write_text(f"hello {marker}\n")
    subprocess.run([*git, "-C", str(work), "add", "README.md"], check=True, env=env)
    subprocess.run([*git, "-C", str(work), "commit", "-q", "-m", "hello"], check=True, env=env)
    bare = tmp / "fake" / "repos" / f"{REPO_NAME}.git"
    subprocess.run([*git, "clone", "-q", "--bare", str(work), str(bare)], check=True, env=env)
    subprocess.run([*git, "-C", str(bare), "update-server-info"], check=True, env=env)
    for path in [tmp / "fake" / "repos", *(tmp / "fake" / "repos").rglob("*")]:
        path.chmod(0o755 if path.is_dir() else 0o644)
    return marker


@dataclass
class Stack:
    tmp: Path
    values: Values
    server_url: str
    fake_url: str
    key_service_port: int
    marker: str

    def fake_log(self) -> list[dict[str, object]]:
        out = _docker("logs", f"{PREFIX}-github").stdout.splitlines()
        events = [json.loads(line) for line in out if line.startswith("{")]
        return [e for e in events if "path" in e]

    def server_python(self, script: str, stdin: dict[str, object]) -> dict[str, object]:
        """Runs Python in the server container; secrets go on stdin, never argv."""
        done = _docker(
            "exec",
            "-i",
            f"{PREFIX}-server",
            "/opt/venv/bin/python",
            "-I",
            "-c",
            script,
            input=json.dumps(stdin),
        )
        return json.loads(done.stdout.strip().splitlines()[-1])

    def computer(
        self,
        name: str,
        *argv: str,
        env: dict[str, str] | None = None,
        user: str = "omnigent",
        check: bool = True,
    ):  # noqa: E501
        flags: list[str] = ["-u", user, "-w", HOME]
        for key, value in {
            "HOME": HOME,
            "PATH": "/opt/venv/bin:/usr/local/bin:/usr/bin:/bin",
            **(env or {}),
        }.items():  # noqa: E501
            flags += ["-e", f"{key}={value}"]
        return _docker("exec", *flags, name, *argv, check=check)


@pytest.fixture(scope="module")
def stack() -> Iterator[Stack]:
    tmp = Path(tempfile.mkdtemp(prefix="cfo-wp59-e2e.", dir=os.environ.get("CFO_E2E_TMP")))
    tmp.chmod(0o755)
    values = Values.new()
    names = [
        f"{PREFIX}-{n}" for n in ("key-service", "github", "server", "computer", "computer-probe")
    ]
    try:
        _ca(tmp)
        marker = _bare_repository(tmp)
        _docker("network", "create", NETWORK)
        # The key service: the Worker's real entrypoint under workerd (`wrangler dev`), in a
        # Node container on the network as `platform.internal`, as the server's intercept names
        # it. It runs as this user, so nothing it writes in the checkout is root's.
        secrets_dir = tmp / "ks"
        secrets_dir.mkdir(mode=0o755)
        root = base64.urlsafe_b64encode(os.urandom(32)).rstrip(b"=").decode()
        (secrets_dir / "env").write_text(
            "SERVER_ENV_OMNIGENT_CREDENTIAL_HTTP_SIGNING_KEY_ID=ks-e2e\n"
            f"SERVER_ENV_OMNIGENT_CREDENTIAL_HTTP_SIGNING_KEY={values.signing_key}\n"
            "CFO_KEY_SERVICE_RECORD_KEYS="
            + json.dumps(
                {"keyId": "ins_e2e.records", "current": 1, "versions": {"1": root}},
                separators=(",", ":"),
            )
            + "\n"
        )
        (secrets_dir / "env").chmod(0o600)
        ks_published = _free_port()
        _docker(
            "run",
            "-d",
            "--name",
            f"{PREFIX}-key-service",
            "--network",
            NETWORK,
            "--network-alias",
            "platform.internal",
            "--user",
            f"{os.getuid()}:{os.getgid()}",
            "-e",
            "HOME=/tmp",
            "-e",
            "WRANGLER_SEND_METRICS=false",
            "-e",
            "CI=1",
            "-v",
            f"{REPO}:{REPO}",
            "-v",
            f"{secrets_dir}:/ks:ro",
            "-w",
            str(REPO / "worker"),
            "-p",
            f"127.0.0.1:{ks_published}:{KEY_SERVICE_PORT}",
            NODE_IMAGE,
            "node",
            "node_modules/wrangler/bin/wrangler.js",
            "dev",
            "-c",
            "test/e2e/wrangler.key-service-e2e.jsonc",
            "--env-file",
            "/ks/env",
            "--ip",
            "0.0.0.0",
            "--port",
            str(KEY_SERVICE_PORT),
            "--persist-to",
            "/tmp/ks-state",
            "--show-interactive-dev-session=false",
        )
        _until(
            "the key service",
            lambda: (
                httpx.post(
                    f"http://127.0.0.1:{ks_published}/key-service/v1/encrypt", timeout=5
                ).status_code
                == 401
            ),
            timeout=180,
        )
        ks_port = KEY_SERVICE_PORT
        # GitHub.
        config = {
            "client_id": values.client_id,
            "client_secret": values.client_secret,
            "access_token": values.access,
            "refresh_token": values.refresh,
            "login": LOGIN,
            "user_id": 4242,
            "redirect_uri": "",
            "repos": "/fake/repos",
            "cert": "/fake/cert.pem",
            "key": "/fake/key.pem",
        }
        server_port = _free_port()
        server_url = f"http://127.0.0.1:{server_port}"
        config["redirect_uri"] = f"{server_url}/v1/connections/github/callback"
        (tmp / "fake" / "config.json").write_text(json.dumps(config))
        (tmp / "fake" / "config.json").chmod(0o644)
        shutil.copy(HERE / "fake_github.py", tmp / "fake" / "fake_github.py")
        fake_port = _free_port()
        _docker(
            "run",
            "-d",
            "--name",
            f"{PREFIX}-github",
            "--network",
            NETWORK,
            "--network-alias",
            "github.com",
            "--network-alias",
            "api.github.com",
            "-p",
            f"127.0.0.1:{fake_port}:443",
            "-v",
            f"{tmp / 'fake'}:/fake:ro",
            "--entrypoint",
            "/opt/venv/bin/python",
            SERVER_IMAGE,
            "-I",
            "/fake/fake_github.py",
            "/fake/config.json",
        )
        _until("the fake GitHub", lambda: '"ready"' in _docker("logs", f"{PREFIX}-github").stdout)
        # The server, with the settings the Worker would pass it.
        server_env = tmp / "server.env"
        server_env.write_text(
            "\n".join(
                f"{k}={v}"
                for k, v in {
                    "CFO_INSTALLATION_INITIALIZED": "false",
                    "CFO_REPLICA_URL": "file:///replica",
                    "CFO_ALLOW_FILE_REPLICA": "true",
                    "CFO_ALLOW_LOCAL_ARTIFACTS": "true",
                    "OMNIGENT_ACCOUNTS_BASE_URL": server_url,
                    "OMNIGENT_ACCOUNTS_COOKIE_SECRET": secrets.token_hex(32),
                    "OMNIGENT_ACCOUNTS_INIT_ADMIN_USERNAME": OWNER,
                    "OMNIGENT_ACCOUNTS_INIT_ADMIN_PASSWORD": values.owner_password,
                    "OMNIGENT_GITHUB_APP_ID": "123456",
                    "OMNIGENT_GITHUB_APP_SLUG": "omnigent-e2e",
                    "OMNIGENT_GITHUB_APP_CLIENT_ID": values.client_id,
                    "OMNIGENT_GITHUB_APP_CLIENT_SECRET": values.client_secret,
                    "OMNIGENT_GITHUB_APP_REDIRECT_URI": config["redirect_uri"],
                    "OMNIGENT_CREDENTIAL_HTTP_SIGNING_KEY_ID": "ks-e2e",
                    "OMNIGENT_CREDENTIAL_HTTP_SIGNING_KEY": values.signing_key,
                    "OMNIGENT_CREDENTIAL_HTTP_URL": f"http://platform.internal:{ks_port}/key-service/v1",
                    "SSL_CERT_FILE": "/fake-ca/ca.pem",
                }.items()
            )
            + "\n"
        )
        server_env.chmod(0o600)
        _docker(
            "run",
            "-d",
            "--name",
            f"{PREFIX}-server",
            "--network",
            NETWORK,
            "--network-alias",
            "server",
            "-p",
            f"127.0.0.1:{server_port}:8000",
            "--env-file",
            str(server_env),
            "-v",
            f"{tmp / 'ca'}:/fake-ca:ro",
            SERVER_IMAGE,
        )
        _until(
            "the server",
            lambda: httpx.get(f"{server_url}/v1/info", timeout=5).status_code == 200,
            timeout=240,
        )
        yield Stack(
            tmp=tmp,
            values=values,
            server_url=server_url,
            fake_url=f"https://127.0.0.1:{fake_port}",
            key_service_port=ks_port,
            marker=marker,
        )
    finally:
        for name in names:
            # Kept with the run's directory when CFO_E2E_KEEP=1 (synthetic values only).
            logs = _docker("logs", name, check=False)
            (tmp / f"{name}.log").write_text(logs.stdout + logs.stderr)
            _docker("rm", "-f", name, check=False)
        _docker("network", "rm", NETWORK, check=False)
        if os.environ.get("CFO_E2E_KEEP") != "1":
            shutil.rmtree(tmp, ignore_errors=True)


SCAN = r"""
import base64, json, os, sys, urllib.parse
values = json.loads(sys.stdin.read())
forms = {}
for name, value in values["secrets"].items():
    for form in (value, base64.b64encode(value.encode()).decode(), urllib.parse.quote(value),
                 base64.b64encode(f"x-access-token:{value}".encode()).decode()):
        forms[form.encode()] = name
found = []
for top in values["roots"]:
    for dirpath, dirnames, filenames in os.walk(top):
        for name in filenames:
            path = os.path.join(dirpath, name)
            if not os.path.isfile(path) or os.path.islink(path):
                continue
            try:
                data = open(path, "rb").read()
            except OSError:
                continue
            for form, secret in forms.items():
                if form in data:
                    found.append([path, secret])
argv = []
for pid in os.listdir("/proc"):
    if pid.isdigit():
        try:
            data = open(f"/proc/{pid}/cmdline", "rb").read()
        except OSError:
            continue
        for form, secret in forms.items():
            if form in data:
                argv.append([pid, secret])
print(json.dumps({"files": found, "argv": argv}))
"""


def _scan(stack: Stack, container: str, roots: list[str]) -> dict[str, list[list[str]]]:
    done = _docker(
        "exec",
        "-i",
        container,
        "python3",
        "-I",
        "-c",
        SCAN,
        input=json.dumps(
            {
                "secrets": {**stack.values.tokens(), "launch token": stack.values.launch},
                "roots": roots,
            }
        ),
    )
    return json.loads(done.stdout.strip().splitlines()[-1])


START_HOST = r"""
import json, subprocess, sys
from pathlib import Path
from cfo_computer.host import StartParams, host_argv, host_env
from cfo_computer.procutil import workload_argv, workload_env
given = json.loads(sys.stdin.read())
params = StartParams(attempt=1, host_id=given["host_id"], host_name="e2e computer",
                     token=given["token"], host_config={})
env = host_env(workload_env(Path("/home/omnigent"), "omnigent"), params)
argv = workload_argv(host_argv("/opt/venv/bin/omnigent", given["server"]), uid=1000, gid=1000,
                     cgroup_dir=None)
log = open("/var/log/cfo-e2e-host.log", "ab")
proc = subprocess.Popen(argv, env=env, stdin=subprocess.DEVNULL, stdout=log, stderr=log,
                        start_new_session=True)
print(json.dumps({"pid": proc.pid}))
"""

MINT = r"""
import json, sys, time
from omnigent.stores.host_store import HostStore
given = json.loads(sys.stdin.read())
HostStore("sqlite:////data/omnigent.db").register_managed_host(
    host_id=given["host_id"], name=given["name"], user_id=given["owner"], token=given["token"],
    provider="cloudflare", sandbox_id=given["name"], token_expires_at=int(time.time()) + 3600)
print(json.dumps({"minted": True}))
"""

AT_REST = r"""
import base64, json, os, subprocess, sqlite3, sys
given = json.loads(sys.stdin.read())
secrets = [s.encode() for s in given["secrets"]]
def holds(path):
    data = open(path, "rb").read()
    return any(s in data for s in secrets)
files = [f for f in os.listdir("/data") if f.startswith("omnigent.db")]
plain_in_db = [f for f in files if holds(os.path.join("/data", f))]
restored = "/tmp/cfo-e2e-restored.db"
if os.path.exists(restored):
    os.remove(restored)
subprocess.run(["litestream", "restore", "-config", "/run/cfo/litestream.yml", "-o", restored,
                "/data/omnigent.db"], check=True, capture_output=True)
with sqlite3.connect(restored) as conn:
    rows = [r[0] for r in conn.execute(
        "SELECT secret_enc FROM connections WHERE provider = 'github'")]
replica_plain = holds(restored)
os.remove(restored)
print(json.dumps({"db_files": files, "plain_in_db": plain_in_db, "replica_rows": rows,
                  "replica_plain": replica_plain}))
"""


def _start_computer(stack: Stack, name: str, host_id: str, server: str) -> None:
    _docker(
        "run",
        "-d",
        "--name",
        name,
        "--network",
        NETWORK,
        "-v",
        f"{stack.tmp / 'ca'}:/fake-ca:ro",
        "--entrypoint",
        "/usr/bin/tini",
        COMPUTER_IMAGE,
        "--",
        "sleep",
        "infinity",
    )
    _docker(
        "exec",
        "-i",
        name,
        "/usr/local/bin/python3",
        "-I",
        "-c",
        START_HOST,
        input=json.dumps({"host_id": host_id, "token": stack.values.launch, "server": server}),
    )


def test_connect_clone_and_unlink_through_the_key_service_and_the_broker(stack: Stack) -> None:
    values = stack.values
    client = httpx.Client(base_url=stack.server_url, timeout=30)
    assert "github" in client.get("/v1/info").json()["enabled_connections"]

    # ── Connect GitHub in Omnigent, as the owner (behind Access on Cloudflare). ──
    signed_in = client.post(
        "/auth/login", json={"username": OWNER, "password": values.owner_password}
    )
    assert signed_in.status_code == 200, signed_in.status_code
    started = client.get("/v1/connections/github/connect", follow_redirects=False)
    assert started.status_code == 302
    authorize = urlsplit(started.headers["location"])
    assert (authorize.netloc, authorize.path) == ("github.com", "/login/oauth/authorize")
    # The browser at GitHub: the fake checks the App and the callback, and sends it back.
    at_github = httpx.get(
        f"{stack.fake_url}{authorize.path}?{authorize.query}",
        headers={"Host": "github.com"},
        verify=False,  # the test's own fake, reached by address from outside its network
        follow_redirects=False,
    )
    assert at_github.status_code == 302, at_github.status_code
    back = urlsplit(at_github.headers["location"])
    assert back.path == "/v1/connections/github/callback"
    assert parse_qs(back.query)["state"] == parse_qs(authorize.query)["state"]
    done = client.get(f"{back.path}?{back.query}", follow_redirects=False)
    assert done.status_code == 302 and "github=connected" in done.headers["location"], done.headers
    status = client.get("/v1/connections/github/status").json()
    assert status["connected"] is True and status["login"] == LOGIN
    exchanged = [e for e in stack.fake_log() if e["path"] == "/login/oauth/access_token"]
    assert [e["status"] for e in exchanged] == [200]
    assert any(e["path"] == "/user" and e["auth"] == "ok" for e in stack.fake_log())

    # ── At rest: ciphertext only, in the database and in its replica. ──
    rest = stack.server_python(AT_REST, {"secrets": [values.access, values.refresh]})
    assert rest["db_files"] and rest["plain_in_db"] == [], rest
    assert len(rest["replica_rows"]) == 1 and rest["replica_rows"][0].startswith(
        "oshttp1:ins_e2e.records:1:"
    ), rest
    assert rest["replica_plain"] is False

    # ── A computer: its host gets a launch token, and git and gh get GitHub through its broker. ──
    host_id = secrets.token_hex(16)
    stack.server_python(
        MINT, {"host_id": host_id, "name": "e2e-computer", "owner": OWNER, "token": values.launch}
    )
    computer = f"{PREFIX}-computer"
    _start_computer(stack, computer, host_id, "http://server:8000")
    sock = _until(
        "the host's credential broker",
        lambda: stack.computer(
            computer, "sh", "-c", "ls /tmp/omnigent-1000/credentials-*.sock", check=False
        ).stdout.strip(),
    )
    clone = stack.computer(
        computer,
        "git",
        "clone",
        f"https://github.com/{LOGIN}/{REPO_NAME}.git",
        "hello",
        env={
            "GIT_SSL_CAINFO": "/fake-ca/ca.pem",
            "GIT_TRACE": f"{HOME}/git-trace.log",
            "GIT_TERMINAL_PROMPT": "0",
        },
        check=False,
    )
    assert clone.returncode == 0, clone.stderr[-2000:]
    readme = stack.computer(computer, "cat", "hello/README.md").stdout
    assert stack.marker in readme
    fetched = [e for e in stack.fake_log() if str(e["path"]).startswith(f"/{LOGIN}/")]
    assert any(e["auth"] == "ok" and e["status"] == 200 for e in fetched)
    gh = stack.computer(
        computer,
        "gh",
        "api",
        "user",
        env={
            "SSL_CERT_FILE": "/fake-ca/ca.pem",
            "OMNIGENT_HOST_BROKER_SOCKET": sock,
            "GH_NO_UPDATE_NOTIFIER": "1",
        },
        check=False,
    )
    assert gh.returncode == 0, gh.stderr[-2000:]
    assert json.loads(gh.stdout)["login"] == LOGIN

    # ── No token on the computer's disk, in ~/.gitconfig, gh's configuration or any argv. ──
    gitconfig = stack.computer(computer, "cat", f"{HOME}/.gitconfig").stdout
    assert "--socket" in gitconfig and "credentials-" in gitconfig
    assert "--host-token" not in gitconfig
    hosts = stack.computer(computer, "cat", f"{HOME}/.config/gh/hosts.yml", check=False).stdout
    assert "ghu_" not in hosts
    found = _scan(stack, computer, [HOME, "/tmp", "/var/tmp", "/root", "/etc"])
    assert found == {"files": [], "argv": []}, found
    host_log = stack.computer(computer, "cat", "/var/log/cfo-e2e-host.log", user="root").stdout
    for name, secret in {**values.tokens(), "launch token": values.launch}.items():
        assert secret not in host_log, f"the host's own log holds the {name}"

    # ── Unlink in Omnigent: the computer gets no new token. ──
    assert client.post("/v1/connections/github/disconnect").status_code == 200
    assert client.get("/v1/connections/github/status").json()["connected"] is False
    fill = stack.computer(
        computer,
        "sh",
        "-c",
        "printf 'protocol=https\\nhost=github.com\\n\\n' | git credential fill",
        env={"GIT_TERMINAL_PROMPT": "0"},
        check=False,
    )
    assert values.access not in fill.stdout and "password=" not in fill.stdout
    again = stack.computer(
        computer,
        "git",
        "ls-remote",
        f"https://github.com/{LOGIN}/{REPO_NAME}.git",
        env={"GIT_SSL_CAINFO": "/fake-ca/ca.pem", "GIT_TERMINAL_PROMPT": "0"},
        check=False,
    )
    assert again.returncode != 0
    last = [e for e in stack.fake_log() if str(e["path"]).startswith(f"/{LOGIN}/")][-1]
    assert last["auth"] == "none" and last["status"] == 401
    # The record is gone from the database too; the token issued before stays valid at GitHub
    # until it expires (D22): unlinking stops new tokens, it does not revoke the old one.
    rest = stack.server_python(AT_REST, {"secrets": [values.access, values.refresh]})
    assert rest["replica_rows"] == [] and rest["plain_in_db"] == []
    found = _scan(stack, computer, [HOME, "/tmp", "/var/tmp", "/root", "/etc"])
    assert found == {"files": [], "argv": []}, found


def test_a_failed_startup_probe_leaves_no_token_on_disk_either(stack: Stack) -> None:
    """The host's credentials probe cannot reach the server: the broker's helper is installed,
    fail-closed, and nothing names a token (core change 17's inconclusive-probe case)."""
    name = f"{PREFIX}-computer-probe"
    _start_computer(stack, name, secrets.token_hex(16), "http://server:9")
    _until(
        "the host's git configuration",
        lambda: "--socket" in stack.computer(name, "cat", f"{HOME}/.gitconfig", check=False).stdout,
        timeout=60,
    )
    gitconfig = stack.computer(name, "cat", f"{HOME}/.gitconfig").stdout
    assert "--host-token" not in gitconfig
    found = _scan(stack, name, [HOME, "/tmp", "/var/tmp", "/root", "/etc"])
    assert found == {"files": [], "argv": []}, found
