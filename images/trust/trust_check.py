"""Build-time trust check for the server and computer images (standard library only).

Fails the build when a certificate bundle the image's clients use still trusts a root through
which forged certificates can be chained, or when Debian's ``ca-certificates`` is older than the
release that removed those roots.

October 2026: eight eMudhra intermediate CAs were found to have trivially recoverable private
keys. Public trust reaches them through two roots, so anyone can forge a TLS certificate that
chains to either of them:
  - emSign ECC Root CA - G3 (all four major root programs until October 2026);
  - AAA Certificate Services (Sectigo's cross-signs; still in some vendor stores).
Debian's ``ca-certificates`` 20250419+deb13u1 (trixie) and 20250419~deb12u2 (bookworm) remove
both; certifi 2026.10.19 and later drop the emSign one (certifi never carried the other).

A bundle fails if any certificate in it has a forbidden subject common name or a forbidden
subject public key (SPKI SHA-256), so a re-issued or cross-signed copy of a root is caught too.
OpenSSL, Python's ``ssl``, curl, git and Go programs on the system pool have no key denylist:
the bundle they are given is their whole defence.

    python3 -I trust_check.py --debian-ca-certificates \\
        --bundle /etc/ssl/certs/ca-certificates.crt --bundle "$(python -c 'import certifi; ...')" \\
        --scan /opt/venv --scan /usr/local/lib/python3.12 [--except <a bundle proven unused>]

``--scan`` checks every ``cacert.pem`` below a directory: the bundles Python packages vendor
(certifi's, and pip's own copy of certifi, which pip adds to the system store).
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import re
import subprocess
import sys
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path

# Roots no image bundle may contain: subject common name -> SPKI SHA-256 (hex).
FORBIDDEN_ROOTS: dict[str, str] = {
    "emSign ECC Root CA - G3": "8d417db2dd8bf5e3084d1e3f196d583849d81bdd4c00c70b9d39369e96b8c782",
    "AAA Certificate Services": "bd153ed7b0434f6886b17bce8bbe84ed340c7132d702a8f4fa318f756ecbd6f3",
}
FORBIDDEN_SPKI = {spki: name for name, spki in FORBIDDEN_ROOTS.items()}

# The first Debian release of ca-certificates without either root, per suite (DLA-4845-1 and
# the trixie-security upload of 20 Oct 2026). Another suite fails until it is reviewed here.
MIN_CA_CERTIFICATES = {
    "trixie": "20250419+deb13u1",
    "bookworm": "20250419~deb12u2",
}

_PEM = re.compile(rb"-----BEGIN CERTIFICATE-----\s*(.+?)\s*-----END CERTIFICATE-----", re.S)
_OID_COMMON_NAME = bytes.fromhex("0603550403")  # OBJECT IDENTIFIER 2.5.4.3


class TrustCheckError(Exception):
    """A bundle or package the image must not ship."""


# ── Minimal DER reading: just enough for a certificate's subject and public key ───────────


def _tlv(data: bytes, pos: int) -> tuple[int, int, int, int]:
    """(tag, start of contents, end of contents, end of the element) at ``pos``."""
    tag = data[pos]
    length = data[pos + 1]
    pos += 2
    if length & 0x80:
        count = length & 0x7F
        if count == 0 or count > 4:
            raise ValueError("unsupported DER length")
        length = int.from_bytes(data[pos : pos + count], "big")
        pos += count
    end = pos + length
    if end > len(data):
        raise ValueError("truncated DER element")
    return tag, pos, end, end


def _children(data: bytes, start: int, end: int) -> Iterator[tuple[int, int, int, int]]:
    """Each child element of the constructed element whose contents are data[start:end]."""
    pos = start
    while pos < end:
        tag, cstart, cend, nxt = _tlv(data, pos)
        yield tag, pos, cstart, cend
        pos = nxt


@dataclass(frozen=True)
class Cert:
    common_names: tuple[str, ...]
    spki_sha256: str
    sha256: str


def parse_cert(der: bytes) -> Cert:
    """The subject's common names and the SHA-256 of the subject public key info."""
    tag, start, end, _ = _tlv(der, 0)
    if tag != 0x30:
        raise ValueError("not a certificate")
    tbs_tag, _tbs_pos, tbs_start, tbs_end = next(_children(der, start, end))
    if tbs_tag != 0x30:
        raise ValueError("no tbsCertificate")
    fields = list(_children(der, tbs_start, tbs_end))
    if fields and fields[0][0] == 0xA0:  # [0] version
        fields = fields[1:]
    # serialNumber, signature, issuer, validity, subject, subjectPublicKeyInfo
    if len(fields) < 6:
        raise ValueError("short tbsCertificate")
    _stag, _spos, sstart, send = fields[4]
    _ktag, kpos, _kstart, kend = fields[5]
    names = []
    for _rtag, _rpos, rstart, rend in _children(der, sstart, send):  # each RDN SET
        for _atag, _apos, astart, aend in _children(der, rstart, rend):  # AttributeTypeAndValue
            parts = list(_children(der, astart, aend))
            if len(parts) == 2 and der[parts[0][1] : parts[0][3]] == _OID_COMMON_NAME:
                vtag, _vpos, vstart, vend = parts[1]
                raw = der[vstart:vend]
                names.append(raw.decode("utf-16-be" if vtag == 0x1E else "utf-8", "replace"))
    return Cert(
        common_names=tuple(names),
        spki_sha256=hashlib.sha256(der[kpos:kend]).hexdigest(),
        sha256=hashlib.sha256(der).hexdigest(),
    )


