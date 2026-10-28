"""Sign-in from the setup page (WP3.23): the supervisor's parser and attempts.

- The parser (``signin.parse``) against the pinned CLIs' captured transcripts
  (images/computer/fakes/login_transcripts.json: Claude Code 2.1.311 and Codex 0.164.0, with
  placeholders), whole and cut into every possible pair of reads.
- The actual receiver: the real supervisor over HTTP, running the fake CLIs, which replay those
  transcripts in a pty with synthetic canary values: success, a wrong code, an incomplete code,
  expiry, cancel, unparseable output, a link on another host, a crash, a network failure, a
  denial, a supervisor restart, the fence (stale tabs, delayed starts, cancel before delivery),
  and a sign-out that ends a running attempt.
- Custody: the link's state, the expected code and Codex's device code never appear in the
  supervisor's files, logs, alerts, journal, the CLIs' files, a capture's staged layer or the
  status; whole process groups are killed and reaped.
"""

from __future__ import annotations

import importlib.util
import json
import os
import re
import time
from pathlib import Path
from typing import Any

import pytest
from cfo_computer import signin as SI
from harness import COMPUTER, FakeWorkspace, Rig, new_id

TRANSCRIPTS = json.loads((COMPUTER / "fakes" / "login_transcripts.json").read_text())
CLAUDE_VALUES = {
    "state": "synthetic-state-0000",
    "code_challenge": "synthetic-challenge-0000",
    "client_id": TRANSCRIPTS["claude"]["client_id"],
}
CODEX_VALUES = {"url": TRANSCRIPTS["codex"]["url"], "user_code": "SYNT-H0000"}


def _fake_module():
    spec = importlib.util.spec_from_file_location("fake_cli", COMPUTER / "fakes" / "fake_cli.py")
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def _text(chunks: list[dict[str, Any]], values: dict[str, str], upto_input: bool = False) -> str:
    out = []
    for chunk in chunks:
        if chunk.get("input"):
            if upto_input:
                break
            out.append("\x00INPUT\x00")
            continue
        text = chunk["text"]
        for key, value in values.items():
            text = text.replace("{" + key + "}", value)
        out.append(text)
    return "".join(out)


def _split_input(text: str) -> tuple[str, int]:
    """The output with the input mark removed, and the offset where the code was written."""
    at = text.find("\x00INPUT\x00")
    return text.replace("\x00INPUT\x00", ""), at


# ---------------------------------------------------------------------------------------------
# The parser, on the captured transcripts.


def test_claude_prompt_gives_the_link_and_waits():
    raw = _text(TRANSCRIPTS["claude"]["prompt"]["chunks"], CLAUDE_VALUES)
    parsed = SI.parse("claude", raw)
    assert parsed.waiting and parsed.failure is None and not parsed.success
    assert parsed.url is not None and SI.link_allowed("claude", parsed.url)
    assert "state=synthetic-state-0000" in parsed.url


def test_claude_success_wrong_and_incomplete_codes():
    ok, at = _split_input(_text(TRANSCRIPTS["claude"]["success"]["chunks"], CLAUDE_VALUES))
    assert SI.parse("claude", ok, at).success
    assert not SI.parse("claude", ok, -1).success  # only what follows the code counts
    wrong, at = _split_input(_text(TRANSCRIPTS["claude"]["wrong_code"]["chunks"], CLAUDE_VALUES))
    assert SI.parse("claude", wrong, at).failure == "code_rejected"
    partial, at = _split_input(
        _text(TRANSCRIPTS["claude"]["incomplete_code"]["chunks"], CLAUDE_VALUES)
    )
    parsed = SI.parse("claude", partial, at)
    assert parsed.incomplete and parsed.failure is None and parsed.waiting


def test_codex_prompt_gives_the_link_and_code():
    raw = _text(TRANSCRIPTS["codex"]["prompt"]["chunks"], CODEX_VALUES)
    parsed = SI.parse("codex", raw)
    assert parsed.waiting
    assert parsed.url == "https://auth.openai.com/codex/device"
    assert parsed.user_code == "SYNT-H0000"


@pytest.mark.parametrize(("key", "reason"), [("denied", "denied"), ("network_error", "network")])
def test_codex_failures_have_fixed_reasons(key, reason):
    raw = _text(TRANSCRIPTS["codex"][key]["chunks"], CODEX_VALUES)
    assert SI.parse("codex", raw).failure == reason


def test_codex_success():
    raw = _text(TRANSCRIPTS["codex"]["success"]["chunks"], CODEX_VALUES)
    assert SI.parse("codex", raw).success


