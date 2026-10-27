"""Opt-in network probe: each TLS client in an image refuses forged chains and still verifies
the services the platform uses (standard library only; needs outbound HTTPS).

Run it inside a built image, as root, with this directory mounted:

    docker run --rm -v "$PWD/images/trust:/opt/trust:ro" --entrypoint /usr/local/bin/python3 \\
      <image> -I /opt/trust/tls_probe.py [--control] [--json /path] [--good NAME=URL ...]

Forged hosts: the community test hosts for the October 2026 eMudhra key compromise serve a
certificate chained through each compromised path (emSign ECC Root CA - G3, and Sectigo's AAA
Certificate Services cross-sign). Every client must refuse both with a certificate error: a
network error or a timeout proves nothing, so it fails the probe. Good hosts must complete a
handshake: any HTTP answer (a 4xx included) passes.

An answer from the server always counts as acceptance, whatever else the output says; only
then is a certificate error looked for. A client that prints no cause (Codex says only "error
sending request") passes only by a same-path differential: its log must show the TCP connection
was made, and the same command, with the two forged roots added to the trust its own TLS stack
reads, must get an HTTP answer. That control runs for such clients always.

``--control`` runs every client against the forged hosts with the forged roots added through
its own CA-override variable. A client without a key denylist then connects, which shows that
the probe reaches the client's real TLS path and that its refusal comes from trust; a client
that still refuses carries its own denylist. Litestream prints its cause only after ten
attempts, about two minutes.

No credentials are used. Clients that will not start without one get an obviously synthetic
placeholder, which a server could only see after the TLS handshake succeeded.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlsplit

HERE = Path(__file__).resolve().parent
FORGED_ROOTS = [
    HERE / "fixtures" / "emsign-ecc-root-ca-g3.pem",
    HERE / "fixtures" / "aaa-certificate-services.pem",
]
# OpenSSL's subject hashes of the forged roots (`openssl x509 -subject_hash`), for a CA
# directory: the control of a client whose CA override is a directory (SSL_CERT_DIR).
FORGED_ROOT_HASHES = {
    "emsign-ecc-root-ca-g3.pem": "14bc7599.0",
    "aaa-certificate-services.pem": "ee64a828.0",
}
SYSTEM_BUNDLE = Path("/etc/ssl/certs/ca-certificates.crt")

FORGED = {
    "forged-emsign-g3": "https://dv-g3b-emudhra.we-have-a-problem.com/",
    "forged-aaa": "https://dv-g3b-aaa-emudhra.we-have-a-problem.com/",
}
GOOD = {
    "github.com": "https://github.com/",
    "api.anthropic.com": "https://api.anthropic.com/",
    "api.openai.com": "https://api.openai.com/",
    # A public R2 endpoint that answers any name: the r2.dev wildcard (401/404 for no bucket).
    # Account S3 endpoints (<account>.r2.cloudflarestorage.com) refuse unknown names during
    # the handshake, so pass a real one with --good when it matters.
    "r2.dev": "https://pub-00000000000000000000000000000000.r2.dev/",
}
SYNTHETIC = "cfo-tls-probe-synthetic-not-a-credential"

CERT_RE = re.compile(
    r"certificate verify failed|CERTIFICATE_VERIFY_FAILED|SSLCertVerificationError"
    r"|SSL certificate problem|server verification failed|certificate signer not trusted"
    r"|x509: |tls: failed to verify certificate|UNABLE_TO_GET_ISSUER_CERT|CERT_REVOKED"
    r"|certificate revoked|SELF_SIGNED_CERT|unable to get local issuer certificate"
    r"|invalid peer certificate|UnknownIssuer|problem confirming the ssl certificate"
    r"|SSL certificate verification failed|CERT_REJECTED|certificate rejected",
    re.I,
)
NETWORK_RE = re.compile(
    r"Could not resolve|Name or service not known|Temporary failure in name resolution"
    r"|ENOTFOUND|EAI_AGAIN|Connection refused|ECONNREFUSED|Network is unreachable"
    r"|ENETUNREACH|ETIMEDOUT|no such host|Failed to connect|i/o timeout|NewConnectionError",
    re.I,
)

# The forged hosts' page, for clients that print a body (gh does): the handshake succeeded.
CONNECTED_RE = re.compile(r"successfully connected to the site", re.I)

ACCEPTED, REFUSED_CERT, REFUSED_TLS, ERROR = (
    "accepted",
    "refused-certificate",
    "refused-tls",
    "error",
)

PY_HTTP = """
import sys
url = sys.argv[1]
try:
{body}
except Exception as exc:  # the probe classifies the message
    cause, text = exc, []
    while cause is not None and len(text) < 6:
        text.append(f"{{type(cause).__name__}}: {{cause}}")
        cause = cause.__cause__ or cause.__context__
    print("ERROR " + " <- ".join(text))
    sys.exit(2)
