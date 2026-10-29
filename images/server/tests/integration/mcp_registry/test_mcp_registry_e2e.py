"""Omnigent's MCP registry end to end, locally (WP5.10; RC-40, RC-41, RC-46, RC-47 in part).

The pieces, each the real one:
- **the key service:** the platform Worker's real ``PlatformInternal`` entrypoint under
  ``wrangler dev`` (workerd), with Worker secrets from an env file, reached by the server as
  ``http://platform.internal:<port>/key-service/v1``, as on Cloudflare through the server's
  intercept (``worker/test/e2e/key-service-e2e.ts``, WP5.9's harness);
- **the server:** the server image (its final target, as Wrangler builds it), with the settings
  the installer's ``services add tracker`` stores, so the image builds Omnigent's registry from
  its shipped manifest (``images/server/services/tracker.json``) and the installation's choices;
- **the MCP service:** Omnigent's own demo OAuth MCP service
  (``examples/mcp-registry/demo_service.py``, from the image's copy of the fork, run by
  ``run_demo.py``) over HTTPS, as ``mcp-demo.example.test`` on the test's network, with a
  certificate from the test's own authority (the server trusts it through ``SSL_CERT_FILE``). No
  test switch: the destination rules apply as in production;
- **a computer:** the computer image, where the runner's own client
  (``omnigent.runner.proxy_mcp_manager.ProxyMcpManager``) calls the gateway with a runner's
  delegated owner token, as a runner on a cloud computer does. Shortcut: the token is minted in
  the server container with Omnigent's own ``mint_runner_token`` (a runner's launch is tested
  elsewhere), and the computer reaches the server directly instead of through its intercept and
  the platform's computer route (WP5.13 checks those on Cloudflare).

Flow: Settings → MCP's connect (Omnigent's redirect with PKCE, the provider's consent, the
callback); the login only as ciphertext through the key service, in the database and its
replica; a session with the service selected; calls from the computer (the allowlist, a refresh
that rotates the tokens); a canary scan of the computer, of exactly what a checkpoint of it would
hold, and of every container's log: no MCP login anywhere; disconnect; the next call from the
computer fails at once; the record gone from the replica.

Run from the repository root, after building the images and installing the worker's packages:

    docker build -f images/server/Dockerfile -t cfo-wp510-server:runtime .
    docker build -f images/computer/Dockerfile --target runtime -t cfo-wp510-computer:runtime .
    pnpm install
    uv run --no-project --with pytest==9.1.1 --with httpx==0.28.1 --with cryptography==46.0.3 \\
      pytest -p no:cacheprovider -s images/server/tests/integration/mcp_registry

Every value is generated for the run; containers, the network and the temporary directory
(``CFO_E2E_TMP`` or the system's) are removed afterwards. Docker resources are named
``cfo-wp510-e2e-*``.
"""

from __future__ import annotations

import base64
import datetime
import io
import json
import os
import secrets
import shutil
import socket
import subprocess
import tarfile
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
SERVER_IMAGE = os.environ.get("CFO_E2E_SERVER_IMAGE", "cfo-wp510-server:runtime")
COMPUTER_IMAGE = os.environ.get("CFO_E2E_COMPUTER_IMAGE", "cfo-wp510-computer:runtime")
PREFIX = "cfo-wp510-e2e"
NETWORK = f"{PREFIX}-net"
OWNER = "owner"
DEMO_HOST = "mcp-demo.example.test"
DEMO_ACCOUNT = "alice@example.test"
HOME = "/home/omnigent"
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
    raise AssertionError(f"timed out waiting for {what}: {type(last).__name__}")


@dataclass
class Values:
    """Every secret of the run: synthetic, generated now, never printed."""

    signing_key: str
    state_secret: str
    owner_password: str
    cookie_secret: str

    @classmethod
    def new(cls) -> Values:
        return cls(
            signing_key=secrets.token_hex(32),
            state_secret=secrets.token_hex(32),
            owner_password=secrets.token_urlsafe(18),
            cookie_secret=secrets.token_hex(32),
        )