@pytest.mark.parametrize(
    ("service", "key", "values"),
    [
        ("claude", "prompt", CLAUDE_VALUES),
        ("claude", "success", CLAUDE_VALUES),
        ("codex", "prompt", CODEX_VALUES),
        ("codex", "success", CODEX_VALUES),
    ],
)
def test_a_read_cut_anywhere_is_never_misjudged(service, key, values):
    """Reads can end anywhere, even inside the link: no prefix is ever judged unexpected, and
    once all is read the parse equals the whole transcript's."""
    raw, _ = _split_input(_text(TRANSCRIPTS[service][key]["chunks"], values))
    whole = SI.parse(service, raw)
    for cut in range(len(raw) + 1):
        parsed = SI.parse(service, raw[:cut])
        assert parsed.failure != "unexpected_output", cut
        if parsed.url is not None:
            assert parsed.url == whole.url, cut
        if parsed.user_code is not None:
            assert parsed.user_code == whole.user_code, cut


@pytest.mark.parametrize(
    ("service", "url"),
    [
        ("claude", "https://claude.example.net/cai/oauth/authorize?state=x"),
        ("claude", "http://claude.com/cai/oauth/authorize?state=x"),
        ("claude", "https://claude.com:8443/cai/oauth/authorize?state=x"),
        ("claude", "https://user@claude.com/cai/oauth/authorize?state=x"),
        ("claude", "https://claude.com/other?state=x"),
        ("codex", "https://auth.openai.com.example.net/codex/device"),
        ("codex", "https://auth.openai.com/codex/device'x"),
        ("codex", "https://auth.openai.com:x/codex/device"),
        ("codex", "https://auth.openai.com/codex/device?" + "a" * 2048),
    ],
)
def test_a_link_off_the_pinned_host_or_path_is_refused(service, url):
    assert not SI.link_allowed(service, url)


def test_a_link_off_the_pinned_host_fails_the_parse():
    raw = _text(TRANSCRIPTS["claude"]["prompt"]["chunks"], CLAUDE_VALUES).replace(
        "https://claude.com/", "https://claude.example.net/"
    )
    assert SI.parse("claude", raw).failure == "unexpected_output"
    codex = _text(TRANSCRIPTS["codex"]["prompt"]["chunks"], CODEX_VALUES)
    assert (
        SI.parse("codex", codex.replace("SYNT-H0000", "not a code")).failure == "unexpected_output"
    )
    assert (
        SI.parse("codex", codex.replace("auth.openai.com", "evil.example")).failure
        == "unexpected_output"
    )


def test_plain_text_drops_escape_sequences():
    assert SI.plain("\x1b]8;;https://x\x07\x1b[94mA\x1b[39m\x1b]8;;\x07\r\nB") == "A\nB"


# ---------------------------------------------------------------------------------------------
# The actual receiver, with the fake CLIs in a pty.


def _until(predicate, timeout: float = 20.0, what: str = "condition"):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        value = predicate()
        if value:
            return value
        time.sleep(0.05)
    raise AssertionError(f"timed out waiting for {what}")


@pytest.fixture
def rig(tmp_path: Path):
    workspace = FakeWorkspace()
    rig = Rig(tmp_path / "a", workspace=workspace)
    rig.provider = tmp_path / "provider" / "state.json"
    rig.sup.extra_env = {"CFO_FAKE_PROVIDER": str(rig.provider)}
    os.environ["CFO_FAKE_PROVIDER"] = str(rig.provider)
    rig.fake = _fake_module()
    rig.sup.start_loops()
    rig.boot()
    yield rig
    rig.close()
    rig.sup.signins.join()
    workspace.close()
    os.environ.pop("CFO_FAKE_PROVIDER", None)


def _view(rig: Rig, kind: str, service: str, attempt: int, **extra) -> dict[str, Any]:
    reply = rig.ok(kind, service=service, attempt=attempt, **extra)
    return reply["view"]


def _wait_state(rig: Rig, service: str, attempt: int, *states: str) -> dict[str, Any]:
    return _until(
        lambda: (v := _view(rig, "sign_in_status", service, attempt))["state"] in states and v,
        what=f"{service} attempt {attempt} to reach {states}",
    )


def _group_gone(pid: int) -> bool:
    try:
        os.killpg(pid, 0)
    except ProcessLookupError:
        return True
    return False


def _pid(rig: Rig, service: str) -> int:
    attempt = rig.sup.signins._current[service]
    assert attempt is not None and attempt.proc is not None
    return attempt.proc.pid