"""
PY_CLIENTS = {
    "python-ssl": """
    import urllib.error, urllib.request
    try:
        print("HTTP", urllib.request.urlopen(url, timeout=20).status)
    except urllib.error.HTTPError as e:
        print("HTTP", e.code)
""",
    "httpx": """
    import httpx
    print("HTTP", httpx.get(url, timeout=20).status_code)
""",
    "requests": """
    import requests
    print("HTTP", requests.get(url, timeout=20).status_code)
""",
    # botocore's own HTTPS session, as boto3 builds it: verify=True resolves to
    # botocore.httpsession.where() (certifi when importable). The control passes AWS_CA_BUNDLE.
    "botocore": """
    import os
    from botocore.awsrequest import AWSRequest
    from botocore.httpsession import URLLib3Session
    s = URLLib3Session(verify=os.environ.get("AWS_CA_BUNDLE") or True, timeout=20)
    print("HTTP", s.send(AWSRequest(method="GET", url=url).prepare()).status_code)
""",
}
NODE_FETCH = (
    "fetch(process.argv[1]).then(r => console.log('HTTP', r.status)).catch(e => {"
    " const c = e.cause || {}; console.log('ERROR', c.code || '', c.message || e.message);"
    " process.exit(2); })"
)


@dataclass
class Client:
    name: str
    argv: Callable[[str, Path], list[str]]
    accept: re.Pattern[str]
    env: Callable[[str, Path], dict[str, str]] = lambda url, home: {}
    ca_env: tuple[str, ...] = ("SSL_CERT_FILE",)
    timeout: float = 45.0
    # Its control gets a CA directory (the forged roots by subject hash) instead of a bundle.
    ca_dir: bool = False
    # (output, home) -> whether a failure was a TLS failure after a TCP connection was made.
    # Such a refusal passes only when the same client's control got an HTTP answer.
    tls_failure: Callable[[str, Path], bool] | None = None
    read_logs: Callable[[Path], str] = lambda home: ""


@dataclass
class Result:
    client: str
    host: str
    mode: str
    outcome: str
    detail: str
    extra: dict = field(default_factory=dict)


def _mkdir(path: Path) -> list[str]:
    path.mkdir(parents=True, exist_ok=True)
    return []


def _origin(url: str) -> str:
    parts = urlsplit(url)
    return f"{parts.scheme}://{parts.netloc}"


def _codex_tls_failure(out: str, home: Path) -> bool:
    """The TCP connection was made, then the request failed before any HTTP answer.

    Codex's default client verifies with its vendored OpenSSL against the system bundle and
    logs nothing about TLS. Its control adds the forged roots through SSL_CERT_DIR, which that
    OpenSSL reads, so the control stays on the same TLS path (SSL_CERT_FILE or
    CODEX_CA_CERTIFICATE would switch Codex to a rustls client instead).
    """
    return "error sending request" in out and bool(
        re.search(r"connected to [0-9a-f.:\[\]]+:443", out)
    )


def _codex_logs(home: Path) -> str:
    """Codex writes its trace (RUST_LOG) to its log directory, not to the terminal."""
    lines = []
    for path in sorted((home / ".codex" / "log").glob("*.log")):
        try:
            lines += path.read_text(errors="replace").splitlines()
        except OSError:
            continue
    keep = []
    for line in lines:
        if "Server cert is" in line:  # the chain itself, in hex, is left out
            keep.append(line[: line.index("Server cert is") + len("Server cert is")] + " …")
        elif "connected to" in line or "ERROR" in line:
            keep.append(line)
    return "\n".join(keep)


def _claude_logs(home: Path) -> str:
    latest = home / ".claude" / "debug" / "latest"
    try:
        lines = latest.read_text(errors="replace").splitlines()
    except OSError:
        return ""
    keep = ("Connection error details", "API error")
    return "\n".join(line for line in lines if any(k in line for k in keep))


PIP_ARGS = [
    "download",
    "--no-deps",
    "--no-cache-dir",
    "--disable-pip-version-check",
    "--no-input",
    "-vvv",  # urllib3's status lines: the only evidence of an answer pip prints
    "--retries",
    "0",
    "--timeout",
    "15",
]
# An HTTP status line from urllib3, or the forged page skipped for its content type. pip's own
# "Could not find a version" ends DNS, connection and certificate failures alike.
PIP_ACCEPT = re.compile(
    r'"(GET|HEAD) [^"]* HTTP/1\.[01]" [1-5]\d\d|Skipping page \S+ because the GET request got'
)
# sh -c NEW_VENV_PIP sh <python> <venv> <pip arguments...>
NEW_VENV_PIP = (
    'py=$1 venv=$2; shift 2; "$py" -I -m venv "$venv" && exec "$venv/bin/python" -I -m pip "$@"'
)


def _pip_argv(pip: list[str], url: str, home: Path) -> list[str]:
    return [
        *pip,
        *PIP_ARGS,
        "-d",
        str(home / "dl"),
        "--index-url",
        _origin(url) + "/simple/",
        "cfo-tls-probe",
    ]


def _litestream_argv(url: str, home: Path) -> list[str]:
    config = home / "litestream.yml"
    config.write_text(
        "dbs:\n  - path: " + str(home / "probe.db") + "\n    replica:\n      type: s3\n"
        "      bucket: cfo-tls-probe\n      path: db\n      endpoint: " + _origin(url) + "\n"
        "      region: auto\n      force-path-style: true\n"
        f"      access-key-id: {SYNTHETIC}\n      secret-access-key: {SYNTHETIC}\n"
    )
    return ["litestream", "ltx", "-config", str(config), str(home / "probe.db")]


def discover() -> list[Client]:
    clients: list[Client] = []
    if shutil.which("curl"):
        clients.append(
            Client(
                "curl",
                lambda url, home: [
                    "curl",
                    "-sS",
                    "-o",
                    "/dev/null",
                    "-w",
                    "HTTP %{http_code}\n",
                    "--max-time",
                    "20",
                    url,
                ],
                re.compile(r"HTTP [1-5]\d\d"),
                ca_env=("CURL_CA_BUNDLE",),
            )
        )
    system_python = "/usr/local/bin/python3"
    venv_python = "/opt/venv/bin/python"
    pythons = [("python-ssl", system_python)]
    if Path(venv_python).exists():
        pythons += [("httpx", venv_python), ("requests", venv_python)]
        if (
            subprocess.run(
                [venv_python, "-I", "-c", "import botocore"], capture_output=True
            ).returncode
            == 0
        ):
            pythons.append(("botocore", venv_python))
    ca_vars = {"requests": ("REQUESTS_CA_BUNDLE",), "botocore": ("AWS_CA_BUNDLE",)}
    for name, python in pythons:
        code = PY_HTTP.format(body=PY_CLIENTS[name].strip("\n"))
        clients.append(
            Client(
                name,
                lambda url, home, p=python, c=code: [p, "-I", "-c", c, url],
                re.compile(r"^HTTP \d{3}", re.M),
                ca_env=ca_vars.get(name, ("SSL_CERT_FILE",)),
            )
        )
    pips = {
        "pip-venv": ["/opt/venv/bin/pip"],
        "pip-system": ["/usr/local/bin/pip"],
        # A virtual environment made now: its pip comes from ensurepip's bundled wheel.
        "pip-new-venv": ["/bin/sh", "-c", NEW_VENV_PIP, "sh", system_python, "{venv}"],
    }
    for label, pip in pips.items():
        if Path(pip[0]).exists():
            clients.append(
                Client(
                    label,
                    lambda url, home, p=pip: _pip_argv(
                        [a.replace("{venv}", str(home / "venv")) for a in p], url, home
                    ),
                    PIP_ACCEPT,
                    ca_env=("PIP_CERT",),
                    timeout=60.0,
                )
            )
    if shutil.which("node"):
        clients.append(
            Client(
                "node-fetch",
                lambda url, home: ["node", "-e", NODE_FETCH, url],
                re.compile(r"^HTTP \d{3}", re.M),
                ca_env=("NODE_EXTRA_CA_CERTS",),
            )
        )
    if shutil.which("git"):
        clients.append(
            Client(
                "git",
                lambda url, home: [
                    "git",
                    "-c",
                    "http.lowSpeedLimit=1",
                    "-c",
                    "http.lowSpeedTime=20",
                    "ls-remote",
                    _origin(url) + "/cfo-tls-probe.git",
                ],
                re.compile(
                    r"not found|could not read Username|returned error: \d{3}|HTTP \d{3}"
                    r"|Authentication failed|unexpected http"
                    r"|not valid: is this a git repository",
                    re.I,
                ),
                env=lambda url, home: {"GIT_TERMINAL_PROMPT": "0"},
                ca_env=("GIT_SSL_CAINFO",),
            )
        )
    if Path("/usr/local/bin/gh").exists():  # the real binary, not the broker wrapper
        clients.append(
            Client(
                "gh",
                lambda url, home: ["/usr/local/bin/gh", "api", "-X", "GET", "meta"],
                re.compile(
                    r"HTTP \d{3}|invalid character|unexpected end of JSON|\"verifiable", re.I
                ),
                env=lambda url, home: {
                    "GH_HOST": urlsplit(url).hostname or "",
                    "GH_TOKEN": SYNTHETIC,
                    "GH_ENTERPRISE_TOKEN": SYNTHETIC,
                    "GH_CONFIG_DIR": str(home / "gh"),
                    "GH_PROMPT_DISABLED": "1",
                    "GH_NO_UPDATE_NOTIFIER": "1",
                },
            )
        )
    if Path("/usr/local/bin/codex").exists():
        # The sign-in client: one request to <issuer>/api/accounts/deviceauth/usercode. Codex
        # builds it with the same HTTP client crate as its model client (codex_http_client).
        clients.append(
            Client(
                "codex",
                lambda url, home: [
                    *_mkdir(home / ".codex"),
                    "/usr/local/bin/codex",
                    "login",
                    "--device-auth",
                    "--experimental_issuer",
                    _origin(url),
                ],
                re.compile(
                    r"not enabled|unexpected status|status \d{3}|error decoding"
                    r"|expected value|one-time code|Follow these steps",
                    re.I,
                ),
                env=lambda url, home: {
                    "CODEX_HOME": str(home / ".codex"),
                    "RUST_LOG": "warn,hyper_util=debug,reqwest=debug",
                },
                ca_env=("SSL_CERT_DIR",),
                ca_dir=True,
                tls_failure=_codex_tls_failure,
                read_logs=_codex_logs,
                timeout=40.0,
            )
        )
    if Path("/usr/local/bin/claude").exists():
        clients.append(
            Client(
                "claude",
                lambda url, home: [
                    "/usr/local/bin/claude",
                    "-p",
                    "reply ok",
                    "--max-turns",
                    "1",
                    "--debug",
                ],
                re.compile(
                    r"API Error: \d{3}|Invalid API key"
                    r"|API error \(attempt \d+/\d+\): [1-5]\d\d",
                    re.I,
                ),
                env=lambda url, home: {
                    "ANTHROPIC_BASE_URL": _origin(url),
                    "ANTHROPIC_API_KEY": SYNTHETIC,
                    "CLAUDE_CODE_MAX_RETRIES": "0",
                    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
                    "DISABLE_AUTOUPDATER": "1",
                },
                ca_env=("NODE_EXTRA_CA_CERTS",),
                read_logs=_claude_logs,
                timeout=60.0,
            )
        )
    if shutil.which("litestream"):
        clients.append(
            Client(
                "litestream",
                _litestream_argv,
                # Litestream retries ten times (about two minutes) before it prints the cause.
                # An answer, or an empty listing (the forged hosts answer 200 with a text page).
                re.compile(r"StatusCode: [1-5]\d\d|api error|^level\s+min_txid", re.I | re.M),
                timeout=180.0,
            )
        )
    return clients


def classify(client: Client, out: str, home: Path, timed_out: bool) -> tuple[str, str]:
    """An answer from the server first: it proves the handshake, whatever else was printed."""
    lines = [line for line in out.splitlines() if line.strip()]
    for pattern in (CONNECTED_RE, client.accept):
        hit = next((line for line in lines if pattern.search(line)), "")
        if hit:
            return ACCEPTED, hit.strip()[:240]
    if CERT_RE.search(out) and not NETWORK_RE.search(out):
        hit = next((line for line in lines if CERT_RE.search(line)), "")
        return REFUSED_CERT, hit.strip()[:240]
    if client.tls_failure and client.tls_failure(out, home):
        chain = "; rustls received the chain" if "Server cert is" in out else ""
        return REFUSED_TLS, f"TCP connected{chain}, then no HTTP answer (no cause printed)"
    tail = (lines[-1] if lines else "").strip()[:240]
    return ERROR, ("timeout; " if timed_out else "") + tail


def run_one(client: Client, host: str, url: str, trust: dict[str, Path] | None) -> Result:
    """One run, and one more when the first ends in an unclassified error (a reset, say)."""
    result = _run_once(client, host, url, trust)
    if result.outcome == ERROR:
        first = result.detail
        result = _run_once(client, host, url, trust)
        result.extra["first_attempt"] = first
    return result


def _run_once(client: Client, host: str, url: str, trust: dict[str, Path] | None) -> Result:
    with tempfile.TemporaryDirectory(prefix="tls-probe-") as tmp:
        home = Path(tmp)
        env = {
            "PATH": os.environ.get("PATH", "/usr/local/bin:/usr/bin:/bin"),
            "HOME": str(home),
            "LANG": "C.UTF-8",
            "NO_COLOR": "1",
        }
        env.update(client.env(url, home))
        if trust is not None:
            source = trust["dir" if client.ca_dir else "bundle"]
            env.update({name: str(source) for name in client.ca_env})
        try:
            proc = subprocess.run(
                client.argv(url, home),
                env=env,
                cwd=home,
                stdin=subprocess.DEVNULL,
                capture_output=True,
                text=True,
                errors="replace",
                timeout=client.timeout,
            )
            out, timed_out = proc.stdout + proc.stderr, False
        except subprocess.TimeoutExpired as exc:
            out = (
                ((exc.stdout or b"") + (exc.stderr or b"")).decode("utf-8", "replace")
                if isinstance(exc.stdout, bytes)
                else (exc.stdout or "") + (exc.stderr or "")
            )
            timed_out = True
        out += "\n" + client.read_logs(home)
        outcome, detail = classify(client, out, home, timed_out)
        return Result(client.name, host, "control" if trust else "default", outcome, detail)


def control_trust(directory: Path) -> dict[str, Path]:
    """The system bundle plus the forged roots, as a file; the forged roots alone, as a CA
    directory (OpenSSL reads it besides the default bundle)."""
    bundle = directory / "with-forged-roots.pem"
    parts = [SYSTEM_BUNDLE.read_text()] + [p.read_text() for p in FORGED_ROOTS]
    bundle.write_text("\n".join(parts))
    hashed = directory / "forged-roots"
    hashed.mkdir()
    for root in FORGED_ROOTS:
        (hashed / FORGED_ROOT_HASHES[root.name]).write_text(root.read_text())
    return {"bundle": bundle, "dir": hashed}


def versions() -> dict[str, str]:
    probes = {
        "curl": ["curl", "--version"],
        "node": ["node", "--version"],
        "git": ["git", "--version"],
        "gh": ["/usr/local/bin/gh", "--version"],
        "codex": ["/usr/local/bin/codex", "--version"],
        "claude": ["/usr/local/bin/claude", "--version"],
        "litestream": ["litestream", "version"],
        "pip-venv": ["/opt/venv/bin/pip", "--version"],
        "pip-system": ["/usr/local/bin/pip", "--version"],
        "certifi": [
            "/opt/venv/bin/python",
            "-I",
            "-c",
            "import certifi; print(certifi.__version__, certifi.where())",
        ],
        "ca-certificates": ["dpkg-query", "-W", "-f=${Version}", "ca-certificates"],
    }
    found = {}
    for name, argv in probes.items():
        try:
            proc = subprocess.run(
                argv,
                capture_output=True,
                text=True,
                timeout=30,
                env={"PATH": os.environ.get("PATH", ""), "HOME": "/tmp"},
            )
        except (OSError, subprocess.TimeoutExpired):
            continue
        if proc.returncode == 0:
            found[name] = (proc.stdout.strip().splitlines() or [""])[0][:120]
    return found


def evaluate(results: list[Result]) -> list[str]:
    """Failures: a forged host not refused for trust, or a good host without a handshake.

    A certificate error passes. A TLS failure with no cause printed passes only when the same
    client's control (the forged roots trusted, same TLS path) got an HTTP answer; anything
    else, a network error or a timeout included, fails.
    """
    control = {(r.client, r.host): r for r in results if r.mode == "control"}
    failures = []
    for r in results:
        if r.mode != "default":
            continue
        if r.host in FORGED:
            if r.outcome == REFUSED_CERT:
                continue
            ctl = control.get((r.client, r.host))
            if r.outcome == REFUSED_TLS and ctl is not None and ctl.outcome == ACCEPTED:
                r.extra["refusal"] = "same-path differential: answered once the roots were trusted"
                continue
            if r.outcome == REFUSED_TLS:
                failures.append(
                    f"{r.client} {r.host}: inconclusive, no certificate evidence "
                    f"({r.detail}; control: {ctl.outcome if ctl else 'not run'})"
                )
                continue
            failures.append(f"{r.client} {r.host}: {r.outcome} ({r.detail})")
        elif r.outcome != ACCEPTED:
            failures.append(f"{r.client} {r.host}: {r.outcome} ({r.detail})")
    return failures


def redact(results: list[Result], extra_good: dict[str, str]) -> None:
    """A host given with --good appears in the results by its NAME only."""
    hosts = {urlsplit(url).hostname: name for name, url in extra_good.items()}
    for r in results:
        for host, name in hosts.items():
            if not host:
                continue
            r.detail = r.detail.replace(host, f"<{name}>")
            r.extra = {
                k: v.replace(host, f"<{name}>") if isinstance(v, str) else v
                for k, v in r.extra.items()
            }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--control",
        action="store_true",
        help="also run the forged hosts with the forged roots trusted",
    )
    parser.add_argument(
        "--good",
        action="append",
        default=[],
        metavar="NAME=URL",
        help="another host that must verify; reported by NAME only",
    )
    parser.add_argument("--only", action="append", default=[], help="limit to these clients")
    parser.add_argument("--json", type=Path, help="write the results here")
    args = parser.parse_args(argv)
    good = dict(GOOD)
    for item in args.good:
        name, _, url = item.partition("=")
        if not name or not url.startswith("https://"):
            parser.error(f"--good wants NAME=https://...: {item!r}")
        good[name] = url
    clients = [c for c in discover() if not args.only or c.name in args.only]
    with tempfile.TemporaryDirectory(prefix="tls-probe-ca-") as tmp:
        trust = control_trust(Path(tmp))
        jobs = [(c, h, u, None) for c in clients for h, u in {**FORGED, **good}.items()]
        # The control: for every client with --control, always for one that prints no cause.
        jobs += [
            (c, h, u, trust)
            for c in clients
            if args.control or c.tls_failure is not None
            for h, u in FORGED.items()
        ]
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(lambda job: run_one(*job), jobs))
    redact(results, {n: u for n, u in good.items() if n not in GOOD})
    failures = evaluate(results)
    order = {h: i for i, h in enumerate([*FORGED, *good])}
    results.sort(key=lambda r: (r.mode != "default", r.client, order.get(r.host, 99)))
    for r in results:
        note = f" [{r.extra['refusal']}]" if r.extra.get("refusal") else ""
        print(f"{r.mode:8} {r.client:11} {r.host:20} {r.outcome:20} {r.detail}{note}")
    report = {
        "versions": versions(),
        "results": [r.__dict__ for r in results],
        "failures": failures,
    }
    if args.json:
        args.json.write_text(json.dumps(report, indent=1) + "\n")
    print(json.dumps(report["versions"], indent=1))
    if failures:
        print("FAILED:\n  " + "\n  ".join(failures))
        return 1
    print(
        f"tls probe: {len(clients)} clients refused both forged chains and verified "
        f"{len(good)} good hosts"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
