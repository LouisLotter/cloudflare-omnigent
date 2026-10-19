"""Builds synthetic computer workspaces for the S1 restore measurement.

A workspace mirrors what a workspace checkpoint holds: project files with their git history,
plus CLI continuation state (session transcripts) for Claude Code and Codex. No real sessions
are used: transcripts are generated from public source text, so they compress like real ones.

    python3 -I spikes/s1/scripts/make-workspace.py <repo-copy> <out-dir> <size: small|medium|large>

<repo-copy> is a plain copy of a public repository with its .git directory (S1 used the public
Omnigent repository at commit 90a9bed9a). Caches such as node_modules are not included, as the
design excludes them from checkpoints.
"""

from __future__ import annotations

import json
import os
import random
import shutil
import sys
from pathlib import Path

SIZES = {
    # name: (include .git history, transcript MiB, extra incompressible MiB)
    "small": (False, 16, 0),
    "medium": (True, 160, 0),
    "large": (True, 400, 512),
}


def source_lines(repo: Path) -> list[str]:
    lines: list[str] = []
    for path in sorted(repo.rglob("*.py"))[:4000]:
        try:
            lines.extend(path.read_text(errors="ignore").splitlines())
        except OSError:
            continue
    return [line for line in lines if line.strip()]


def write_transcripts(home: Path, lines: list[str], mib: int, rng: random.Random) -> None:
    targets = [home / ".claude" / "projects" / "-root-workspace", home / ".codex" / "sessions"]
    for target in targets:
        target.mkdir(parents=True, exist_ok=True)
    budget = mib * 1024 * 1024
    written = 0
    session = 0
    while written < budget:
        target = targets[session % 2]
        path = target / f"session-{session:05d}.jsonl"
        with path.open("w") as out:
            for turn in range(rng.randint(40, 200)):
                text = "\n".join(rng.choice(lines) for _ in range(rng.randint(5, 60)))
                record = {
                    "type": "assistant" if turn % 2 else "user",
                    "session": f"s1-synthetic-{session}",
                    "turn": turn,
                    "message": {"role": "assistant" if turn % 2 else "user", "content": text},
                }
                data = json.dumps(record) + "\n"
                out.write(data)
                written += len(data)
        session += 1


def main() -> None:
    repo, out, size = Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3]
    with_git, transcript_mib, random_mib = SIZES[size]
    rng = random.Random(1)
    if out.exists():
        shutil.rmtree(out)
    workspace = out / "workspace" / repo.name
    home = out / "home"
    ignore = shutil.ignore_patterns(*([] if with_git else [".git"]))
    shutil.copytree(repo, workspace, symlinks=True, ignore=ignore)
    write_transcripts(home, source_lines(repo), transcript_mib, rng)
    if random_mib:
        blobs = out / "workspace" / "artifacts"
        blobs.mkdir(parents=True)
        for i in range(random_mib // 64):
            (blobs / f"blob-{i:03d}.bin").write_bytes(os.urandom(64 * 1024 * 1024))


if __name__ == "__main__":
    main()