def _published(rig: Rig, path: str) -> bool:
    pointer = rig.workspace.pointer
    return bool(pointer) and pointer["files"][path]["state"] == "present"


def _secrets_absent(rig: Rig, values: list[str], replies: list[dict[str, Any]] = ()) -> None:
    """None of ``values`` is in the supervisor's or the CLIs' files, its alerts, its journal, or
    the given replies (views returned after the attempt ended)."""
    for path in rig.root.rglob("*"):
        if path.is_file():
            data = path.read_bytes()
            for value in values:
                assert value.encode() not in data, path
    for value in values:
        assert value not in json.dumps(rig.sup.alerts)
        assert value not in json.dumps({k: v for k, v in rig.sup._journal.items()})
        assert value not in json.dumps(rig.sup.computer_status())
        for reply in replies:
            assert value not in json.dumps(reply)


def test_claude_signs_in_with_the_pasted_code(rig: Rig):
    assert _view(rig, "sign_in_start", "claude", 1)["state"] in ("starting", "awaiting_user")
    view = _wait_state(rig, "claude", 1, "awaiting_user")
    pending = rig.fake.pending_login("claude")
    assert view["url"].startswith("https://claude.com/cai/oauth/authorize?")
    assert f"state={pending['state']}" in view["url"]
    assert "userCode" not in view
    pid = _pid(rig, "claude")
    view = _view(rig, "sign_in_input", "claude", 1, code=pending["code"])
    assert view["state"] == "completing"
    done = _wait_state(rig, "claude", 1, "done")
    assert set(done) == {"service", "attempt", "state"}
    _until(lambda: _group_gone(pid), what="the login's process group to be reaped")
    _until(lambda: _published(rig, ".claude/.credentials.json"), what="the login published")
    _secrets_absent(rig, [pending["code"], pending["state"]], [done])
    # A capture after the sign-in holds none of them either (the saved layer).
    op, job = rig.capture()
    assert job["state"] == "staged", job
    _secrets_absent(rig, [pending["code"], pending["state"]])


def test_a_wrong_code_fails_and_an_incomplete_one_waits(rig: Rig):
    rig.ok("sign_in_start", service="claude", attempt=1)
    _wait_state(rig, "claude", 1, "awaiting_user")
    pending = rig.fake.pending_login("claude")
    view = _view(rig, "sign_in_input", "claude", 1, code="no-separator")
    assert view["state"] == "completing"
    view = _wait_state(rig, "claude", 1, "awaiting_user")
    assert view["notice"] == "incomplete_code" and view["url"]
    pid = _pid(rig, "claude")
    rig.ok("sign_in_input", service="claude", attempt=1, code="WRONG#" + pending["state"])
    failed = _wait_state(rig, "claude", 1, "failed")
    assert failed == {
        "service": "claude",
        "attempt": 1,
        "state": "failed",
        "reason": "code_rejected",
    }
    assert _group_gone(pid)
    assert rig.sup.alert_counts.get("sign_in_failed") == 1
    assert not (rig.home / ".claude" / ".credentials.json").exists()
    # The attempt ended: its code cannot be sent again; a new attempt can sign in.
    status, err = rig.send("sign_in_input", service="claude", attempt=1, code=pending["code"])
    assert status == 409 and err["error"]["code"] == "conflict"
    rig.ok("sign_in_start", service="claude", attempt=2)
    _wait_state(rig, "claude", 2, "awaiting_user")
    rig.ok(
        "sign_in_input", service="claude", attempt=2, code=rig.fake.pending_login("claude")["code"]
    )
    _wait_state(rig, "claude", 2, "done")


def test_a_repeated_input_writes_the_code_once(rig: Rig):
    rig.ok("sign_in_start", service="claude", attempt=1)
    _wait_state(rig, "claude", 1, "awaiting_user")
    code = rig.fake.pending_login("claude")["code"]
    op = new_id("op")
    first = rig.ok("sign_in_input", op=op, service="claude", attempt=1, code=code)
    again = rig.ok("sign_in_input", op=op, service="claude", attempt=1, code=code)
    assert again["view"]["state"] == first["view"]["state"] == "completing"
    assert "url" not in again["view"]  # the journal never keeps the link
    _wait_state(rig, "claude", 1, "done")


