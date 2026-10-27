"""RC-53: the layer scan finds every encoded form, and real layers hold no planted token.

The scanner proves itself first (every form, archives, SQLite overflow pages and WAL, a
missing control, an unreadable archive). Then real captures through the actual receiver:
tokens planted in the credential families and in the native harnesses' secret files (with
their temporary-write variants), a control canary in a saved file before each capture, each
staged layer archived as tar+zstd as DirectoryBackup stores it, decompressed and scanned.
"""

from __future__ import annotations

import base64
import io
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import tarfile
import urllib.parse
from pathlib import Path

import pytest
from cfo_computer import rc53 as rc53_scan  # noqa: E402
from harness import Rig, canary, new_id


def _encodings(value: str) -> dict[str, bytes]:
    raw = value.encode()
    return {
        "raw": raw,
        "json": json.dumps({"k": value}).encode(),
        "url": urllib.parse.quote(value, safe="").encode(),
        "hex": raw.hex().encode(),
        "b64-0": base64.b64encode(raw),
        "b64-1": base64.b64encode(b"x" + raw),
        "b64-2": base64.urlsafe_b64encode(b"xy" + raw),
        "utf16": value.encode("utf-16-le"),
    }


@pytest.mark.parametrize("form", list(_encodings("x" * 40)))
def test_the_scan_finds_every_form(tmp_path: Path, form: str) -> None:
    value = canary("form") + "/+=?&"
    (tmp_path / "t").mkdir()
    (tmp_path / "t" / "f.bin").write_bytes(b"prefix" + _encodings(value)[form] + b"suffix")
    code, report = rc53_scan.run([tmp_path / "t"], [value], [])
    assert code == 1 and report["findings"], form
    assert value not in json.dumps(report), "the report never prints a value"


def test_sqlite_overflow_pages_and_wal_and_archives(tmp_path: Path) -> None:
    value = canary("sqlite")
    tree = tmp_path / "t"
    tree.mkdir()
    con = sqlite3.connect(tree / "state.sqlite")
    con.execute("pragma journal_mode=wal")
    con.execute("create table t (v text)")
    # Spread over overflow pages: the token straddles a page boundary in the file.
    con.execute("insert into t values (?)", ("y" * 4090 + value + "z" * 9000,))
    con.commit()
    shutil.copy(tree / "state.sqlite", tmp_path / "db-copy")
    shutil.copy(tree / "state.sqlite-wal", tmp_path / "wal-copy")
    con.close()
    shutil.copy(tmp_path / "db-copy", tree / "state.sqlite")
    shutil.copy(tmp_path / "wal-copy", tree / "state.sqlite-wal")
    code, report = rc53_scan.run([tree], [value], [])
    assert code == 1 and any("sqlite value" in f["file"] for f in report["findings"])
    archive = tmp_path / "layer.tar.zst"
    if shutil.which("zstd"):
        subprocess.run(["tar", "-I", "zstd", "-cf", str(archive), "-C", str(tree), "."], check=True)
        code, report = rc53_scan.run([archive], [value], [])
        assert code == 1
    gz = io.BytesIO()
    with tarfile.open(fileobj=gz, mode="w:gz") as tar:
        tar.add(tree, arcname=".")
    (tmp_path / "layer.tar.gz").write_bytes(gz.getvalue())
    code, _ = rc53_scan.run([tmp_path / "layer.tar.gz"], [value], [])
    assert code == 1


def test_a_missing_control_or_an_unreadable_archive_is_never_clean(tmp_path: Path) -> None:
    tree = tmp_path / "t"
    tree.mkdir()
    (tree / "f").write_text("nothing")
    assert rc53_scan.run([tree], [canary("absent")], [canary("control")])[0] == 1
    (tmp_path / "bad.tar.zst").write_bytes(b"\x28\xb5\x2f\xfd" + b"garbage")
    assert rc53_scan.run([tmp_path / "bad.tar.zst"], [canary("absent")], [])[0] == 3
    assert rc53_scan.run([tree], [canary("absent")], [])[0] == 0


