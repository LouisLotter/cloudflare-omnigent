"""The network probe's verdicts (images/trust/tls_probe.py), offline.

The outputs are what each client printed against the forged and good hosts in the images
(October 2026). A refusal counts only as a certificate refusal: a network error, a reset or a
timeout fails the probe, and so does a forged host that answered.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

import pytest

TRUST = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(TRUST))

import tls_probe  # noqa: E402

HOME = Path("/nonexistent")


def _client(name: str = "any", accept: str = r"^HTTP \d{3}", tls_failure=None) -> tls_probe.Client:
    return tls_probe.Client(
        name, lambda url, home: [], re.compile(accept, re.M), tls_failure=tls_failure
    )


@pytest.mark.parametrize(
    "out",
    [
        "curl: (60) SSL certificate problem: unable to get local issuer certificate\nHTTP 000",
        "ERROR CERT_REVOKED certificate revoked",
        'Get "https://x/api/v3/meta": tls: failed to verify certificate: x509: certificate'
        " signed by unknown authority",
        "fatal: unable to access 'https://x/': server verification failed: certificate signer"
        " not trusted. (CAfile: /etc/ssl/certs/ca-certificates.crt CRLfile: none)",
        "ERROR ConnectError: [SSL: CERTIFICATE_VERIFY_FAILED] certificate verify failed",
        "API Error: Unable to connect to API: SSL certificate verification failed"
        " (UNABLE_TO_GET_ISSUER_CERT_LOCALLY).",
        # Claude Code 2.1.311, also with the forged roots trusted: its own filter.
        "[ERROR] Connection error details: code=CERT_REJECTED (SSL error), message=certificate"
        " rejected",
        "Error: operation error S3: ListObjectsV2, exceeded maximum number of attempts, 10, https"
        " response error StatusCode: 0, RequestID: , HostID: , request send failed, Get"
        ' "https://x/b": tls: failed to verify certificate: x509: certificate signed by unknown'
        " authority",
    ],
)
def test_certificate_refusals(out: str) -> None:
    assert (
        tls_probe.classify(_client(accept=r"StatusCode: [1-5]\d\d|^HTTP [1-5]"), out, HOME, False)[
            0
        ]
        == tls_probe.REFUSED_CERT
    )


def test_a_network_error_is_not_a_refusal() -> None:
    out = "curl: (6) Could not resolve host: dv-g3b-emudhra.we-have-a-problem.com"
    assert tls_probe.classify(_client(), out, HOME, False)[0] == tls_probe.ERROR
    # Even when certificate words appear alongside it.
    out = "NewConnectionError: Failed to establish a new connection (certificate verify failed?)"
    assert tls_probe.classify(_client(), out, HOME, False)[0] == tls_probe.ERROR


@pytest.mark.parametrize(
    ("accept", "out"),
    [
        (r"^HTTP \d{3}", "HTTP 200"),  # httpx with certifi 2026.5.20 on the emSign host
        (r"API Error: \d{3}", "API Error: 405 only GET, HEAD and OPTIONS"),  # Claude 2.1.302
        (
            tls_probe.PIP_ACCEPT.pattern,
            "WARNING: Skipping page https://x/simple/p/ because the GET request got Content-Type:"
            " text/plain",
        ),  # pip 25.0.1
        (tls_probe.PIP_ACCEPT.pattern, 'https://github.com:443 "GET /simple/p/ HTTP/1.1" 404 None'),
        (r"HTTP \d{3}", "Your client successfully connected to the site. That's bad!"),  # gh body
    ],
)
def test_an_answer_from_the_server_means_the_chain_was_accepted(accept: str, out: str) -> None:
    assert tls_probe.classify(_client(accept=accept), out, HOME, False)[0] == tls_probe.ACCEPTED


@pytest.mark.parametrize(
    "out",
    [
        # The forged page's text with certificate words around it (a body, a retry log).
        "Your client successfully connected to the site. That's bad!\ncertificate revoked",
        "HTTP 200\n[SSL: CERTIFICATE_VERIFY_FAILED] certificate verify failed (first attempt)",
    ],
)
def test_an_answer_wins_over_certificate_text(out: str) -> None:
    assert tls_probe.classify(_client(), out, HOME, False)[0] == tls_probe.ACCEPTED


@pytest.mark.parametrize(
    "out",
    [
        "Could not fetch URL https://x/simple/p/: connection error: Failed to resolve IP address"
        " for 'x' ([Errno -2] Name or service not known) - skipping\nERROR: Could not find a"
        " version that satisfies the requirement p (from versions: none)",
        "Could not fetch URL https://x/simple/p/: connection error: ('Connection aborted.',"
        " ConnectionResetError(104, 'Connection reset by peer')) - skipping\nERROR: Could not"
        " find a version that satisfies the requirement p (from versions: none)",
        "ERROR: Could not find a version that satisfies the requirement p (from versions: none)",
    ],
)
def test_pips_no_version_message_is_not_an_answer(out: str) -> None:
    pip = _client("pip-venv", accept=tls_probe.PIP_ACCEPT.pattern)
    assert tls_probe.classify(pip, out, HOME, False)[0] == tls_probe.ERROR


def test_a_reset_or_a_timeout_is_an_error() -> None:
    reset = (
        "[ERROR] Connection error details: code=ECONNRESET, message=ECONNRESET: The socket"
        " connection was closed unexpectedly."
    )
    assert tls_probe.classify(_client(), reset, HOME, False)[0] == tls_probe.ERROR
    outcome, detail = tls_probe.classify(_client(), "s3 request ...", HOME, True)
    assert outcome == tls_probe.ERROR and detail.startswith("timeout")


def test_codex_counts_a_tls_failure_only_after_a_tcp_connection() -> None:
    codex = _client("codex", accept="not enabled", tls_failure=tls_probe._codex_tls_failure)
    after_connect = (
        "DEBUG hyper_util::client::legacy::connect::http: connected to 54.39.60.141:443\n"
        "TRACE rustls::client::tls13: Server cert is …\n"
        "Error logging in with device code: error sending request for url (https://x/)"
    )
    openssl_path = after_connect.replace("TRACE rustls::client::tls13: Server cert is …\n", "")
    no_connect = "Error logging in with device code: error sending request for url (https://x/)"
    assert tls_probe.classify(codex, after_connect, HOME, False)[0] == tls_probe.REFUSED_TLS
    assert tls_probe.classify(codex, no_connect, HOME, False)[0] == tls_probe.ERROR
    # The default client (vendored OpenSSL) logs no TLS detail: the TCP connection is enough.
    outcome, detail = tls_probe.classify(codex, openssl_path, HOME, False)
    assert outcome == tls_probe.REFUSED_TLS and "rustls" not in detail
    assert "rustls received the chain" in tls_probe.classify(codex, after_connect, HOME, False)[1]
    answered = "Error logging in with device code: device code login is not enabled for this server"
    assert tls_probe.classify(codex, answered, HOME, False)[0] == tls_probe.ACCEPTED


def _r(client: str, host: str, outcome: str, mode: str = "default") -> tls_probe.Result:
    return tls_probe.Result(client, host, mode, outcome, "")


def test_evaluate_fails_an_accepted_forged_host_and_an_unverified_good_host() -> None:
    results = [
        _r("httpx", "forged-emsign-g3", tls_probe.ACCEPTED),
        _r("httpx", "forged-aaa", tls_probe.REFUSED_CERT),
        _r("httpx", "github.com", tls_probe.REFUSED_CERT),
        _r("httpx", "api.openai.com", tls_probe.ACCEPTED),
    ]
    failures = tls_probe.evaluate(results)
    assert [f.split(":")[0] for f in failures] == ["httpx forged-emsign-g3", "httpx github.com"]


def test_a_refusal_without_a_cause_passes_only_by_the_same_path_control() -> None:
    def run(control_outcome: str | None) -> list[str]:
        results = [_r("codex", "forged-aaa", tls_probe.REFUSED_TLS)]
        if control_outcome:
            results.append(_r("codex", "forged-aaa", control_outcome, mode="control"))
        return tls_probe.evaluate(results)

    assert run(tls_probe.ACCEPTED) == []
    for control_outcome in (None, tls_probe.REFUSED_TLS, tls_probe.ERROR):
        (failure,) = run(control_outcome)
        assert "inconclusive" in failure


def test_an_error_fails_even_when_the_control_connected() -> None:
    """A network error, a reset or a timeout is never a refusal, whatever the control did."""
    results = [
        _r("litestream", "forged-aaa", tls_probe.ERROR),
        _r("litestream", "forged-aaa", tls_probe.ACCEPTED, mode="control"),
    ]
    assert len(tls_probe.evaluate(results)) == 1


def test_a_good_host_given_by_name_is_redacted_everywhere() -> None:
    r = _r("git", "r2-s3-api", tls_probe.ACCEPTED)
    r.detail = "fatal: unable to access 'https://0123abcd.r2.example.com/x.git/': error: 400"
    r.extra["first_attempt"] = "Could not resolve host: 0123abcd.r2.example.com"
    tls_probe.redact([r], {"r2-s3-api": "https://0123abcd.r2.example.com/"})
    assert "0123abcd" not in r.detail + str(r.extra)
    assert "<r2-s3-api>" in r.detail and "<r2-s3-api>" in r.extra["first_attempt"]


def test_the_control_trust_holds_the_forged_roots(tmp_path: Path) -> None:
    if not tls_probe.SYSTEM_BUNDLE.exists():
        pytest.skip("needs the system bundle")
    trust = tls_probe.control_trust(tmp_path)
    text = trust["bundle"].read_text()
    for root in tls_probe.FORGED_ROOTS:
        assert root.read_text().strip() in text
        assert (trust["dir"] / tls_probe.FORGED_ROOT_HASHES[root.name]).read_text() == (
            root.read_text()
        )


def test_the_probe_uses_no_credential() -> None:
    assert "synthetic-not-a-credential" in tls_probe.SYNTHETIC
    for url in [*tls_probe.FORGED.values(), *tls_probe.GOOD.values()]:
        assert url.startswith("https://") and "@" not in url


def test_codex_reads_its_trace_from_its_log_directory(tmp_path: Path) -> None:
    log = tmp_path / ".codex" / "log"
    log.mkdir(parents=True)
    (log / "codex-login.log").write_text(
        "TRACE checkout waiting\nDEBUG hyper_util::client::legacy::connect::http: connected to"
        " 54.39.60.141:443\nTRACE rustls::client::tls13: Server cert is CertificateChain([0x30])\n"
        "TRACE reqwest::retry: shouldn't retry!\n"
    )
    logs = tls_probe._codex_logs(tmp_path)
    assert "connected to 54.39.60.141:443" in logs
    assert "Server cert is …" in logs and "0x30" not in logs
    assert tls_probe._codex_logs(tmp_path / "missing") == ""


def test_an_empty_litestream_listing_is_an_answer() -> None:
    litestream = _client(accept=r"StatusCode: [1-5]\d\d|api error|^level\s+min_txid")
    litestream.accept = re.compile(litestream.accept.pattern, re.I | re.M)
    out = "level  min_txid  max_txid  size  created"
    assert tls_probe.classify(litestream, out, HOME, False)[0] == tls_probe.ACCEPTED