def _ca(tmp: Path) -> None:
    """A test authority, and a certificate for the demo service's name from it."""
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.x509.oid import NameOID

    now = datetime.datetime.now(datetime.UTC)
    ca_key = ec.generate_private_key(ec.SECP256R1())
    ca_name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "cfo-wp510 e2e test authority")])
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
        .subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, DEMO_HOST)]))
        .issuer_name(ca_name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - datetime.timedelta(minutes=5))
        .not_valid_after(now + datetime.timedelta(days=1))
        .add_extension(x509.SubjectAlternativeName([x509.DNSName(DEMO_HOST)]), critical=False)
        .add_extension(x509.ExtendedKeyUsage([x509.oid.ExtendedKeyUsageOID.SERVER_AUTH]), False)
        .sign(ca_key, hashes.SHA256())
    )
    (tmp / "ca").mkdir()
    (tmp / "ca" / "ca.pem").write_bytes(ca.public_bytes(serialization.Encoding.PEM))
    (tmp / "demo").mkdir()
    (tmp / "demo" / "cert.pem").write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    (tmp / "demo" / "key.pem").write_bytes(
        key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        )
    )
    for path in (tmp / "ca", tmp / "demo"):
        path.chmod(0o755)
    for path in (tmp / "ca" / "ca.pem", tmp / "demo" / "cert.pem", tmp / "demo" / "key.pem"):
        path.chmod(0o644)


@dataclass
class Stack:
    tmp: Path
    values: Values
    server_url: str
    demo_url: str

    def server_python(self, script: str, stdin: dict[str, object], *env: str) -> dict[str, object]:
        """Runs Python in the server container; secrets go on stdin, never argv."""
        flags: list[str] = []
        for item in env:
            flags += ["-e", item]
        done = _docker(
            "exec",
            "-i",
            *flags,
            f"{PREFIX}-server",
            "/opt/venv/bin/python",
            "-I",
            "-c",
            script,
            input=json.dumps(stdin),
        )
        return json.loads(done.stdout.strip().splitlines()[-1])

    def computer_python(self, script: str, stdin: dict[str, object]) -> dict[str, object]:
        """Runs Python on the computer, as the person's account; secrets on stdin."""
        done = _docker(
            "exec",
            "-i",
            "-u",
            "omnigent",
            "-w",
            HOME,
            "-e",
            f"HOME={HOME}",
            f"{PREFIX}-computer",
            "/opt/venv/bin/python",
            "-I",
            "-c",
            script,
            input=json.dumps(stdin),
            timeout=120,
        )
        return json.loads(done.stdout.strip().splitlines()[-1])