SECRET_FILES = [
    ".claude/.credentials.json",
    ".claude/.credentials.json.tmp.1a2b3c4d",
    ".claude/.device-keys.json",
    ".codex/auth.json",
    ".codex/auth.json.tmp",
    ".codex/.credentials.json",
    ".omnigent/auth_tokens.json",
    ".omnigent/codex-native/b1/policy_hook.json",
    ".omnigent/codex-native/b1/policy_hook.json.k2j3h4g5",
    ".omnigent/codex-native/b1/bridge.json",
    ".omnigent/codex-native/b1/bridge.json.a1b2c3d4",
    ".omnigent/codex-native/b1/server.json",
    ".omnigent/codex-native/b1/.server.json.x9y8z7w6.tmp",
    ".omnigent/codex-native/b1/tool_relay.json",
    ".omnigent/codex-native/b1/.tool_relay.json.q1w2e3r4.tmp",
    ".omnigent/codex-native/b1/tool_relay.env",
    ".omnigent/codex-native/b1/turn_router.json",
    ".omnigent/codex-native/b1/subagent_router.json.p0o9i8u7.tmp",
    ".omnigent/codex-native/b1/provider_key",
    ".omnigent/codex-native/b1/provider_key.m1n2b3v4",
    ".omnigent/codex-native/b1/codex-home/auth.json",
    ".omnigent/codex-native/b1/codex-home/.credentials.json",
    ".omnigent/cache/codex-model-probe/x/auth.json",
    ".claude/backups/.claude.json.backup.1",
]


def test_no_planted_token_in_any_archived_layer(tmp_path: Path) -> None:
    rig = Rig(tmp_path / "a")
    archives = tmp_path / "layers"
    archives.mkdir()
    controls, values = [], {}
    try:
        rig.boot()
        bridge = rig.home / ".omnigent" / "codex-native" / "b1"
        (bridge / "codex-home" / "sessions").mkdir(parents=True)
        (bridge / "codex-home" / "config.toml").write_text('model = "gpt-private"\n')
        (bridge / "dead_letter.jsonl").write_text('{"event_type":"external_conversation_item"}\n')
        parent = None
        for round_ in range(3):
            for rel in SECRET_FILES:  # every generation of every token, rotated each round
                value = canary(f"r{round_}")
                values[f"{rel} r{round_}"] = value
                path = rig.home / rel
                path.parent.mkdir(parents=True, exist_ok=True)
                encoded = base64.b64encode(value.encode()).decode()
                path.write_text(
                    json.dumps({"token": value, "header": f"Bearer {value}", "b64": encoded})
                )
            control = canary(f"control{round_}")
            controls.append(control)
            (rig.home / "work" / "control.txt").write_text(control)
            if parent is None:
                op, job = rig.capture()
            else:
                op, job = rig.capture(
                    "delta", {"checkpointId": new_id("ckp"), "treeDigest": parent}
                )
            assert job["state"] == "staged", job
            archive = archives / f"{round_}.tar.gz"
            with tarfile.open(archive, "w:gz") as tar:
                tar.add(job["layerDir"], arcname=".")
            rig.finish(op)
            parent = job["treeDigest"]
            # This round's control must be in this round's layer.
            code, report = rc53_scan.run([archive], list(values.values()), [control])
            assert code == 0, report
        # Continuation state the policy saves is in the base.
        with tarfile.open(archives / "0.tar.gz") as tar:
            names = set(tar.getnames())
        assert "./.omnigent/codex-native/b1/dead_letter.jsonl" in names
        assert "./.omnigent/codex-native/b1/codex-home/config.toml" in names
    finally:
        rig.close()


def _disk_holds(top: Path, values: list[str]) -> list[str]:
    hits = []
    for dirpath, _dirs, files in os.walk(top):
        for name in files:
            full = Path(dirpath) / name
            if full.is_symlink():
                continue
            data = full.read_bytes()
            if any(v.encode() in data for v in values):
                hits.append(str(full.relative_to(top)))
    return hits


def _rc53_rig(tmp_path: Path, token: str):
    holder = subprocess.Popen(
        [sys.executable, "-c", "import time; time.sleep(60)"],
        env={**os.environ, "OMNIGENT_HOST_TOKEN": token},
    )
    rig = Rig(tmp_path / "a", scope_pids=[holder.pid])
    rig.boot()
    (rig.layout.state / "rc53").mkdir()
    (rig.layout.state / "rc53" / "enabled").write_text("")
    rig.sup.rc53_tmp_roots = [tmp_path / "no-tmp"]
    return holder, rig


