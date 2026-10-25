"""RC-53's scan: no live token in any published workspace layer.

    python3 -I images/computer/tools/rc53_scan.py --values <file> [--controls <file>] PATH...

Each PATH is a staged layer directory, a restored tree, or a layer archive as DirectoryBackup
stores it (``tar+zstd``; also plain tar and tar.gz). Archives are decompressed and walked
member by member. ``--values`` names a file with one secret per line (the launch token, runner
binding tokens, every generation of delegated owner tokens, any GitHub token, the logins);
``--controls`` names the canaries planted in every layer, each of which must be found in
every PATH, so a clean result means something.

Each value is looked for raw, JSON-escaped, URL-encoded, as hex, as base64 and base64url at
each of the three alignments (with and without padding), and as UTF-16LE, in every file's raw
bytes. SQLite databases (and their ``-wal``) are also opened from a private copy and every text
and blob value read back, so a token split across overflow pages or still in the WAL is seen.

The report names files, forms and value labels (the line number in ``--values``), never a
value. Exit status: 0 clean, 1 a value found or a control missing, 3 incomplete (an archive or
file that could not be read: never treated as clean), 2 usage.
"""

from __future__ import annotations

import argparse
import base64
import io
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import tarfile
import tempfile
import urllib.parse
from pathlib import Path

SQLITE_MAGIC = b"SQLite format 3\x00"
ZSTD_MAGIC = b"\x28\xb5\x2f\xfd"
GZIP_MAGIC = b"\x1f\x8b"
MAX_MEMBER_BYTES = 1 << 30


