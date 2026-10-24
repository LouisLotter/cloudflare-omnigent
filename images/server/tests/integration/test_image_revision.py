"""The built image carries the fork revision it was built from (AIR2-007 at artifact scope).

Against the built image, not the fork's source: its labels, its build record and its
``GET /status`` name the Dockerfile's pinned commit, and the Omnigent installed in it is that
commit's tree, file by file. The tree check needs a checkout of the fork that has the commit:
set ``CFO_OMNIGENT_FORK`` to its path (skipped otherwise).
"""

from __future__ import annotations

import json
import os
import re
import subprocess
from pathlib import Path

import pytest

from conftest import IMAGE, Stack, docker

IMAGE_DIR = Path(__file__).resolve().parents[2]
FORK = os.environ.get("CFO_OMNIGENT_FORK")

#: Computes Git's blob ID of every file and symbolic link Omnigent's package holds in the
#: image, the way `git ls-tree` names them, leaving out what the build adds: bytecode, the built
#: web UI, and `_build_info.py`, which Omnigent's setup.py generates (and Git ignores).
_TREE_SCRIPT = r"""
import hashlib, json, os, sys
root = "/build"
built = {"omnigent/_build_info.py"}
def blob(data):
    return hashlib.sha1(b"blob %d\0" % len(data) + data).hexdigest()
out = {}
for base, dirs, files in os.walk(os.path.join(root, "omnigent")):
    rel = os.path.relpath(base, root)
    if rel.startswith(os.path.join("omnigent", "server", "static", "web-ui")):
        dirs[:] = []
        continue
    for name in [*dirs, *files]:
        path = os.path.join(base, name)
        key = os.path.relpath(path, root)
        if os.path.islink(path):
            out[key] = blob(os.readlink(path).encode())
        elif name in files and key not in built:
            out[key] = blob(open(path, "rb").read())
    dirs[:] = [d for d in dirs if d != "__pycache__" and not os.path.islink(os.path.join(base, d))]
out["deploy/docker/entrypoint.py"] = blob(open("/app/entrypoint.py", "rb").read())
json.dump(out, sys.stdout)
"""


def _pinned() -> str:
    match = re.search(
        r"^ARG OMNIGENT_COMMIT=([0-9a-f]{40})$", (IMAGE_DIR / "Dockerfile").read_text(), re.M
    )
    assert match
    return match.group(1)


def test_labels_and_build_record_name_the_pinned_commit() -> None:
    labels = json.loads(docker("image", "inspect", "-f", "{{json .Config.Labels}}", IMAGE).stdout)
    commit = _pinned()
    assert labels["cloudflare-omnigent.omnigent-commit"] == commit
    assert labels["org.opencontainers.image.revision"] == commit
    record = json.loads(docker("run", "--rm", IMAGE, "cat", "/opt/cfo/build.json").stdout)
    assert record["omnigentCommit"] == commit
    assert record["litestream"] == labels["cloudflare-omnigent.litestream"]


@pytest.mark.skipif(not FORK, reason="set CFO_OMNIGENT_FORK to a checkout of the fork")
def test_the_installed_omnigent_is_the_pinned_commits_tree() -> None:
    commit = _pinned()
    listed = subprocess.run(
        ["git", "-C", str(FORK), "ls-tree", "-r", commit, "--", "omnigent"]
        + ["deploy/docker/entrypoint.py"],
        capture_output=True,
        text=True,
        check=True,
    ).stdout
    expected = {}
    for line in listed.splitlines():
        meta, path = line.split("\t", 1)
        mode, kind, blob = meta.split()
        if kind == "blob" and not path.startswith("omnigent/server/static/web-ui/"):
            expected[path] = blob
    image = json.loads(docker("run", "--rm", IMAGE, "python", "-c", _TREE_SCRIPT).stdout)
    assert len(expected) > 500
    missing = sorted(set(expected) - set(image))
    extra = sorted(set(image) - set(expected))
    changed = sorted(p for p in set(expected) & set(image) if expected[p] != image[p])
    assert not missing and not extra and not changed, (missing[:5], extra[:5], changed[:5])


def test_status_reports_the_build_of_a_running_server(link: Stack, prefix: str) -> None:
    server = link.server(prefix, initialized=False).start()
    status = server.wait_phase("running")
    assert status["build"]["omnigentCommit"] == _pinned()
    (boot,) = server.events("boot")
    assert boot["omnigent_commit"] == _pinned()