def bundle_certs(path: Path) -> list[Cert]:
    """Every certificate in a PEM bundle. A bundle with none is an error, not a pass."""
    blocks = _PEM.findall(path.read_bytes())
    if not blocks:
        raise TrustCheckError(f"{path}: no certificates found")
    return [parse_cert(base64.b64decode(b"".join(block.split()))) for block in blocks]


def forbidden_in(certs: list[Cert]) -> list[str]:
    """A description of each forbidden root found, by name or by key."""
    found = []
    for cert in certs:
        reasons = [n for n in cert.common_names if n in FORBIDDEN_ROOTS]
        if cert.spki_sha256 in FORBIDDEN_SPKI:
            reasons.append(f"key of {FORBIDDEN_SPKI[cert.spki_sha256]}")
        if reasons:
            label = ", ".join(cert.common_names) or "(no common name)"
            found.append(f"{label} [sha256 {cert.sha256[:16]}…]: {'; '.join(reasons)}")
    return found


def check_bundle(path: Path) -> int:
    certs = bundle_certs(path)
    found = forbidden_in(certs)
    if found:
        raise TrustCheckError(f"{path} still trusts a compromised root: " + " | ".join(found))
    return len(certs)


# ── Debian's ca-certificates ──────────────────────────────────────────────────────────────


def os_codename(os_release: Path = Path("/etc/os-release")) -> str:
    for line in os_release.read_text().splitlines():
        key, _, value = line.partition("=")
        if key == "VERSION_CODENAME":
            return value.strip().strip('"')
    raise TrustCheckError(f"{os_release}: no VERSION_CODENAME")


def check_ca_certificates(
    codename: str, run=subprocess.run, package: str = "ca-certificates"
) -> str:
    minimum = MIN_CA_CERTIFICATES.get(codename)
    if minimum is None:
        raise TrustCheckError(
            f"no known fixed {package} for Debian {codename!r}: review MIN_CA_CERTIFICATES"
        )
    query = run(["dpkg-query", "-W", "-f=${Version}", package], capture_output=True, text=True)
    version = query.stdout.strip()
    if query.returncode != 0 or not version:
        raise TrustCheckError(f"{package} is not installed")
    compare = run(["dpkg", "--compare-versions", version, "ge", minimum])
    if compare.returncode != 0:
        raise TrustCheckError(f"{package} {version} is older than {minimum} ({codename})")
    return version


def scanned_bundles(roots: list[Path], skip: list[Path]) -> list[Path]:
    """Every cacert.pem below the roots, except the named ones (each must exist)."""
    skipped = set()
    for path in skip:
        if not path.is_file():
            raise TrustCheckError(f"--except {path}: no such bundle (review the exception)")
        skipped.add(path.resolve())
    found = []
    for root in roots:
        if not root.is_dir():
            raise TrustCheckError(f"--scan {root}: not a directory")
        found += [
            p
            for p in sorted(root.rglob("cacert.pem"))
            if p.is_file() and p.resolve() not in skipped
        ]
    return found


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--bundle", action="append", default=[], type=Path)
    parser.add_argument(
        "--scan",
        action="append",
        default=[],
        type=Path,
        help="check every cacert.pem below this directory",
    )
    parser.add_argument(
        "--except",
        dest="skip",
        action="append",
        default=[],
        type=Path,
        help="a bundle --scan skips: one the image proves unused",
    )
    parser.add_argument("--debian-ca-certificates", action="store_true")
    args = parser.parse_args(argv)
    if not args.bundle and not args.scan and not args.debian_ca_certificates:
        parser.error("nothing to check")
    try:
        if args.debian_ca_certificates:
            codename = os_codename()
            version = check_ca_certificates(codename)
            print(
                f"trust: ca-certificates {version} ({codename}) is at least "
                f"{MIN_CA_CERTIFICATES[codename]}"
            )
        for path in args.skip:
            print(f"trust: {path}: not checked (--except: the image proves it unused)")
        for path in [*args.bundle, *scanned_bundles(args.scan, args.skip)]:
            count = check_bundle(path)
            print(f"trust: {path}: {count} certificates, none from {' or '.join(FORBIDDEN_ROOTS)}")
    except (TrustCheckError, OSError, ValueError) as exc:
        print(f"trust check failed: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