def forms(value: str) -> dict[str, bytes]:
    """Every encoded form of ``value`` the scan looks for, by name."""
    raw = value.encode()
    out = {
        "raw": raw,
        "json": json.dumps(value)[1:-1].encode(),
        "url": urllib.parse.quote(value, safe="").encode(),
        "url-plus": urllib.parse.quote_plus(value).encode(),
        "hex": raw.hex().encode(),
        "HEX": raw.hex().upper().encode(),
        "utf16le": value.encode("utf-16-le"),
    }
    for shift in range(3):
        padded = b"\0" * shift + raw
        for name, enc in (("b64", base64.b64encode), ("b64url", base64.urlsafe_b64encode)):
            text = enc(padded).decode()
            # Characters that depend only on the value's own bytes (no neighbour bits).
            start = ((shift + 2) // 3) * 4 if shift else 0
            end = ((shift + len(raw)) // 3) * 4
            core = text[start:end]
            if len(core) >= 8:
                out[f"{name}@{shift}"] = core.encode()
    return {k: v for k, v in out.items() if len(v) >= 8}


class Scan:
    def __init__(self, values: list[str], controls: list[str]) -> None:
        self.values = [(f"value {i + 1}", forms(v)) for i, v in enumerate(values) if v]
        self.controls = [(f"control {i + 1}", v.encode()) for i, v in enumerate(controls) if v]
        self.findings: list[dict[str, str]] = []
        self.incomplete: list[dict[str, str]] = []
        self.files = 0
        self.seen_controls: set[str] = set()

    def bytes(self, where: str, data: bytes) -> None:
        self.files += 1
        for label, encoded in self.values:
            for form, needle in encoded.items():
                if needle in data:
                    self.findings.append({"file": where, "form": form, "value": label})
        for label, needle in self.controls:
            if needle in data:
                self.seen_controls.add(label)
        if data.startswith(SQLITE_MAGIC):
            self.sqlite(where, data, b"")

    def sqlite(self, where: str, data: bytes, wal: bytes) -> None:
        tmp = tempfile.mkdtemp(prefix="rc53-")
        try:
            db = Path(tmp, "db")
            db.write_bytes(data)
            if wal:
                Path(tmp, "db-wal").write_bytes(wal)
            con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
            try:
                tables = [r[0] for r in con.execute("select name from sqlite_master where type='table'")]
                for table in tables:
                    for row in con.execute(f'select * from "{table.replace(chr(34), chr(34) * 2)}"'):
                        for cell in row:
                            if isinstance(cell, str):
                                self._cell(where, cell.encode())
                            elif isinstance(cell, bytes):
                                self._cell(where, cell)
            finally:
                con.close()
        except sqlite3.DatabaseError as exc:
            self.incomplete.append({"file": where, "why": f"sqlite: {type(exc).__name__}"})
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def _cell(self, where: str, data: bytes) -> None:
        for label, encoded in self.values:
            for form, needle in encoded.items():
                if needle in data:
                    self.findings.append({"file": f"{where} (sqlite value)", "form": form, "value": label})

    def tree(self, top: Path) -> None:
        before = set(self.seen_controls)
        self.seen_controls = set()
        for dirpath, _dirs, files in os.walk(top):
            for name in files:
                full = Path(dirpath) / name
                if full.is_symlink():
                    continue
                try:
                    data = full.read_bytes()
                except OSError as exc:
                    self.incomplete.append({"file": str(full), "why": type(exc).__name__})
                    continue
                self.bytes(str(full.relative_to(top)), data)
                if name.endswith("-wal"):
                    db = full.with_name(name[:-4])
                    if db.exists() and db.read_bytes().startswith(SQLITE_MAGIC):
                        self.sqlite(str(full.relative_to(top)), db.read_bytes(), data)
        self._controls(str(top))
        self.seen_controls |= before

    def archive(self, path: Path) -> None:
        raw = path.read_bytes()
        if raw.startswith(ZSTD_MAGIC):
            data = _zstd(raw)
            if data is None:
                self.incomplete.append({"file": str(path), "why": "zstd unavailable or corrupt"})
                return
        elif raw.startswith(GZIP_MAGIC):
            import gzip

            data = gzip.decompress(raw)
        else:
            data = raw
        self.seen_controls = set()
        try:
            with tarfile.open(fileobj=io.BytesIO(data)) as tar:
                members = {m.name: m for m in tar.getmembers()}
                for member in members.values():
                    if not member.isfile():
                        continue
                    if member.size > MAX_MEMBER_BYTES:
                        self.incomplete.append({"file": f"{path}:{member.name}", "why": "too large"})
                        continue
                    content = tar.extractfile(member).read()
                    self.bytes(f"{path.name}:{member.name}", content)
                    if member.name.endswith("-wal") and member.name[:-4] in members:
                        db = tar.extractfile(members[member.name[:-4]]).read()
                        if db.startswith(SQLITE_MAGIC):
                            self.sqlite(f"{path.name}:{member.name}", db, content)
        except (tarfile.TarError, EOFError) as exc:
            self.incomplete.append({"file": str(path), "why": f"tar: {type(exc).__name__}"})
            return
        self._controls(str(path))

    def _controls(self, where: str) -> None:
        for label, _needle in self.controls:
            if label not in self.seen_controls:
                self.findings.append({"file": where, "form": "control missing", "value": label})


def _zstd(raw: bytes) -> bytes | None:
    try:
        from compression import zstd  # Python 3.14

        return zstd.decompress(raw)
    except ImportError:
        pass
    except Exception:  # noqa: BLE001
        return None
    exe = shutil.which("zstd")
    if exe is None:
        return None
    proc = subprocess.run([exe, "-dc"], input=raw, capture_output=True, check=False)
    return proc.stdout if proc.returncode == 0 else None


def run(paths: list[Path], values: list[str], controls: list[str]) -> tuple[int, dict]:
    scan = Scan(values, controls)
    for path in paths:
        if path.is_dir():
            scan.tree(path)
        elif path.is_file():
            scan.archive(path)
        else:
            scan.incomplete.append({"file": str(path), "why": "missing"})
    report = {"files": scan.files, "findings": scan.findings, "incomplete": scan.incomplete}
    if scan.findings:
        return 1, report
    if scan.incomplete or scan.files == 0:
        return 3, report
    return 0, report


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--values", required=True, type=Path)
    ap.add_argument("--controls", type=Path)
    ap.add_argument("paths", nargs="+", type=Path)
    args = ap.parse_args(argv)
    values = args.values.read_text().splitlines()
    controls = args.controls.read_text().splitlines() if args.controls else []
    code, report = run(args.paths, values, controls)
    print(json.dumps({"status": code, **report}, indent=1))
    return code


if __name__ == "__main__":
    sys.exit(main())