@pytest.fixture(scope="module")
def stack() -> Iterator[Stack]:
    tmp = Path(tempfile.mkdtemp(prefix="cfo-wp510-e2e.", dir=os.environ.get("CFO_E2E_TMP")))
    tmp.chmod(0o755)
    values = Values.new()
    names = [f"{PREFIX}-{n}" for n in ("key-service", "demo", "server", "computer")]
    try:
        _ca(tmp)
        _docker("network", "create", NETWORK)
        # The key service: the Worker's real entrypoint under workerd, as `platform.internal`.
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
        # The demo MCP service, over HTTPS, under its public-looking name.
        server_port = _free_port()
        server_url = f"http://127.0.0.1:{server_port}"
        shutil.copy(HERE / "run_demo.py", tmp / "demo" / "run_demo.py")
        demo_port = _free_port()
        _docker(
            "run",
            "-d",
            "--name",
            f"{PREFIX}-demo",
            "--network",
            NETWORK,
            "--network-alias",
            DEMO_HOST,
            "-p",
            f"127.0.0.1:{demo_port}:443",
            "-v",
            f"{tmp / 'demo'}:/demo:ro",
            "--entrypoint",
            "/opt/venv/bin/python",
            SERVER_IMAGE,
            "-I",
            "/demo/run_demo.py",
            "--public-host",
            DEMO_HOST,
            "--redirect-uri",
            f"{server_url}/v1/connections/mcp-tracker/callback",
            "--port",
            "443",
            "--tls-cert",
            "/demo/cert.pem",
            "--tls-key",
            "/demo/key.pem",
        )
        demo_url = f"https://127.0.0.1:{demo_port}"
        _until(
            "the demo service",
            lambda: httpx.get(f"{demo_url}/health", verify=False, timeout=5).status_code == 200,
        )
        # The server, with the settings the Worker would pass it after `services add tracker`.
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
                    "OMNIGENT_ACCOUNTS_COOKIE_SECRET": values.cookie_secret,
                    "OMNIGENT_ACCOUNTS_INIT_ADMIN_USERNAME": OWNER,
                    "OMNIGENT_ACCOUNTS_INIT_ADMIN_PASSWORD": values.owner_password,
                    "OMNIGENT_CREDENTIAL_HTTP_SIGNING_KEY_ID": "ks-e2e",
                    "OMNIGENT_CREDENTIAL_HTTP_SIGNING_KEY": values.signing_key,
                    "OMNIGENT_CREDENTIAL_HTTP_URL": (
                        f"http://platform.internal:{KEY_SERVICE_PORT}/key-service/v1"
                    ),
                    "OMNIGENT_MCP_OAUTH_STATE_SECRET": values.state_secret,
                    "CFO_MCP_SERVICES": "tracker",
                    "CFO_MCP_ORIGIN_TRACKER": f"https://{DEMO_HOST}",
                    "CFO_MCP_REVISION": secrets.token_hex(16),
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
        # A computer, idle: the runner's client runs in it, as the person's account.
        _docker(
            "run",
            "-d",
            "--name",
            f"{PREFIX}-computer",
            "--network",
            NETWORK,
            "--entrypoint",
            "/usr/bin/tini",
            COMPUTER_IMAGE,
            "--",
            "sleep",
            "infinity",
        )
        yield Stack(tmp=tmp, values=values, server_url=server_url, demo_url=demo_url)
    finally:
        for name in names:
            # Kept with the run's directory when CFO_E2E_KEEP=1 (synthetic values only).
            logs = _docker("logs", name, check=False)
            (tmp / f"{name}.log").write_text(logs.stdout + logs.stderr)
            _docker("rm", "-f", name, check=False)
        _docker("network", "rm", NETWORK, check=False)
        if os.environ.get("CFO_E2E_KEEP") != "1":
            shutil.rmtree(tmp, ignore_errors=True)


#: The login as Omnigent's own store holds it: read in the server container with the key
#: service, so the test knows the values to look for everywhere else. ``expire`` makes the next
#: use refresh it, as an access token near its end does.
LOGIN = r"""
import json, sys, time
from omnigent.stores.credential_store import build_secret_cipher
from omnigent.stores.credential_store.sqlalchemy_store import CredentialStore
given = json.loads(sys.stdin.read())
store = CredentialStore("sqlite:////data/omnigent.db", build_secret_cipher())
conn = store.get("owner", "mcp:tracker", with_secret=True)
if conn is None:
    print(json.dumps({"connected": False}))
    raise SystemExit
if given.get("expire"):
    assert store.update_secret("owner", "mcp:tracker", secret=conn.secret,
                               metadata={"expires_at": 0})
print(json.dumps({"connected": True, "access": conn.secret["access_token"],
                  "refresh": conn.secret.get("refresh_token")}))
"""
KEY_SERVICE_ENV = ("OMNIGENT_CREDENTIAL_CIPHER=http", "NO_PROXY=platform.internal")

#: A runner's delegated owner token, as Omnigent mints one for a runner it binds: its own
#: ``mint_runner_token``, under the owner's account generation (from the owner's session).
MINT_RUNNER = r"""
import base64, json, sys
from omnigent.db.account_authority import account_authority_scope
from omnigent.server.auth import create_auth_provider
given = json.loads(sys.stdin.read())
part = given["session"].split(".")[1]
claims = json.loads(base64.urlsafe_b64decode(part + "=" * (-len(part) % 4)))
with account_authority_scope("owner", claims["account_generation"]):
    token = create_auth_provider().mint_runner_token("owner", 900)
print(json.dumps({"token": token}))
"""
RUNNER_ENV = ("OMNIGENT_AUTH_PROVIDER=accounts", "OMNIGENT_AUTH_ENABLED=1")