def test_codex_signs_in_once_the_code_is_entered_at_the_provider(rig: Rig):
    rig.ok("sign_in_start", service="codex", attempt=1)
    view = _wait_state(rig, "codex", 1, "awaiting_user")
    pending = rig.fake.pending_login("codex")
    assert view["url"] == "https://auth.openai.com/codex/device"
    assert view["userCode"] == pending["user_code"]
    status, err = rig.send("sign_in_input", service="codex", attempt=1, code="anything#x")
    assert status == 409 and err["error"]["code"] == "conflict"
    rig.fake.decide("codex", True)
    done = _wait_state(rig, "codex", 1, "done")
    _until(lambda: _published(rig, ".codex/auth.json"), what="the Codex login published")
    _secrets_absent(rig, [pending["user_code"]], [done])


@pytest.mark.parametrize(
    ("service", "mode", "reason"),
    [
        ("codex", "denied", "denied"),
        ("codex", "network", "network"),
        ("claude", "crash", "cli_exited"),
        ("codex", "crash", "cli_exited"),
        ("claude", "wrong_host", "unexpected_output"),
        ("codex", "wrong_host", "unexpected_output"),
    ],
)
def test_failures_end_with_fixed_reasons(rig: Rig, service, mode, reason):
    rig.sup.extra_env["CFO_FAKE_LOGIN"] = mode
    rig.ok("sign_in_start", service=service, attempt=1)
    view = _wait_state(rig, service, 1, "failed")
    assert view == {"service": service, "attempt": 1, "state": "failed", "reason": reason}
    assert rig.sup.signins._current[service].proc is None or _group_gone(_pid(rig, service))
    # A parser failure keeps nothing either: the values the fake CLI printed are nowhere.
    pending = rig.fake.pending_login(service) or {}
    values = [v for k, v in pending.items() if k in ("code", "state", "user_code") and v]
    if values:
        _secrets_absent(rig, values, [view])


@pytest.mark.parametrize("service", ["claude", "codex"])
def test_unparseable_output_fails_after_the_link_timeout(rig: Rig, service):
    rig.sup.extra_env["CFO_FAKE_LOGIN"] = "garbage"
    rig.sup.signins.link_timeout_s = 1.5
    rig.ok("sign_in_start", service=service, attempt=1)
    _until(lambda: rig.sup.signins._current[service].proc, what="the CLI to start")
    pid = _pid(rig, service)
    view = _wait_state(rig, service, 1, "failed")
    assert view["reason"] == "unexpected_output"
    assert _group_gone(pid)


@pytest.mark.parametrize("service", ["claude", "codex"])
def test_the_platform_deadline_expires_an_attempt(rig: Rig, service):
    rig.sup.extra_env["CFO_FAKE_LOGIN"] = "hang"
    rig.sup.signins.deadline_s = 1.5
    rig.ok("sign_in_start", service=service, attempt=1)
    _wait_state(rig, service, 1, "awaiting_user")
    pid = _pid(rig, service)
    view = _wait_state(rig, service, 1, "expired")
    assert view == {"service": service, "attempt": 1, "state": "expired"}
    assert _group_gone(pid)


def test_cancel_kills_and_reaps_the_whole_group(rig: Rig):
    rig.ok("sign_in_start", service="codex", attempt=4)
    _wait_state(rig, "codex", 4, "awaiting_user")
    pid = _pid(rig, "codex")
    view = _view(rig, "sign_in_cancel", "codex", 4)
    assert view == {"service": "codex", "attempt": 4, "state": "cancelled"}
    assert _group_gone(pid)
    assert rig.sup.signins.states()["codex"] == "cancelled"
    # Idempotent; and the start, delivered late, does not begin again.
    assert _view(rig, "sign_in_cancel", "codex", 4)["state"] == "cancelled"
    assert _view(rig, "sign_in_start", "codex", 4)["state"] == "cancelled"