def test_the_opt_in_staging_check_keeps_values_in_memory(tmp_path: Path) -> None:
    """With ``<state>/rc53/enabled``, the supervisor collects the live values (the workload's
    environments, the bridges, the logins) before each capture and hands them to the worker
    on an anonymous memory descriptor; the worker scans the staged layer. No value is written
    to disk, a spec, a result or a log (Codex r2, finding 1)."""
    token = canary("hosttoken")
    holder, rig = _rc53_rig(tmp_path, token)
    try:
        bridge = rig.home / ".omnigent" / "codex-native" / "b1"
        bridge.mkdir(parents=True)
        delegated = canary("delegated")
        (bridge / "policy_hook.json").write_text(
            json.dumps({"ap_auth_headers": {"Authorization": f"Bearer {delegated}"}})
        )
        (rig.home / "work" / "notes.txt").write_text("no token here")
        op, job = rig.capture()
        assert job["state"] == "staged", job
        result = rig.result(op)["rc53"]
        assert result == {**result, "status": 0, "findings": 0, "incomplete": 0}
        assert result["values"] >= 2
        assert token in rig.sup._rc53_values and delegated in rig.sup._rc53_values
        assert not (rig.layout.state / "rc53" / "values").exists()
        # Only the home holds a value (the bridge file, as Omnigent wrote it).
        assert _disk_holds(rig.root, [token, delegated]) == [
            "home/.omnigent/codex-native/b1/policy_hook.json"
        ]
    finally:
        holder.kill()
        rig.close()


def test_a_detected_token_is_never_offered_for_upload(tmp_path: Path) -> None:
    """A finding fails the capture before it is reported staged (Codex r2, finding 4): the job
    WorkspaceDO reads says failed, no layer is left to upload, and the published parent stays."""
    token = canary("hosttoken")
    holder, rig = _rc53_rig(tmp_path, token)
    try:
        op, first = rig.capture()
        assert first["state"] == "staged"
        rig.finish(op)
        (rig.home / "work" / "leak.txt").write_text(f"export T={token}")
        op, job = rig.capture(
            "delta", {"checkpointId": new_id("ckp"), "treeDigest": first["treeDigest"]}
        )
        assert job == {
            "kind": "capture",
            "jobOperationId": op,
            "state": "failed",
            "reason": "policy_violation",
            "pausedMs": job["pausedMs"],
        }
        assert list(rig.layout.staged.iterdir()) == []
        assert not list(rig.layout.data.glob("pending-*.json"))
        assert rig.result(op)["rc53"]["findings"] >= 1
        assert token not in json.dumps(rig.result(op)) and token not in json.dumps(job)
        assert rig.sup.published_digest == first["treeDigest"]
        # The supervisor's own view of the job matches what WorkspaceDO reads.
        assert rig.sup._capture_job_view(op, rig.result(op))["state"] == "failed"
        # Remove the leak: the next capture is clean again.
        (rig.home / "work" / "leak.txt").unlink()
        _op, job = rig.capture(
            "delta", {"checkpointId": new_id("ckp"), "treeDigest": first["treeDigest"]}
        )
        assert job["state"] == "unchanged"
    finally:
        holder.kill()
        rig.close()


def test_a_failed_collection_fails_the_capture(tmp_path: Path, monkeypatch) -> None:
    from cfo_computer import rc53_collect

    holder, rig = _rc53_rig(tmp_path, canary("t"))
    try:

        def broken(*a, **k):
            raise OSError("collection failed")

        monkeypatch.setattr(rc53_collect, "collect", broken)
        _op, job = rig.capture()
        assert job["state"] == "failed" and job["reason"] == "policy_violation", job
        assert list(rig.layout.staged.iterdir()) == []
    finally:
        holder.kill()
        rig.close()


def test_rc53_verdict() -> None:
    from cfo_computer.capture import rc53_verdict

    assert rc53_verdict(0) is None
    assert "live token" in rc53_verdict(1)
    assert "completely" in rc53_verdict(3)


