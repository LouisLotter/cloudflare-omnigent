"""The build-time trust check (images/trust/trust_check.py), and the image it runs in.

The forged-chain roots are real public certificates (fixtures/), so the check is tested against
the bundles it must refuse. Inside either image's test target, the image's own bundles must pass.
"""

from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path

import pytest

TRUST = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(TRUST))

import trust_check  # noqa: E402

FIXTURES = TRUST / "fixtures"
G3 = FIXTURES / "emsign-ecc-root-ca-g3.pem"
AAA = FIXTURES / "aaa-certificate-services.pem"
CLEAN = FIXTURES / "isrg-root-x1.pem"
VENV_PYTHON = Path("/opt/venv/bin/python")
IN_IMAGE = VENV_PYTHON.exists() and Path("/etc/debian_version").exists()


def _bundle(tmp_path: Path, *parts: Path, name: str = "bundle.pem") -> Path:
    path = tmp_path / name
    path.write_text("\n".join(p.read_text() for p in parts))
    return path


def test_each_fixture_is_the_root_the_table_names() -> None:
    """The table's SPKI hashes were taken from these certificates (checked against openssl)."""
    for path, name in ((G3, "emSign ECC Root CA - G3"), (AAA, "AAA Certificate Services")):
        (cert,) = trust_check.bundle_certs(path)
        assert cert.common_names == (name,)
        assert cert.spki_sha256 == trust_check.FORBIDDEN_ROOTS[name]
    (clean,) = trust_check.bundle_certs(CLEAN)
    assert clean.common_names == ("ISRG Root X1",)
    assert trust_check.forbidden_in([clean]) == []


@pytest.mark.parametrize("bad", [G3, AAA], ids=["emsign-g3", "aaa"])
def test_a_bundle_holding_either_root_fails(tmp_path: Path, bad: Path) -> None:
    path = _bundle(tmp_path, CLEAN, bad, CLEAN)
    with pytest.raises(trust_check.TrustCheckError, match="still trusts a compromised root"):
        trust_check.check_bundle(path)
    assert trust_check.main(["--bundle", str(path)]) == 1


def test_a_clean_bundle_passes(tmp_path: Path) -> None:
    path = _bundle(tmp_path, CLEAN, CLEAN)
    assert trust_check.check_bundle(path) == 2
    assert trust_check.main(["--bundle", str(path)]) == 0


def test_a_root_is_caught_by_its_key_or_its_name_alone() -> None:
    aaa_key = trust_check.FORBIDDEN_ROOTS["AAA Certificate Services"]
    by_key = trust_check.Cert(("Renamed Root",), aaa_key, "0" * 64)
    by_name = trust_check.Cert(("emSign ECC Root CA - G3",), "f" * 64, "1" * 64)
    found = trust_check.forbidden_in([by_key, by_name])
    assert len(found) == 2
    assert "key of AAA Certificate Services" in found[0]
    assert "emSign ECC Root CA - G3" in found[1]


def test_a_file_without_certificates_is_an_error(tmp_path: Path) -> None:
    empty = tmp_path / "empty.pem"
    empty.write_text("# no certificates here\n")
    assert trust_check.main(["--bundle", str(empty)]) == 1
    assert trust_check.main(["--bundle", str(tmp_path / "missing.pem")]) == 1


def test_scan_checks_every_vendored_bundle_except_the_named_one(tmp_path: Path) -> None:
    (tmp_path / "pkg" / "certifi").mkdir(parents=True)
    (tmp_path / "pkg" / "pip" / "_vendor" / "certifi").mkdir(parents=True)
    (tmp_path / "pkg" / "botocore").mkdir(parents=True)
    _bundle(tmp_path / "pkg" / "certifi", CLEAN, name="cacert.pem")
    _bundle(tmp_path / "pkg" / "pip" / "_vendor" / "certifi", CLEAN, name="cacert.pem")
    fallback = _bundle(tmp_path / "pkg" / "botocore", CLEAN, AAA, name="cacert.pem")
    root = str(tmp_path / "pkg")
    assert len(trust_check.scanned_bundles([Path(root)], [])) == 3
    assert trust_check.main(["--scan", root]) == 1
    assert trust_check.main(["--scan", root, "--except", str(fallback)]) == 0
    # A vendored copy that still trusts a root fails even when the active one is clean.
    _bundle(tmp_path / "pkg" / "pip" / "_vendor" / "certifi", CLEAN, G3, name="cacert.pem")
    assert trust_check.main(["--scan", root, "--except", str(fallback)]) == 1


