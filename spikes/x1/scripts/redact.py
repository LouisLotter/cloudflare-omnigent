"""Redact X1's records and logs before they leave the laptop for the project notes.

    python3 -I redact.py <staging config.json> -                 filter stdin to stdout
    python3 -I redact.py <staging config.json> <in-dir> <out-dir>   copy a tree, then verify it

Replaces the staging account ID, owner email, identity provider ID and zone (from the staging
tool's own config, outside the repository, never printed), any other email address, every
32-hex ID and every UUID with placeholders, and the home directory with "~". A tree copy is
then scanned again, and the command fails, naming only the file and the kind, if anything
survives. 64-hex image digests are kept: they name images, not accounts.
"""

from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path

EMAIL = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
HEX32 = re.compile(r"(?<![0-9A-Fa-f])[0-9A-Fa-f]{32}(?![0-9A-Fa-f])")
UUID = re.compile(
    r"(?<![0-9A-Fa-f])[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}(?![0-9A-Fa-f])"
)


def secrets_from(config: dict, home: str | None = None) -> list[tuple[str, str]]:
    """The literal values to replace, longest first, so that no value hides inside another."""
    pairs = [
        (config.get("accountId"), "<account>"),
        (config.get("ownerEmail"), "<owner-email>"),
        (config.get("identityProviderId"), "<idp>"),
        (config.get("zone"), "<zone>"),
    ]
    out = [(str(v), m) for v, m in pairs if v]
    if home and home != "/":
        out.append((home, "~"))
    return sorted(out, key=lambda p: -len(p[0]))


def redact_text(text: str, secrets: list[tuple[str, str]]) -> str:
    for value, mask in secrets:
        text = text.replace(value, mask)
    text = EMAIL.sub("<email>", text)
    text = UUID.sub("<uuid>", text)
    return HEX32.sub("<hex32>", text)


def leftovers(text: str, secrets: list[tuple[str, str]]) -> list[str]:
    """The kinds of sensitive value still in `text`: never the values themselves."""
    found = [mask for value, mask in secrets if mask != "~" and value in text]
    if EMAIL.search(text):
        found.append("an email address")
    if HEX32.search(text):
        found.append("a 32-hex ID")
    if UUID.search(text):
        found.append("a UUID")
    return found


def redact_tree(src: Path, dst: Path, secrets: list[tuple[str, str]]) -> list[str]:
    """Copies src to dst redacted. Returns the problems found when scanning the copy."""
    problems = []
    for path in sorted(p for p in src.rglob("*") if p.is_file()):
        relative = path.relative_to(src)
        target = dst / Path(redact_text(str(relative), secrets))
        target.parent.mkdir(parents=True, exist_ok=True)
        text = path.read_bytes().decode("utf-8", errors="replace")
        target.write_text(redact_text(text, secrets))
    for path in sorted(p for p in dst.rglob("*") if p.is_file()):
        kinds = leftovers(path.read_text() + "\n" + str(path.relative_to(dst)), secrets)
        if kinds:
            problems.append(f"{path.relative_to(dst)}: {', '.join(sorted(set(kinds)))}")
    return problems


def main(argv: list[str]) -> int:
    if len(argv) not in (2, 3):
        print(__doc__, file=sys.stderr)
        return 2
    config = json.loads(Path(argv[0]).read_text())
    secrets = secrets_from(config, os.path.expanduser("~"))
    if argv[1] == "-":
        for line in sys.stdin:
            sys.stdout.write(redact_text(line, secrets))
            sys.stdout.flush()
        return 0
    problems = redact_tree(Path(argv[1]), Path(argv[2]), secrets)
    for problem in problems:
        print(f"still sensitive: {problem}", file=sys.stderr)
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