def test_the_fence_refuses_stale_tabs_and_delayed_starts(rig: Rig):
    rig.ok("sign_in_start", service="claude", attempt=2)
    _wait_state(rig, "claude", 2, "awaiting_user")
    first = _pid(rig, "claude")
    # An older start arriving late never begins.
    assert _view(rig, "sign_in_start", "claude", 1)["state"] == "superseded"
    # A newer attempt (another tab) ends the running one first.
    rig.ok("sign_in_start", service="claude", attempt=3)
    assert _group_gone(first)
    assert _view(rig, "sign_in_status", "claude", 2)["state"] == "superseded"
    # The old tab's code and cancel act on its own attempt only.
    status, _ = rig.send("sign_in_input", service="claude", attempt=2, code="x#y")
    assert status == 409
    assert _view(rig, "sign_in_cancel", "claude", 2)["state"] == "superseded"
    assert _wait_state(rig, "claude", 3, "awaiting_user")["state"] == "awaiting_user"
    # A cancel of an attempt whose start has not arrived yet: the start never begins, and the
    # running older attempt ends too.
    third = _pid(rig, "claude")
    assert _view(rig, "sign_in_cancel", "claude", 5)["state"] == "cancelled"
    assert _group_gone(third)
    assert _view(rig, "sign_in_start", "claude", 5)["state"] == "cancelled"
    assert rig.sup.signins._current["claude"].number == 3
    assert _view(rig, "sign_in_status", "claude", 6)["state"] == "none"
    # Codex has its own fence.
    assert _view(rig, "sign_in_status", "codex", 1)["state"] == "none"


def test_a_sign_out_ends_a_running_attempt_first(rig: Rig):
    rig.ok("sign_in_start", service="codex", attempt=1)
    _wait_state(rig, "codex", 1, "awaiting_user")
    pid = _pid(rig, "codex")
    reply = rig.ok("sign_out")
    assert reply["codex"] == "ok"
    assert _group_gone(pid)
    assert _view(rig, "sign_in_status", "codex", 1)["state"] == "cancelled"
    assert _view(rig, "sign_in_start", "codex", 1)["state"] == "cancelled"


def test_a_restarted_supervisor_knows_no_attempt(rig: Rig, tmp_path: Path):
    rig.ok("sign_in_start", service="claude", attempt=1)
    _wait_state(rig, "claude", 1, "awaiting_user")
    pid = _pid(rig, "claude")
    rig.sup.stop()  # a container's end ends its attempts with it
    assert _group_gone(pid)
    other = Rig(tmp_path / "b", computer_id=rig.computer_id, generation=rig.generation)
    try:
        status, reply = other.send("sign_in_status", service="claude", attempt=1)
        assert status == 200 and reply["view"]["state"] == "none"
    finally:
        other.close()


def test_a_start_before_the_credentials_are_installed_fails_not_ready(tmp_path: Path):
    rig = Rig(tmp_path / "n")
    try:
        view = rig.ok("sign_in_start", service="claude", attempt=1)["view"]
        assert view == {"service": "claude", "attempt": 1, "state": "failed", "reason": "not_ready"}
    finally:
        rig.close()


def test_a_spawn_that_fails_is_start_failed(rig: Rig):
    rig.sup.tools.codex = str(rig.root / "no-such-codex")
    rig.ok("sign_in_start", service="codex", attempt=1)
    # setsid runs, but the CLI cannot be executed: it exits at once.
    assert _wait_state(rig, "codex", 1, "failed")["reason"] in ("cli_exited", "start_failed")


def test_a_spawn_error_is_start_failed():
    def spawn(_service):
        raise OSError("no pty")

    signins = SI.SignIns(spawn)
    signins.start("claude", 1)
    signins.join()
    assert signins.status("claude", 1) == {
        "service": "claude",
        "attempt": 1,
        "state": "failed",
        "reason": "start_failed",
    }


def test_output_beyond_its_bound_is_unexpected():
    attempt = SI.Attempt("codex", 1, started=0.0, deadline=100.0)
    attempt.out += b"x" * (SI.MAX_OUTPUT_BYTES + 1)
    signins = SI.SignIns(lambda s: (_ for _ in ()).throw(OSError()), clock=lambda: 1.0)
    with signins._lock:
        assert signins._step(attempt, exited=False)
    assert attempt.view()["reason"] == "unexpected_output"


def test_only_claude_takes_a_code_and_never_a_control_character():
    signins = SI.SignIns(lambda s: (_ for _ in ()).throw(OSError()))
    for service, code in [("codex", "a#b"), ("claude", "a\rb"), ("claude", "a b")]:
        with pytest.raises(SI.SignInConflict):
            signins.write(service, 1, code)


# ---------------------------------------------------------------------------------------------
# computer_status and the staging check.