def test_scan_reads_bundles_inside_wheels(tmp_path: Path) -> None:
    """ensurepip seeds every new virtual environment from a bundled pip wheel."""
    import zipfile

    bundled = tmp_path / "ensurepip" / "_bundled"
    bundled.mkdir(parents=True)
    wheel = bundled / "pip-25.0.1-py3-none-any.whl"
    with zipfile.ZipFile(wheel, "w") as zf:
        zf.writestr("pip/_vendor/certifi/cacert.pem", G3.read_text() + CLEAN.read_text())
        zf.writestr("pip/__init__.py", "")
    found = trust_check.scanned_bundles([tmp_path], [])
    assert found == [f"{wheel}!pip/_vendor/certifi/cacert.pem"]
    assert trust_check.main(["--scan", str(tmp_path)]) == 1
    with zipfile.ZipFile(wheel, "w") as zf:
        zf.writestr("pip/_vendor/certifi/cacert.pem", CLEAN.read_text())
    assert trust_check.main(["--scan", str(tmp_path)]) == 0
    (bundled / "broken.whl").write_text("not a zip")
    assert trust_check.main(["--scan", str(tmp_path)]) == 1


def test_an_exception_must_name_a_real_bundle(tmp_path: Path) -> None:
    assert trust_check.main(["--scan", str(tmp_path), "--except", str(tmp_path / "gone.pem")]) == 1
    assert trust_check.main(["--scan", str(tmp_path / "not-a-dir")]) == 1


def test_os_codename(tmp_path: Path) -> None:
    release = tmp_path / "os-release"
    release.write_text('PRETTY_NAME="Debian GNU/Linux 13 (trixie)"\nVERSION_CODENAME=trixie\n')
    assert trust_check.os_codename(release) == "trixie"
    release.write_text("ID=debian\n")
    with pytest.raises(trust_check.TrustCheckError):
        trust_check.os_codename(release)


def _dpkg_with(version: str | None):
    """dpkg-query reports ``version``; the comparison is the real dpkg's."""

    def run(argv, **kwargs):
        if argv[0] == "dpkg-query":
            if version is None:
                return subprocess.CompletedProcess(argv, 1, "", "not installed")
            return subprocess.CompletedProcess(argv, 0, version, "")
        return subprocess.run(argv, **kwargs)

    return run


@pytest.mark.skipif(shutil.which("dpkg") is None, reason="needs Debian's dpkg")
@pytest.mark.parametrize(
    ("codename", "version", "ok"),
    [
        ("trixie", "20250419", False),
        ("trixie", "20250419+deb13u1", True),
        ("trixie", "20250419+deb13u2", True),
        ("trixie", "20260816+nmu1", True),
        ("bookworm", "20230311+deb12u1", False),
        ("bookworm", "20250419~deb12u1", False),
        ("bookworm", "20250419~deb12u2", True),
    ],
)
def test_ca_certificates_minimum_per_suite(codename: str, version: str, ok: bool) -> None:
    if ok:
        assert trust_check.check_ca_certificates(codename, run=_dpkg_with(version)) == version
    else:
        with pytest.raises(trust_check.TrustCheckError, match="older than"):
            trust_check.check_ca_certificates(codename, run=_dpkg_with(version))


def test_ca_certificates_unknown_suite_or_missing_package_fails() -> None:
    with pytest.raises(trust_check.TrustCheckError, match="no known fixed"):
        trust_check.check_ca_certificates("forky", run=_dpkg_with("20260816+nmu1"))
    with pytest.raises(trust_check.TrustCheckError, match="not installed"):
        trust_check.check_ca_certificates("trixie", run=_dpkg_with(None))


# ── Inside an image's test target: the image's own bundles ───────────────────────────────


def _venv(code: str) -> str:
    return subprocess.run(
        [str(VENV_PYTHON), "-I", "-c", code], capture_output=True, text=True, check=True
    ).stdout.strip()


@pytest.mark.skipif(not IN_IMAGE, reason="runs inside a server or computer image")
def test_this_images_bundles_pass() -> None:
    certifi_bundle = _venv("import certifi; print(certifi.where())")
    argv = [
        "--debian-ca-certificates",
        "--bundle",
        "/etc/ssl/certs/ca-certificates.crt",
        "--bundle",
        certifi_bundle,
        "--scan",
        "/opt/venv",
        "--scan",
        "/usr/local/lib/python3.12",
    ]
    fallback = Path("/opt/venv/lib/python3.12/site-packages/botocore/cacert.pem")
    if fallback.exists():
        argv += ["--except", str(fallback)]
    assert trust_check.main(argv) == 0


