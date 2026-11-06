"""RC-53's collector against the files Omnigent's own writers produce at the image's pin (WP3.22).

1. Live: ``rc53_formats.py`` writes every bridge, relay, router, hook, settings and login file
   with synthetic credentials, and a host-launched runner's environment from the host's own
   builder. The collector takes every credential and nothing else: no tool name or description,
   session, bridge or conversation ID, server URL, installation ID, hook command, account ID,
   rate-limit tier or slice key (the 27 Oct 2026 sitting's 134 findings).
2. The committed fixture (``python/tests/computer/fixtures/rc53-formats.json``, which the
   repository's own suite uses) still has the shape these writers produce: the same files, keys,
   credentials and environment names. After an Omnigent pin bump, regenerate it with
   ``rc53_formats.py templates`` inside the test image.
"""

from __future__ import annotations

import json
import re
import subprocess
import sys
import time
from pathlib import Path

from cfo_computer import rc53_collect
from cfo_computer.policy import Policy

HERE = Path(__file__).resolve().parent
FORMATS = HERE / "rc53_formats.py"
FIXTURE = HERE.parents[2] / "python" / "tests" / "computer" / "fixtures" / "rc53-formats.json"
POLICY = HERE.parents[2] / "contracts" / "fixtures" / "CheckpointPolicy" / "v1.json"
VENV_PYTHON = "/opt/venv/bin/python"


def _generate(tmp_path: Path, mode: str, out: Path) -> None:
    home, tmp = tmp_path / "home", tmp_path / "tmp"
    home.mkdir()
    tmp.mkdir()
    env = {
        "HOME": str(home),
        "TMPDIR": str(tmp),
        "PATH": "/opt/venv/bin:/usr/local/bin:/usr/bin:/bin",
        "XDG_CONFIG_HOME": str(home / ".config"),
        "XDG_CACHE_HOME": str(home / ".cache"),
    }
    subprocess.run(
        [VENV_PYTHON, "-I", str(FORMATS), mode, str(out)], env=env, check=True, timeout=120
    )


def test_live_writers_credentials_are_collected_and_identifiers_are_not(tmp_path: Path) -> None:
    out = tmp_path / "out.json"
    _generate(tmp_path, "write", out)
    record = json.loads(out.read_text())
    holder = subprocess.Popen(
        [sys.executable, "-c", "import time; time.sleep(120)"], env=record["runner_env"]
    )
    try:
        time.sleep(0.1)
        got = rc53_collect.collect(
            Path(record["home"]), tmp_roots=[Path(record["tmp"])], process_scope={holder.pid}
        )
    finally:
        holder.kill()
    creds = record["credentials"]
    assert len(creds) >= 20 and len(record["identifiers"]) > 50
    assert sorted(k for k, v in creds.items() if v not in got) == []
    assert [v[:24] for v in got if not any(c in v for c in creds.values())] == []
    assert sorted(k for k, v in record["identifiers"].items() if v in got) == []


def test_every_file_the_writers_leave_has_a_rule_and_no_saved_file_holds_a_credential(
    tmp_path: Path,
) -> None:
    """A file a release adds to a bridge fails here, not as "A save left some paths out" on every
    computer after its first hook. What the policy saves stays clear of every credential."""
    out = tmp_path / "out.json"
    _generate(tmp_path, "write", out)
    record = json.loads(out.read_text())
    home = Path(record["home"])
    policy = Policy.load(POLICY)
    decided = {
        path: policy.classify(str(path.relative_to(home)))
        for path in map(Path, record["files"])
        if path.is_relative_to(home)
    }
    assert sorted(p.name for p, d in decided.items() if d.action == "unclassified") == []
    saved = [path for path, decision in decided.items() if decision.saved]
    assert any(path.name == "child_usage_baselines.json" for path in saved)
    credentials = list(record["credentials"].values())
    assert [p.name for p in saved if any(c in p.read_text() for c in credentials)] == []


def _keys(value: object, prefix: str = "") -> set[str]:
    if isinstance(value, dict):
        return {p for k, v in value.items() for p in _keys(v, f"{prefix}.{k}")} | {prefix}
    if isinstance(value, list):
        return {p for v in value for p in _keys(v, f"{prefix}[]")} | {prefix}
    return {prefix}


def _shape(document: dict) -> dict:
    files = {}
    for path, text in document["files"].items():
        rel = re.sub(r"omnigent-\d+/", "omnigent-<uid>/", path)  # the suite runs as root
        try:
            files[rel] = sorted(_keys(json.loads(text)))
        except ValueError:
            files[rel] = sorted(
                line.split("=", 1)[0] for line in text.splitlines() if "=" in line
            ) or ["text"]
    return {
        "credentials": document["credentials"],
        "files": files,
        "runner_env": sorted(document["runner_env"]),
        "identifiers": sorted(document["identifiers"]),
    }


def test_the_committed_fixture_matches_the_writers(tmp_path: Path) -> None:
    out = tmp_path / "formats.json"
    _generate(tmp_path, "templates", out)
    assert _shape(json.loads(out.read_text())) == _shape(json.loads(FIXTURE.read_text()))
