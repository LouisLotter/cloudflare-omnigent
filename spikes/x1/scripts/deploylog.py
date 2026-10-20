"""Read one timestamped staging-tool deploy log (deploy.sh writes it: "<laptop ms> <line>").

    python3 -I deploylog.py <log> <target>      prints {"uploaded", "rollout", "evidence", ...}

"uploaded" is the time of Wrangler's "Uploaded <worker>" line: the new version is live from
then on (pre-registration section 6's deploy window ends 330 s after it). "rollout" is true when
the log shows that a deploy pushed an image or changed a container application: the run then
fails setup (section 5). A transport deploy must report both of its images as already present.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

LINE = re.compile(r"^(\d{13}) ?(.*)$")
PUSH = re.compile(
    r"(The push refers to repository|^\s*\S+: Pushed\b|Pushing image|pushed image)", re.I
)
SKIPPED = "Image already exists remotely, skipping push"
IMAGES = {"transport": 2, "ui": 0}


def parse(lines: list[str], target: str) -> dict:
    uploaded = None
    in_changes = False
    changes: list[str] = []
    pushes: list[str] = []
    skipped = 0
    for raw in lines:
        match = LINE.match(raw.rstrip("\n"))
        if not match:
            continue
        ms, text = int(match.group(1)), match.group(2)
        body = text.lstrip("│├╭╰ ").strip()
        if uploaded is None and body.startswith("Uploaded "):
            uploaded = ms
        if SKIPPED in text:
            skipped += 1
        if PUSH.search(text):
            pushes.append(body[:120])
        if "Container application changes" in text:
            in_changes = True
            continue
        if in_changes and text.lstrip().startswith("╰"):
            in_changes = False
            continue
        if in_changes and text.lstrip().startswith("├") and "no changes" not in body:
            changes.append(body[:120])
    evidence = [f"container application change: {c}" for c in changes]
    evidence += [f"image push: {p}" for p in pushes]
    expected = IMAGES.get(target, 0)
    if expected and skipped < expected and not pushes:
        evidence.append(f"only {skipped} of {expected} images reported as already present")
    return {
        "uploaded": uploaded,
        "rollout": bool(evidence),
        "evidence": evidence,
        "imagesAlreadyPresent": skipped,
    }


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print(__doc__, file=sys.stderr)
        return 2
    print(json.dumps(parse(Path(argv[0]).read_text().splitlines(), argv[1])))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