def test_computer_status_holds_names_and_counts_only(rig: Rig):
    rig.sup.refresh_versions()
    rig.sup._alert("the capture left paths out: /home/omnigent/secret-name")
    rig.sup._alert("command failed: ValueError")
    status = rig.ok("computer_status")["status"]
    assert status["versions"] == {"claude": "2.1.311", "codex": "0.164.0", "gh": None} or (
        status["versions"]["claude"] == "2.1.311" and status["versions"]["codex"] == "0.164.0"
    )
    assert status["supervisorVersion"] == "0.2.0"
    assert status["signIn"] == {"claude": "none", "codex": "none"}
    assert status["hostname"] in ("mapped", "unmapped", "unknown")
    assert status["disk"]["totalBytes"] >= status["disk"]["freeBytes"] > 0
    kinds = {a["kind"]: a["count"] for a in status["alerts"]}
    assert kinds["capture_skipped_paths"] == 1 and kinds["command_failed"] == 1
    assert "secret-name" not in json.dumps(status)
    assert "/home" not in json.dumps(status)


def test_the_staging_check_switches_rc53_and_captures_report_counts(rig: Rig):
    assert rig.ok("computer_status")["status"]["rc53"] is False
    assert rig.ok("staging_check", rc53=True) == {"type": "staging_check", "rc53": True}
    assert (rig.layout.state / "rc53" / "enabled").exists()
    assert rig.ok("computer_status")["status"]["rc53"] is True
    (rig.home / "work").mkdir(exist_ok=True)
    (rig.home / "work" / "a.txt").write_text("hello\n")
    op, job = rig.capture()
    assert job["state"] == "staged", job
    captures = rig.ok("computer_status")["status"]["captures"]
    assert captures[-1]["jobOperationId"] == op
    assert set(captures[-1]["rc53"]) == {"status", "values", "files", "findings", "incomplete"}
    assert captures[-1]["rc53"]["status"] == 0
    assert rig.ok("staging_check", rc53=False)["rc53"] is False
    assert not (rig.layout.state / "rc53" / "enabled").exists()
    assert rig.ok("staging_check", rc53=False)["rc53"] is False


def test_hello_names_the_features(rig: Rig):
    hello = _until(lambda: rig.workspace.of("hello"), what="the hello")[0]
    assert hello["features"] == ["sign_in", "computer_status", "staging_check"]


def test_versions_are_normalized():
    from cfo_computer import status as S

    assert S.normalized_version(b"2.1.311 (Claude Code)\n") == "2.1.311"
    assert S.normalized_version(b"codex-cli 0.164.0\n") == "0.164.0"
    assert S.normalized_version(b"gh version 2.103.3 (2026-10-01)\nhttps://x\n") == "2.103.3"
    assert S.normalized_version(b"no version") is None
    assert S.normalized_version(None) is None


def test_hostname_and_counts_helpers(tmp_path: Path):
    from cfo_computer import status as S

    hosts = tmp_path / "hosts"
    hosts.write_text("127.0.0.1 localhost\n127.0.1.1\tabc123 # mapped\n")
    assert S.hostname_mapped(hosts, "abc123") == "mapped"
    assert S.hostname_mapped(hosts, "other") == "unmapped"
    assert S.hostname_mapped(tmp_path / "missing", "abc") == "unknown"
    assert S.hostname_mapped(hosts, "") == "unknown"
    assert S.rc53_counts({}) is None
    assert S.rc53_counts({"rc53": {"status": 1, "values": 2, "files": 3, "findings": 4}}) is None
    assert (
        S.rc53_counts(
            {"rc53": {"status": 1, "values": 2, "files": 3, "findings": True, "incomplete": 0}}
        )
        is None
    )
    assert S.rc53_counts(
        {"rc53": {"status": 300, "values": 2, "files": 3, "findings": 4, "incomplete": 0}}
    ) == {"status": 255, "values": 2, "files": 3, "findings": 4, "incomplete": 0}
    assert S.alert_kind("anything else") == "other"
    assert S.alert_kind("anything else", credential=True) == "credential_alert"
    assert S.disk(tmp_path / "missing") is None


def test_the_status_schema_refuses_alert_text():
    """The contract itself refuses an alert's text where a kind belongs."""
    from cfo_computer.contract import Contract
    from harness import REPO

    contract = Contract(REPO / "contracts" / "schema")
    bad = {
        "type": "computer_status",
        "status": {
            "supervisorVersion": "0.2.0",
            "versions": {"claude": None, "codex": None, "gh": None},
            "logins": {"claude": "unknown", "codex": "unknown"},
            "signIn": {"claude": "none", "codex": "none"},
            "rc53": False,
            "hostname": "unknown",
            "disk": None,
            "alerts": [{"kind": "the capture left paths out: /x", "count": 1}],
            "captures": [],
        },
    }
    with pytest.raises(Exception):  # noqa: B017 - the schema's own error
        contract.check_outbound("WorkspaceCommandReply", bad)
    assert re.match(r"^\d", "2")