#: The runner's own MCP client, on the computer, with the runner's token: the gateway's tool
#: list, then each call, and how long each took.
RUNNER_CALLS = r"""
import asyncio, json, os, sys, time
import httpx
from omnigent.runner.proxy_mcp_manager import ProxyMcpManager
from omnigent.spec.types import AgentSpec, MCPServerConfig
given = json.loads(sys.stdin.read())
spec = AgentSpec(spec_version=1, name="mcp-e2e",
                 mcp_servers=[MCPServerConfig(name="tracker", transport="registry")])
async def main():
    async with httpx.AsyncClient(base_url=given["server"], timeout=60,
                                 headers={"Authorization": "Bearer " + given["token"]}) as http:
        proxy = ProxyMcpManager(given["session"], http)
        tools = sorted((await proxy.schemas_for(spec)).tool_names)
        results = []
        for name, args in given["calls"]:
            started = time.monotonic()
            text = await proxy.call_tool(spec, name, args)
            results.append({"text": text, "seconds": time.monotonic() - started})
        return {"tools": tools, "results": results}
out = asyncio.run(main())
# What an agent keeps of its work: the results, in the workspace a checkpoint saves.
os.makedirs(os.path.expanduser("~/work/mcp-e2e"), exist_ok=True)
with open(os.path.expanduser(f"~/work/mcp-e2e/results-{time.time_ns()}.json"), "w") as f:
    json.dump(out, f)
print(json.dumps(out))
"""

AT_REST = r"""
import json, os, subprocess, sqlite3, sys
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
        "SELECT secret_enc FROM connections WHERE provider = 'mcp:tracker'")]
replica_plain = holds(restored)
os.remove(restored)
print(json.dumps({"db_files": files, "plain_in_db": plain_in_db, "replica_rows": rows,
                  "replica_plain": replica_plain}))
"""

#: Every file under the roots, and every process's argv and environment, for the logins in every
#: form; then exactly what a checkpoint of this computer would hold: the computer's own scan of
#: its home under the checkpoint policy (cfo_computer.tree.scan_home), and the declared login
#: files of the credential checkpoint.
SCAN = r"""
import base64, json, os, sys, urllib.parse
sys.path.insert(0, "/opt/cfo")
from cfo_computer.contract import DECLARED_CREDENTIAL_PATHS
from cfo_computer.policy import Policy
from cfo_computer.tree import scan_home
given = json.loads(sys.stdin.read())
forms = {}
for name, value in given["secrets"].items():
    for form in (value, base64.b64encode(value.encode()).decode(), urllib.parse.quote(value)):
        forms[form.encode()] = name
def hits(data):
    return sorted({secret for form, secret in forms.items() if form in data})
found = []
for top in given["roots"]:
    for dirpath, dirnames, filenames in os.walk(top):
        for name in filenames:
            path = os.path.join(dirpath, name)
            if not os.path.isfile(path) or os.path.islink(path):
                continue
            try:
                data = open(path, "rb").read()
            except OSError:
                continue
            for secret in hits(data):
                found.append([path, secret])
procs = []
for pid in os.listdir("/proc"):
    if pid.isdigit():
        for part in ("cmdline", "environ"):
            try:
                data = open(f"/proc/{pid}/{part}", "rb").read()
            except OSError:
                continue
            for secret in hits(data):
                procs.append([pid, part, secret])
home = given["home"]
policy = Policy.load("/opt/cfo/contracts/checkpoint-policy-v1.json")
scan = scan_home(home, policy, declared=DECLARED_CREDENTIAL_PATHS)
saved = [rel for rel, st in scan.entries]
checkpoint = []
for rel in [*saved, *DECLARED_CREDENTIAL_PATHS]:
    path = os.path.join(home, rel)
    if os.path.isfile(path) and not os.path.islink(path):
        for secret in hits(open(path, "rb").read()):
            checkpoint.append([rel, secret])
print(json.dumps({"files": found, "procs": procs, "checkpoint": checkpoint,
                  "checkpoint_entries": len(saved)}))
"""


def _bundle(name: str) -> bytes:
    body = (
        f"spec_version: 1\nname: {name}\n"
        "executor:\n  type: omnigent\n  config:\n    harness: codex\n"
    ).encode()
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w:gz") as tar:
        info = tarfile.TarInfo("config.yaml")
        info.size = len(body)
        tar.addfile(info, io.BytesIO(body))
    return buffer.getvalue()


