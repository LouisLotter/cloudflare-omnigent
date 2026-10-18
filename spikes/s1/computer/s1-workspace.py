"""S1: builds a synthetic computer workspace inside the computer container, for the backup and
restore phases. Only files already in the image are used, so no network is needed:

- project files: Omnigent's source tree (/build) and, for medium and large, a Python tree
  (/opt/venv/lib), standing in for repositories with history;
- CLI continuation state: synthetic Claude Code and Codex transcripts generated from that
  source text, so they compress like real ones; no real session data;
- for large, 512 MiB of incompressible files, standing in for build artefacts.

    python3 /usr/local/bin/s1-workspace.py <dir> <small|medium|large>
    python3 /usr/local/bin/s1-workspace.py --measure <dir>

Prints one JSON line: {"size", "bytes", "files"}, or {"bytes", "files"} for --measure. Bytes
are the apparent sizes of files and symbolic links; directories are not counted.
"""

from __future__ import annotations

import json
import os
import random
import shutil
import sys
from pathlib import Path

SIZES = {
    # name: (copy /opt/venv/lib, transcript MiB, incompressible MiB)
    "small": (False, 16, 0),
    "medium": (True, 160, 0),
    "large": (True, 560, 512),
}


def source_lines(root: Path) -> list[str]:
    lines: list[str] = []
    for path in sorted(root.rglob("*.py"))[:4000]:
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
        path = targets[session % 2] / f"session-{session:05d}.jsonl"
        with path.open("w") as out:
            for turn in range(rng.randint(40, 200)):
                text = "\n".join(rng.choice(lines) for _ in range(rng.randint(5, 60)))
                role = "assistant" if turn % 2 else "user"
                record = {
                    "type": role,
                    "session": f"s1-synthetic-{session}",
                    "turn": turn,
                    "message": {"role": role, "content": text},
                }
                data = json.dumps(record) + "\n"
                out.write(data)
                written += len(data)
        session += 1


def measure(root: Path) -> tuple[int, int]:
    total = 0
    files = 0
    for dirpath, _dirs, names in os.walk(root):
        for name in names:
            path = os.path.join(dirpath, name)
            try:
                total += os.lstat(path).st_size
                files += 1
            except OSError:
                continue
    return total, files


def main() -> None:
    if sys.argv[1] == "--measure":
        # After a restore: the same measure, to compare with the backed-up workspace.
        total, files = measure(Path(sys.argv[2]))
        print(json.dumps({"bytes": total, "files": files}))
        return
    out, size = Path(sys.argv[1]), sys.argv[2]
    with_venv, transcript_mib, random_mib = SIZES[size]
    rng = random.Random(1)
    if out.exists():
        shutil.rmtree(out)
    (out / "projects").mkdir(parents=True)
    shutil.copytree("/build", out / "projects" / "omnigent", symlinks=True)
    if with_venv:
        shutil.copytree("/opt/venv/lib", out / "projects" / "python-tree", symlinks=True)
    write_transcripts(out / "home", source_lines(Path("/build")), transcript_mib, rng)
    if random_mib:
        blobs = out / "projects" / "artifacts"
        blobs.mkdir()
        for i in range(random_mib // 64):
            (blobs / f"blob-{i:03d}.bin").write_bytes(os.urandom(64 * 1024 * 1024))
    total, files = measure(out)
    print(json.dumps({"size": size, "bytes": total, "files": files}))


if __name__ == "__main__":
    main()
