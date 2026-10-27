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


@pytest.mark.skipif(not IN_IMAGE, reason="runs inside a server or computer image")
def test_this_images_pips_are_fixed() -> None:
    """pip before 26.2.2 vendors a certifi that trusts both roots."""
    for pip in ("/opt/venv/bin/pip", "/usr/local/bin/pip"):
        out = subprocess.run([pip, "--version"], capture_output=True, text=True, check=True)
        major, minor, patch = (int(x) for x in out.stdout.split()[1].split(".")[:3])
        assert (major, minor, patch) >= (26, 2, 2), out.stdout


@pytest.mark.skipif(not IN_IMAGE, reason="runs inside a server or computer image")
def test_botocore_verifies_with_certifi_not_its_fallback() -> None:
    if subprocess.run([str(VENV_PYTHON), "-I", "-c", "import botocore"]).returncode != 0:
        pytest.skip("botocore is not in this image")
    where, certifi_where = _venv(
        "import botocore.httpsession as h, certifi; print(h.where()); print(certifi.where())"
    ).splitlines()
    assert where == certifi_where