def _scan(stack: Stack, logins: dict[str, str]) -> dict[str, object]:
    done = _docker(
        "exec",
        "-i",
        f"{PREFIX}-computer",
        "/usr/local/bin/python3",
        "-I",
        "-c",
        SCAN,
        input=json.dumps(
            {
                "secrets": logins,
                "roots": [HOME, "/tmp", "/var/tmp", "/root", "/etc", "/opt", "/var/log"],
                "home": HOME,
            }
        ),
        timeout=600,
    )
    return json.loads(done.stdout.strip().splitlines()[-1])


def test_connect_call_from_a_computer_and_disconnect(stack: Stack) -> None:
    values = stack.values
    client = httpx.Client(base_url=stack.server_url, timeout=60)
    assert client.get("/v1/info").json()["enabled_connections"] == ["mcp"]

    # ── Connect in Settings → MCP, as the owner (behind Access on Cloudflare). ──
    signed_in = client.post(
        "/auth/login", json={"username": OWNER, "password": values.owner_password}
    )
    assert signed_in.status_code == 200, signed_in.status_code
    session_token = signed_in.json()["token"]
    catalog = client.get("/v1/mcp-registry/services").json()["data"]
    assert [(s["id"], s["connected"], s["tools"]) for s in catalog] == [
        ("tracker", False, ["whoami", "read_ticket"])
    ]
    started = client.get("/v1/connections/mcp-tracker/connect", follow_redirects=False)
    assert started.status_code in (302, 307)
    authorize = urlsplit(started.headers["location"])
    assert (authorize.scheme, authorize.netloc, authorize.path) == (
        "https",
        DEMO_HOST,
        "/authorize",
    )
    fields = {k: v[0] for k, v in parse_qs(authorize.query).items()}
    assert fields["code_challenge_method"] == "S256" and fields["client_id"] == (
        "omnigent-local-demo"
    )
    # The browser at the provider: its consent page, then back to Omnigent's callback.
    consent = httpx.post(
        f"{stack.demo_url}/authorize",
        data={**fields, "user": DEMO_ACCOUNT},
        headers={"Host": DEMO_HOST},
        verify=False,  # the test's own service, reached by address from outside its network
        follow_redirects=False,
    )
    assert consent.status_code == 303, consent.status_code
    back = urlsplit(consent.headers["location"])
    assert back.path == "/v1/connections/mcp-tracker/callback"
    # A wrong state is refused, and changes nothing (RC-46 in part).
    query = parse_qs(back.query)
    forged = client.get(f"{back.path}?code={query['code'][0]}&state=forged", follow_redirects=False)
    assert "mcp-tracker=connected" not in forged.headers.get("location", "")
    done = client.get(f"{back.path}?{back.query}", follow_redirects=False)
    assert done.status_code in (302, 307), done.status_code
    assert "mcp-tracker=connected" in done.headers["location"]
    assert done.headers["x-cfo-durability"] == "confirmed"
    # The same code again is refused: the pending flow was used once (RC-46 in part).
    again = client.get(f"{back.path}?{back.query}", follow_redirects=False)
    assert "mcp-tracker=connected" not in again.headers.get("location", "")
    assert client.get("/v1/mcp-registry/services").json()["data"][0]["connected"] is True
    tested = client.post("/v1/mcp-registry/services/tracker/test")
    assert tested.json() == {"tools": ["whoami", "read_ticket"]}, tested.status_code

    login = stack.server_python(LOGIN, {}, *KEY_SERVICE_ENV)
    assert login["connected"] is True
    first = {"access": str(login["access"]), "refresh": str(login["refresh"])}

    # ── At rest: ciphertext only, in the database and in its replica. ──
    rest = stack.server_python(AT_REST, {"secrets": list(first.values())})
    assert rest["db_files"] and rest["plain_in_db"] == [], rest
    assert len(rest["replica_rows"]) == 1
    assert rest["replica_rows"][0].startswith("oshttp1:ins_e2e.records:1:")
    assert rest["replica_plain"] is False

    # ── A session with the service selected; a runner on the computer calls it. ──
    created = client.post(
        "/v1/sessions",
        data={"metadata": json.dumps({"mcp_registry_services": ["tracker"]})},
        files={"bundle": ("agent.tar.gz", _bundle("mcp-e2e"), "application/gzip")},
    )
    assert created.status_code == 201, created.status_code
    session = created.json()["session_id"]
    runner = stack.server_python(MINT_RUNNER, {"session": session_token}, *RUNNER_ENV)["token"]
    calls = stack.computer_python(
        RUNNER_CALLS,
        {
            "server": "http://server:8000",
            "token": runner,
            "session": session,
            "calls": [
                ["tracker__whoami", {}],
                ["tracker__read_ticket", {"ticket_id": "TEST-123"}],
                ["tracker__delete_ticket", {"ticket_id": "TEST-123"}],
            ],
        },
    )
    # The allowlist: delete_ticket exists at the service and is never offered or run.
    assert calls["tools"] == ["tracker__read_ticket", "tracker__whoami"]
    whoami, ticket, delete = (r["text"] for r in calls["results"])
    assert DEMO_ACCOUNT in whoami and '"refresh_count": 0' in whoami
    assert "TEST-123" in ticket and "Open" in ticket
    assert "Deleted fictional ticket" not in delete

    # ── A refresh, as when the access token nears its end: rotated, stored as ciphertext. ──
    stack.server_python(LOGIN, {"expire": True}, *KEY_SERVICE_ENV)
    refreshed = stack.computer_python(
        RUNNER_CALLS,
        {
            "server": "http://server:8000",
            "token": runner,
            "session": session,
            "calls": [["tracker__whoami", {}]],
        },
    )
    assert '"refresh_count": 1' in refreshed["results"][0]["text"]
    second = stack.server_python(LOGIN, {}, *KEY_SERVICE_ENV)
    assert second["refresh"] != first["refresh"] and second["access"] != first["access"]
    logins = {
        "first access token": first["access"],
        "first refresh token": first["refresh"],
        "access token": str(second["access"]),
        "refresh token": str(second["refresh"]),
        "OAuth state secret": values.state_secret,
        "key service signing key": values.signing_key,
    }
    rest = stack.server_python(AT_REST, {"secrets": list(logins.values())})
    assert rest["plain_in_db"] == [] and rest["replica_plain"] is False, rest

    # ── RC-41: no MCP login on the computer, in what a checkpoint would hold, or in a log. ──
    found = _scan(stack, logins)
    assert found["files"] == [] and found["procs"] == [], found
    assert found["checkpoint"] == [], found
    # The checkpoint holds the agent's work (the results), and no login.
    assert found["checkpoint_entries"] >= 3, found
    for name in (f"{PREFIX}-server", f"{PREFIX}-key-service", f"{PREFIX}-computer"):
        logs = _docker("logs", name, check=False)
        text = logs.stdout + logs.stderr
        for what, value in logins.items():
            assert value not in text, f"{name}'s log holds the {what}"
    # The key service sealed and opened the login, and refused nothing.
    ks_log = _docker("logs", f"{PREFIX}-key-service", check=False)
    ks_text = ks_log.stdout + ks_log.stderr
    assert "encrypt" in ks_text and "decrypt" in ks_text

    # ── Disconnect: durable at once; the next call from the computer fails at once. ──
    gone = client.delete("/v1/mcp-registry/services/tracker/connection")
    assert gone.status_code == 200 and gone.headers["x-cfo-durability"] == "confirmed"
    after = stack.computer_python(
        RUNNER_CALLS,
        {
            "server": "http://server:8000",
            "token": runner,
            "session": session,
            "calls": [["tracker__whoami", {}]],
        },
    )
    assert after["tools"] == []
    (failed,) = after["results"]
    assert "Connect this MCP account" in failed["text"], failed["text"][:200]
    assert failed["seconds"] < 5
    assert stack.server_python(LOGIN, {}, *KEY_SERVICE_ENV) == {"connected": False}
    rest = stack.server_python(AT_REST, {"secrets": list(logins.values())})
    assert rest["replica_rows"] == [] and rest["plain_in_db"] == []
    assert client.get("/v1/mcp-registry/services").json()["data"][0]["connected"] is False
