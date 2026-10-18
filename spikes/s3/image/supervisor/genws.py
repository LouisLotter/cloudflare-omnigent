"""Generate a deterministic workspace profile for the capture benchmarks.

Run as the agent user inside the computer container:
  python -m supervisor.genws <profile> [--seed-repo /seed/omnigent]

Profiles (sizes before caches are excluded; caches are generated too, so the
exclude rules are exercised):
  small       synthetic project ~100 MB, ~3k files, plus CLI history
  realistic   a real repository (the Omnigent fork, with .git) + a synthetic
              second project + CLI history: ~0.7 GB, ~14k files
  large       realistic + a synthetic monorepo: ~2.3 GB, ~56k files
  many-small  100k files of ~3 KB, plus CLI history
Every profile also writes a node_modules and a .venv that must be excluded.
"""

from __future__ import annotations

import argparse
import json
import os
import random
import shutil
import subprocess
import sys
import time

HOME = os.environ.get("HOME", "/home/agent")
WORK = os.path.join(HOME, "work")

_WORDS = (
    "def class return import from self value result items config error async await "
    "for while if else elif try except finally with as lambda yield none true false "
    "request response session runner host server client token payload status state "
    "export const function interface type string number boolean promise await new "
).split()


def _pool(rng: random.Random, size: int = 4 << 20) -> bytes:
    """Code-like text: compresses roughly like source code."""
    out = []
    n = 0
    while n < size:
        indent = " " * (4 * rng.randint(0, 3))
        line = indent + " ".join(rng.choice(_WORDS) for _ in range(rng.randint(3, 12))) + "\n"
        out.append(line)
        n += len(line)
    return "".join(out).encode()


def _size(rng: random.Random) -> int:
    # Mean about 23 KB, like a source tree's working files.
    r = rng.random()
    if r < 0.85:
        return rng.randint(512, 12 << 10)
    if r < 0.99:
        return rng.randint(12 << 10, 96 << 10)
    return rng.randint(96 << 10, 2 << 20)


def synth_tree(root: str, total_bytes: int, seed: int, *, size_fn=None, binary_frac: float = 0.03) -> tuple[int, int]:
    rng = random.Random(seed)
    pool = _pool(rng)
    size_fn = size_fn or _size
    written = files = 0
    d = 0
    while written < total_bytes:
        sub = os.path.join(root, f"pkg{d // 40:03d}", f"mod{d % 40:02d}")
        os.makedirs(sub, exist_ok=True)
        for i in range(rng.randint(10, 40)):
            sz = size_fn(rng)
            p = os.path.join(sub, f"file{i:03d}.{rng.choice(['py', 'ts', 'md', 'json', 'go'])}")
            with open(p, "wb") as fh:
                if rng.random() < binary_frac:
                    fh.write(os.urandom(sz))
                else:
                    off = rng.randint(0, len(pool) - 1)
                    buf = (pool[off:] + pool)[:sz] if sz <= len(pool) else (pool * (sz // len(pool) + 1))[:sz]
                    fh.write(buf)
            written += sz
            files += 1
            if written >= total_bytes:
                break
        d += 1
    return written, files


def caches(project: str, seed: int) -> None:
    """Directories the exclude rules must leave out."""
    synth_tree(os.path.join(project, "node_modules"), 40 << 20, seed + 100)
    synth_tree(os.path.join(project, ".venv", "lib"), 20 << 20, seed + 101)


def cli_history(seed: int, mb: int = 40) -> None:
    rng = random.Random(seed)
    pool = _pool(rng, 1 << 20)
    claude_dir = os.environ.get("CLAUDE_CONFIG_DIR", os.path.join(HOME, ".claude"))
    cproj = os.path.join(claude_dir, "projects", "-home-agent-work-history")
    os.makedirs(cproj, exist_ok=True)
    codex = os.path.join(HOME, ".codex", "sessions", "2026", "10", "01")
    os.makedirs(codex, exist_ok=True)
    per = (mb << 20) // 40
    for i in range(20):
        for base, name in ((cproj, f"{i:08x}-0000-4000-8000-000000000000.jsonl"), (codex, f"rollout-2026-10-01T00-00-{i:02d}-synthetic{i}.jsonl")):
            with open(os.path.join(base, name), "wb") as fh:
                n = 0
                while n < per:
                    rec = json.dumps({"type": "message", "text": pool[rng.randint(0, 9000): rng.randint(9001, 20000)].decode()}) + "\n"
                    fh.write(rec.encode())
                    n += len(rec)


def copy_repo(seed_repo: str, dest: str) -> None:
    if not os.path.isdir(seed_repo):
        # Staging has no seed checkout: synthesize the same shape, a ~120 MB
        # working tree plus ~340 MB of git pack files (already compressed).
        synth_tree(dest, 120 << 20, 7)
        pack = os.path.join(dest, ".git", "objects", "pack")
        os.makedirs(pack, exist_ok=True)
        for i, mb in enumerate((300, 30, 10)):
            with open(os.path.join(pack, f"pack-{i:040d}.pack"), "wb") as fh:
                for _ in range(mb):
                    fh.write(os.urandom(1 << 20))
        return
    subprocess.run(
        ["rsync", "-a", "--exclude", "node_modules/", "--exclude", ".venv/", "--exclude", ".claude/",
         "--exclude", ".coverage", "--exclude", ".env*", seed_repo.rstrip("/") + "/", dest],
        check=True,
    )


def evict(paths: list[str]) -> int:
    """Drop clean page-cache pages of every file (cold-cache measurement)."""
    os.sync()
    n = 0
    for root in paths:
        for dp, _dn, fns in os.walk(root):
            for f in fns:
                p = os.path.join(dp, f)
                try:
                    fd = os.open(p, os.O_RDONLY | os.O_NOFOLLOW)
                except OSError:
                    continue
                try:
                    os.posix_fadvise(fd, 0, 0, os.POSIX_FADV_DONTNEED)
                    n += 1
                finally:
                    os.close(fd)
    return n


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("profile", choices=["small", "realistic", "large", "many-small", "evict", "clear"])
    ap.add_argument("--seed-repo", default="/seed/omnigent")
    args = ap.parse_args()
    t0 = time.monotonic()
    if args.profile == "evict":
        n = evict([WORK, os.path.join(HOME, ".claude"), os.path.join(HOME, ".codex"), os.path.join(HOME, ".omnigent")])
        print(json.dumps({"evicted_files": n, "s": round(time.monotonic() - t0, 2)}))
        return 0
    if os.path.exists(WORK):
        shutil.rmtree(WORK)
    os.makedirs(WORK)
    if args.profile == "clear":
        return 0
    if args.profile == "small":
        synth_tree(os.path.join(WORK, "app"), 100 << 20, 1)
        caches(os.path.join(WORK, "app"), 1)
        cli_history(1, 20)
    elif args.profile in ("realistic", "large"):
        copy_repo(args.seed_repo, os.path.join(WORK, "omnigent"))
        synth_tree(os.path.join(WORK, "webapp"), 150 << 20, 2)
        caches(os.path.join(WORK, "webapp"), 2)
        cli_history(2, 80)
        if args.profile == "large":
            synth_tree(os.path.join(WORK, "monorepo"), 1600 << 20, 3)
    elif args.profile == "many-small":
        synth_tree(os.path.join(WORK, "tiny"), 300 << 20, 4, size_fn=lambda r: r.randint(1024, 5120), binary_frac=0.0)
        cli_history(4, 20)
    os.sync()
    print(json.dumps({"profile": args.profile, "gen_s": round(time.monotonic() - t0, 1)}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