def _pip_version(*argv: str) -> tuple[int, ...]:
    out = subprocess.run([*argv, "--version"], capture_output=True, text=True, check=True)
    return tuple(int(x) for x in out.stdout.split()[1].split(".")[:3])


@pytest.mark.skipif(not IN_IMAGE, reason="runs inside a server or computer image")
def test_this_images_pips_are_fixed(tmp_path: Path) -> None:
    """pip before 26.2.2 vendors a certifi that trusts both roots: the venv's, the system
    Python's, and the one ensurepip seeds into every new virtual environment."""
    assert _pip_version("/opt/venv/bin/pip") >= (26, 2, 2)
    assert _pip_version("/usr/local/bin/pip") >= (26, 2, 2)
    venv = tmp_path / "venv"
    subprocess.run(["/usr/local/bin/python3", "-I", "-m", "venv", str(venv)], check=True)
    assert _pip_version(str(venv / "bin" / "python"), "-I", "-m", "pip") >= (26, 2, 2)


@pytest.mark.skipif(not IN_IMAGE, reason="runs inside a server or computer image")
def test_botocore_verifies_with_certifi_not_its_fallback() -> None:
    if subprocess.run([str(VENV_PYTHON), "-I", "-c", "import botocore"]).returncode != 0:
        pytest.skip("botocore is not in this image")
    where, certifi_where = _venv(
        "import botocore.httpsession as h, certifi; print(h.where()); print(certifi.where())"
    ).splitlines()
    assert where == certifi_where


# ── Malformed input and the command line ─────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("der", "message"),
    [
        (bytes.fromhex("3080"), "unsupported DER length"),  # indefinite length
        (bytes.fromhex("3085" + "01" * 5), "unsupported DER length"),  # a 5-byte length
        (bytes.fromhex("3005" + "0000"), "truncated DER element"),
        (bytes.fromhex("0400"), "not a certificate"),  # an OCTET STRING
        (bytes.fromhex("30020400"), "no tbsCertificate"),
        (bytes.fromhex("3004" + "3002" + "0200"), "short tbsCertificate"),  # serial only
    ],
)
def test_malformed_certificates_are_errors(der: bytes, message: str) -> None:
    with pytest.raises(ValueError, match=message):
        trust_check.parse_cert(der)


def test_a_bundle_with_a_malformed_certificate_fails(tmp_path: Path) -> None:
    import base64

    bad = tmp_path / "bad.pem"
    body = base64.b64encode(bytes.fromhex("30020400")).decode()
    bad.write_text(f"-----BEGIN CERTIFICATE-----\n{body}\n-----END CERTIFICATE-----\n")
    assert trust_check.main(["--bundle", str(bad)]) == 1


def test_a_certificate_without_a_version_field_parses() -> None:
    """Version 1 certificates omit the [0] version: the subject is then the fifth field."""
    (cert,) = trust_check.bundle_certs(CLEAN)
    der = _der(CLEAN)
    # Rebuild ISRG Root X1's tbsCertificate without its [0] version element.
    _tag, start, end, _ = trust_check._tlv(der, 0)
    _t, tbs_pos, tbs_start, tbs_end = next(trust_check._children(der, start, end))
    fields = list(trust_check._children(der, tbs_start, tbs_end))
    assert fields[0][0] == 0xA0
    first_kept = fields[1][1]
    body = der[first_kept:tbs_end]
    tbs = bytes([0x30]) + _length(len(body)) + body
    v1 = bytes([0x30]) + _length(len(tbs)) + tbs
    parsed = trust_check.parse_cert(v1)
    assert parsed.common_names == cert.common_names
    assert parsed.spki_sha256 == cert.spki_sha256


def _der(path: Path) -> bytes:
    import base64

    text = path.read_text()
    body = text.split("-----BEGIN CERTIFICATE-----")[1].split("-----END CERTIFICATE-----")[0]
    return base64.b64decode("".join(body.split()))


def _length(n: int) -> bytes:
    if n < 0x80:
        return bytes([n])
    raw = n.to_bytes((n.bit_length() + 7) // 8, "big")
    return bytes([0x80 | len(raw)]) + raw


def test_the_command_line_needs_something_to_check() -> None:
    with pytest.raises(SystemExit):
        trust_check.main([])


def test_the_command_line_checks_the_installed_ca_certificates(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    release = tmp_path / "os-release"
    release.write_text("VERSION_CODENAME=forky\n")
    real = trust_check.os_codename
    monkeypatch.setattr(trust_check, "os_codename", lambda: real(release))
    assert trust_check.main(["--debian-ca-certificates"]) == 1
    assert "no known fixed ca-certificates for Debian 'forky'" in capsys.readouterr().err