def test_the_collector_asks_the_host_broker_for_the_github_token(tmp_path: Path) -> None:
    """Production collection with a synthetic broker answer (Codex r2, finding 6): the
    collector speaks git's credential format to every broker socket under its root, and the
    supervisor's own collection before a capture finds the token in a staged layer."""
    import socket
    import tempfile
    import threading

    from cfo_computer import rc53_collect

    github = "ghu_" + canary("github")
    root = Path(tempfile.mkdtemp(prefix="cfo34-"))  # AF_UNIX paths must stay short
    server = socket.socket(socket.AF_UNIX)
    asked: list[str] = []

    def serve() -> None:
        while True:
            try:
                conn, _ = server.accept()
            except OSError:
                return
            with conn:
                request = b""
                while chunk := conn.recv(4096):
                    request += chunk
                asked.append(request.decode())
                conn.sendall(
                    "protocol=https\nhost=github.com\nusername=x-access-token\n"
                    f"password={github}\n".encode()
                )

    thread = threading.Thread(target=serve, daemon=True)
    holder = rig = None
    try:
        (root / "omnigent-1000").mkdir()
        server.bind(str(root / "omnigent-1000" / "credentials-0123456789abcdef.sock"))
        server.listen(4)
        thread.start()
        home = root / "home"
        home.mkdir()
        values = rc53_collect.collect(home, tmp_roots=[], process_scope=set(), broker_root=root)
        assert github in values
        assert asked and "host=github.com" in asked[0] and "protocol=https" in asked[0]
        # Without a broker root, no broker is asked.
        assert github not in rc53_collect.collect(home, tmp_roots=[], process_scope=set())
        assert len(asked) == 1
        # The supervisor's collection, as in production: a layer holding the token fails.
        holder, rig = _rc53_rig(tmp_path, canary("hosttoken"))
        rig.sup.rc53_broker_root = root
        (rig.home / "work" / "remote.txt").write_text(f"https://x-access-token:{github}@github.com")
        op, job = rig.capture()
        assert job["state"] == "failed" and job["reason"] == "policy_violation", job
        assert len(asked) == 2 and github in rig.sup._rc53_values
        assert github not in json.dumps(rig.result(op))
    finally:
        server.close()
        if holder is not None:
            holder.kill()
        if rig is not None:
            rig.close()
        shutil.rmtree(root, ignore_errors=True)


# ── The collector takes credentials, never identifiers (WP3.22) ────────────────────────────
# The 27 Oct 2026 staging sitting: with the check on, every save failed with up to 146
# findings, none a credential (tool names and descriptions, session and bridge IDs, the server
# URL, the installation ID, Claude's rateLimitTier, Codex's account_id, hook commands, and the
# runner's slice key). The fixture is every file the collector reads, as Omnigent's own writers
# produce them at the image's pin (images/computer/tests/rc53_formats.py, which the image's
# suite also runs live and checks the fixture against), with each credential as @@label@@.

FORMATS = Path(__file__).resolve().parent / "fixtures" / "rc53-formats.json"


def _credential_value(label: str, shape: str) -> str:
    value = canary(label.replace("_", ""))
    return {
        "oat": f"sk-ant-oat01-{value}",
        "ort": f"sk-ant-ort01-{value}",
        "sk": f"sk-proj-{value}",
        "jwt": f"eyJhbGciOiJSUzI1NiIsImtpZCI6InIifQ.eyJzdWIiOiJyYzUzIn0.{value}",
        "opaque": f"-{value}%s$x",
        "slash": f"/{value}+==",
    }.get(shape, value)


def _formats(home: Path, tmp: Path) -> tuple[dict[str, str], dict[str, str], dict[str, str]]:
    """Write the fixture's files under ``home`` and ``tmp`` with fresh credentials; return the
    credentials, the identifiers and the runner's environment, filled in the same way."""
    doc = json.loads(FORMATS.read_text())
    creds = {k: _credential_value(k, shape) for k, shape in doc["credentials"].items()}

    def fill(text: str) -> str:
        for label, value in creds.items():
            text = text.replace(f"@@{label}@@", value)
        return text.replace("/home/omnigent", str(home)).replace("/tmp/", f"{tmp}/")

    for rel, text in doc["files"].items():
        root, _, sub = rel.partition("/")
        path = (home if root == "home" else tmp) / sub
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(fill(text))
    env = {k: fill(v) for k, v in doc["runner_env"].items()}
    ids = {k: fill(v) for k, v in doc["identifiers"].items()}
    return creds, ids, env


def _holder(env: dict[str, str]) -> subprocess.Popen[bytes]:
    return subprocess.Popen([sys.executable, "-c", "import time; time.sleep(120)"], env=env)


CREDENTIAL_NAMES = [
    "token",
    "accessToken",
    "refreshToken",
    "access_token",
    "refresh_token",
    "id_token",
    "clientSecret",
    "client_secret",
    "privateKeyPkcs8B64",
    "Authorization",
    "Cookie",
    "X-Omnigent-Host-Token",
    "X-Omnigent-Runner-Tunnel-Token",
    "X-Omnigent-Client-Secret",
    "X-Api-Key",
    "OMNIGENT_HOST_TOKEN",
    "OMNIGENT_RUNNER_TUNNEL_BINDING_TOKEN",
    "OMNIGENT_RUNNER_INITIAL_AUTH_TOKEN",
    "OMNIGENT_RELAY_TOKEN",
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "GH_TOKEN",
    "AWS_SECRET_ACCESS_KEY",
    "provider_key",
    "password",
]
IDENTIFIER_NAMES = [
    "account_id",
    "login_owner_id",
    "client_id",
    "issuer",
    "X-Omnigent-Installation-Id",
    "X-Databricks-Omnigent-Slice-Key",
    "X-Omnigent-Signing-Key-Id",
    "bridge_id",
    "active_session_id",
    "conversation_id",
    "session_id",
    "ap_server_url",
    "url",
    "name",
    "description",
    "command",
    "workspace",
    "rateLimitTier",
    "subscriptionType",
    "refreshTokenExpiresAt",
    "expiresAt",
    "token_type",
    "auth_mode",
    "rowPk",
    "publicKey",
    "apiKeyHelper",
    "OMNIGENT_RUNNER_SLICE_KEY",
    "OMNIGENT_RUNNER_ID",
    "OMNIGENT_TOKEN_USAGE_JSON",
    "OMNIGENT_HOST_TOKEN_REFUSED_EXIT_S",
    "GPG_KEY",
    "SSH_AUTH_SOCK",
    "PWD",
    "",
]


@pytest.mark.parametrize("name", CREDENTIAL_NAMES)
def test_a_credential_name_is_collected(name: str) -> None:
    from cfo_computer import rc53_collect

    value = canary("named")
    assert rc53_collect.credential_name(name)
    assert value in rc53_collect.from_string(name, value)


@pytest.mark.parametrize("name", IDENTIFIER_NAMES)
def test_an_identifier_name_is_not_collected(name: str) -> None:
    from cfo_computer import rc53_collect

    assert not rc53_collect.credential_name(name)
    assert rc53_collect.from_string(name, canary("identifier")) == set()


def test_bearers_assignments_formats_and_helpers() -> None:
    """Rules 2 to 5, and their refusals: a shell variable is not a value, a credential name
    holding a path or a plain URL is not a credential."""
    from cfo_computer import rc53_collect as C

    tok = canary("t")
    assert tok in C.from_string("command", f'curl -H "Authorization: Bearer {tok}" x')
    assert (
        C.from_string(
            "command",
            'curl -H "Authorization: Bearer $OMNIGENT_RELAY_TOKEN" "$OMNIGENT_RELAY_URL/h"',
        )
        == set()
    )
    assert C.from_string("", f"OMNIGENT_RELAY_TOKEN='{tok}'") == {tok}
    assert C.from_string("", "OMNIGENT_RELAY_URL='http://127.0.0.1:41234'") == set()
    assert C.from_string(
        "url", f"http://127.0.0.1:1/x?token={tok}&session_id=conv_1234567890abcdef"
    )
    assert tok in C.from_string("url", f"https://x-access-token:{tok}@github.com/o/r")
    for shaped in (f"sk-ant-oat01-{tok}", f"sk-proj-{tok}", f"eyJhbGciOiJ9.eyJzdWIiOiJ9.{tok}"):
        assert shaped in C.from_string("description", f"see {shaped} here")
    assert C.from_string("apiKeyHelper", f"printf %s '{tok}'") == {tok}
    assert C.from_string("OMNIGENT_CLAUDE_API_KEY_HELPER", f"echo -n {tok}") == {tok}
    assert (
        C.from_string("apiKeyHelper", "databricks auth token --host https://example.test") == set()
    )
    # Only a path that exists is a reference (see the opaque test); this one is a value.
    missing = "/home/omnigent/.config/gcloud/k.json"
    assert C.from_string("GOOGLE_APPLICATION_CREDENTIALS", missing) == {missing}
    assert C.from_string("token", "https://omnigent.example.test/v1/token") == set()


def test_opaque_credentials_are_collected_whatever_they_start_with(tmp_path: Path) -> None:
    """Codex WP3.22 r1, findings 1 and 2: a credential is taken by where it is, not by its
    look. A helper's key may start with "-" or "$" or hold "%" or a quote once quoted; a token
    may start with "/". Only an expansion, a plain URL or an existing path is not a value. Each
    is then found in a layer by the actual scanner."""
    import shlex

    from cfo_computer import rc53_collect as C

    tok = canary("opaque")
    keys = ["-" + tok, "$" + tok, tok[:8] + "%s%d" + tok[8:], tok + "'s", "/" + tok + "+=="]
    for key in keys:
        assert C.from_string("apiKeyHelper", f"printf %s {shlex.quote(key)}") == {key}, key
        assert C.from_string("apiKeyHelper", f"printf -- '%s' {shlex.quote(key)}") == {key}, key
        assert C.from_string("OMNIGENT_CLAUDE_API_KEY_HELPER", f"echo -n {shlex.quote(key)}") == {
            key
        }
    assert C.from_string("apiKeyHelper", f"printf {shlex.quote(tok)}") == {tok}
    for expansion in ('printf %s "$ANTHROPIC_API_KEY"', "printf %s $ANTHROPIC_API_KEY_LONG"):
        assert C.from_string("apiKeyHelper", expansion) == set()
    slash = "/" + tok + "+=="
    assert C.from_string("accessToken", slash) == {slash}
    assert C.from_environ(f"AWS_SECRET_ACCESS_KEY={slash}".encode()) == {slash}
    assert C.from_string("", f"OMNIGENT_RELAY_TOKEN='${tok}'") == {"$" + tok}
    assert C.from_string("", 'OMNIGENT_RELAY_TOKEN="$SOME_VARIABLE_NAME_HERE"') == set()
    existing = tmp_path / "service-account.json"
    existing.write_text("{}")
    assert C.from_string("GOOGLE_APPLICATION_CREDENTIALS", str(existing)) == set()
    # End to end: a leaked key alone in a saved file is found.
    (tmp_path / "layer").mkdir()
    for i, key in enumerate(keys):
        (tmp_path / "layer" / f"{i}.txt").write_text(f"leaked {key} here")
    code, report = rc53_scan.run([tmp_path / "layer"], sorted(set(keys)), [])
    assert code == 1 and len({f["file"] for f in report["findings"]}) == len(keys), report


def test_the_collector_takes_every_credential_and_no_identifier(tmp_path: Path) -> None:
    from cfo_computer import rc53_collect

    home, tmp = tmp_path / "home", tmp_path / "tmp"
    creds, ids, env = _formats(home, tmp)
    holder = _holder(env)
    try:
        got = rc53_collect.collect(home, tmp_roots=[tmp], process_scope={holder.pid})
    finally:
        holder.kill()
    assert sorted(k for k, v in creds.items() if v not in got) == []
    # Anything else collected is a credential in context ("Bearer <token>"), never on its own.
    assert [v[:24] for v in got if not any(c in v for c in creds.values())] == []
    assert sorted(k for k, v in ids.items() if v in got) == []
    assert len(ids) > 50, "the fixture names every identifier the sitting flagged"


def test_a_save_holding_every_identifier_passes_and_a_credential_still_fails(
    tmp_path: Path,
) -> None:
    """The sitting's case on the actual receiver: transcripts, settings and logs that hold every
    identifier (as Claude's and Codex's do) save cleanly with the check on; one credential in a
    saved file still fails the save before it is offered for upload."""
    rig = Rig(tmp_path / "a")
    holder = None
    try:
        tmp = tmp_path / "bridges"
        creds, ids, env = _formats(rig.home, tmp)
        holder = _holder(env)
        rig.sup.scope_pids = [holder.pid]
        rig.boot()
        (rig.layout.state / "rc53").mkdir()
        (rig.layout.state / "rc53" / "enabled").write_text("")
        rig.sup.rc53_tmp_roots = [tmp]
        transcript = [{"type": "tool_use", "label": k, "value": v} for k, v in ids.items()]
        (rig.home / "work").mkdir(exist_ok=True)
        (rig.home / "work" / "transcript.jsonl").write_text(
            "\n".join(json.dumps(x) for x in transcript)
        )
        (rig.home / ".claude.json").write_text(json.dumps({"ids": list(ids.values())}))
        op, job = rig.capture()
        assert job["state"] == "staged", job
        result = rig.result(op)["rc53"]
        assert result["status"] == 0 and result["findings"] == 0, result
        assert result["values"] >= len(creds)
        rig.finish(op)
        (rig.home / "work" / "leak.txt").write_text(f"relay {creds['relay_token']}")
        op, job = rig.capture(
            "delta", {"checkpointId": new_id("ckp"), "treeDigest": job["treeDigest"]}
        )
        assert job["state"] == "failed" and job["reason"] == "policy_violation", job
        assert creds["relay_token"] not in json.dumps(rig.result(op))
    finally:
        if holder is not None:
            holder.kill()
        rig.close()
