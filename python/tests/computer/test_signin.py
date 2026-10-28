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

import contextlib
import importlib.util
import json
import os
import random
import re
import select
import subprocess
import threading
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
    def spawn(_service, _cancelled):
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


def _sleeper() -> tuple[subprocess.Popen[bytes], int]:
    """A process in its own session, with a pty: what a spawn makes."""
    master, slave = os.openpty()
    proc = subprocess.Popen(
        ["sleep", "60"], stdin=slave, stdout=slave, stderr=slave, start_new_session=True
    )
    os.close(slave)
    return proc, master


def test_a_cancel_mid_spawn_answers_only_once_nothing_can_start():
    """Codex r1-3: a spawn waiting for a capture's gate gives up when the attempt ends; one that
    completes anyway is killed and reaped before the cancel is answered."""
    gate = threading.Event()
    gave_up = []

    def waits_for_the_gate(_service, cancelled):
        while not gate.wait(0.05):
            if cancelled():
                gave_up.append(True)
                raise SI.SpawnCancelled
        return _sleeper()

    signins = SI.SignIns(waits_for_the_gate)
    signins.start("codex", 1)
    view = signins.cancel("codex", 1)
    assert view["state"] == "cancelled" and gave_up == [True]
    assert signins._current["codex"].proc is None

    made = []

    def ignores_the_cancel(_service, _cancelled):
        time.sleep(0.5)
        proc, fd = _sleeper()
        made.append(proc)
        return proc, fd

    signins = SI.SignIns(ignores_the_cancel)
    signins.start("claude", 1)
    assert signins.cancel("claude", 1)["state"] == "cancelled"
    assert made and made[0].poll() is not None and _group_gone(made[0].pid)
    # A newer start ends an older one mid-spawn the same way before it begins.
    made.clear()
    signins.start("claude", 2)
    signins.start("claude", 3)
    assert made and made[0].poll() is not None
    signins.cancel_all()
    signins.join()
    assert all(p.poll() is not None for p in made)


def _wedged_spawner(release: threading.Event, made: list):
    def wedged(_service, _cancelled):
        release.wait(10)
        proc, fd = _sleeper()
        made.append(proc)
        return proc, fd

    return wedged


def test_an_unsettled_spawn_stays_owed_until_it_is_over(monkeypatch):
    """Codex r2-1: a spawn not over within the bound is never forgotten: every later cancel that
    covers it, and every sign-out, waits for it and fails retryably until it is reaped."""
    monkeypatch.setattr(SI, "SPAWN_SETTLE_S", 0.2)
    release, made = threading.Event(), []
    signins = SI.SignIns(_wedged_spawner(release, made))
    signins.start("codex", 1)
    with pytest.raises(SI.SignInUnsettled):
        signins.cancel("codex", 1)
    # Retries, and a sign-out, still see it.
    with pytest.raises(SI.SignInUnsettled):
        signins.cancel("codex", 1)
    assert signins.cancel_all() is False
    assert signins.cancel_all() is False
    release.set()
    assert signins.cancel_all() is True
    assert made and made[0].poll() is not None and _group_gone(made[0].pid)
    assert signins.cancel("codex", 1)["state"] == "cancelled"
    signins.join()


def test_a_superseded_spawn_stays_owed_by_the_newer_attempts_cancel(monkeypatch):
    monkeypatch.setattr(SI, "SPAWN_SETTLE_S", 0.2)
    release, made = threading.Event(), []
    signins = SI.SignIns(_wedged_spawner(release, made))
    signins.start("claude", 1)
    signins.start("claude", 2)  # attempt 1's spawn is past the bound: 2 starts anyway
    with pytest.raises(SI.SignInUnsettled):
        signins.cancel("claude", 2)  # covers attempt 1 too
    release.set()
    assert signins.cancel("claude", 2)["state"] == "cancelled"
    assert made and all(p.poll() is not None for p in made)
    signins.join()
    assert all(p.poll() is not None for p in made)


def test_cancelling_a_superseded_attempt_waits_for_its_spawn():
    """Within the bound: while a newer start waits for the older attempt's spawn, a cancel of the
    older one answers only once that spawn is over and reaped."""
    made = []
    first = threading.Event()

    def slow_first(_service, _cancelled):
        if not first.is_set():
            first.set()
            time.sleep(0.8)
        proc, fd = _sleeper()
        made.append(proc)
        return proc, fd

    signins = SI.SignIns(slow_first)
    signins.start("codex", 1)
    newer = threading.Thread(target=signins.start, args=("codex", 2))
    newer.start()
    time.sleep(0.1)
    view = signins.cancel("codex", 1)
    assert view["state"] == "superseded"
    assert made and made[0].poll() is not None
    newer.join()
    signins.cancel_all()
    signins.join()


# ---------------------------------------------------------------------------------------------
# Descriptor custody (WP3.26): only an attempt's reader uses its pty, and only it closes it.


class _PauseAfterWaking:
    """Stands in for the ``select`` module in signin: once armed, the next sign-in reader that
    wakes with something ready pauses there, before it reads, until released. That is the window
    in which another thread ends the attempt (a cancel, a newer start, a sign-out)."""

    def __init__(self) -> None:
        self.armed = threading.Event()
        self.paused = threading.Event()
        self.release = threading.Event()

    def _woke(self, ready) -> None:
        if ready and self.armed.is_set() and threading.current_thread().name.startswith("sign-in-"):
            self.armed.clear()
            self.paused.set()
            self.release.wait(10)

    def select(self, rlist, wlist, xlist, timeout=None):
        result = select.select(rlist, wlist, xlist, timeout)
        self._woke(result[0])
        return result

    def poll(self):
        inner, woke = select.poll(), self._woke

        class Poll:
            register, unregister, modify = inner.register, inner.unregister, inner.modify

            def poll(self, timeout=None):
                events = inner.poll(timeout)
                woke(events)
                return events

        return Poll()

    def __getattr__(self, name: str):
        return getattr(select, name)


def test_an_ended_attempts_reader_never_touches_a_reused_descriptor(monkeypatch):
    """The race behind WP3.26. An attempt is ended by another thread while its reader is between
    waking and reading. Its descriptor must not be closed under the reader: the free number goes
    to the next open (here a pipe holding a canary, standing for another attempt's pty with its
    link and code), and the reader would read it or, with nothing there, block on it forever."""
    hook = _PauseAfterWaking()
    monkeypatch.setattr(SI, "select", hook)
    masters: list[int] = []

    def spawn(_service, _cancelled):
        proc, fd = _sleeper()
        masters.append(fd)
        return proc, fd

    signins = SI.SignIns(spawn)
    signins.start("claude", 1)
    _until(lambda: signins._current["claude"].fd is not None, what="the reader to start")
    fd = masters[0]
    hook.armed.set()
    assert signins.cancel("claude", 1)["state"] == "cancelled"
    assert hook.paused.wait(5), "the reader did not wake when its attempt ended"
    try:
        os.fstat(fd)
        closed_under_reader = False
    except OSError:
        closed_under_reader = True
    stolen = False
    if closed_under_reader:
        # What the next open anywhere in the process does: take the free number (often the
        # pipe's own read end already is that number; the read end is put there either way).
        r, w = os.pipe()
        if w == fd:
            w = os.dup(w)
        if r != fd:
            os.dup2(r, fd)
            os.close(r)
        os.write(w, b"SYNTHETIC-CANARY")
    hook.release.set()
    signins.join()
    reader_alive = any(t.is_alive() for t in signins._threads)
    if closed_under_reader:
        os.set_blocking(fd, False)
        try:
            stolen = os.read(fd, 64) != b"SYNTHETIC-CANARY"
        except BlockingIOError:
            stolen = True
        os.close(fd)
        os.close(w)
    assert not closed_under_reader, "the descriptor was closed while its reader could use it"
    assert not stolen and not reader_alive
    # Once the reader has stopped, it closed what it owned.
    assert signins._current["claude"].fd is None and signins._current["claude"].wake is None
    with pytest.raises(OSError):
        os.fstat(fd)


# A stand-in CLI for the churn: prints a valid link and prompt, then says every code it is
# given is incomplete (Claude), or waits (Codex). It never prints anything secret.
_CHURN_CLI = (
    "stty -echo 2>/dev/null; printf '%s' \"$1\"; "
    "while IFS= read -r line; do "
    "printf '%s\\r\\n' 'Invalid code. Please make sure the full code was copied.'; "
    "done; sleep 60"
)
_CHURN_PROMPT = {
    "claude": "https://claude.com/cai/oauth/authorize?state=synthetic\r\n"
    "Paste code here if prompted > ",
    "codex": "Open this link in your browser\r\nhttps://auth.openai.com/codex/device\r\n"
    "Enter this one-time code\r\nSYNT-H0000\r\n",
}


def _ptys_open() -> int:
    count = 0
    for name in os.listdir("/proc/self/fd"):
        with contextlib.suppress(OSError):
            count += os.readlink(f"/proc/self/fd/{name}") == "/dev/ptmx"
    return count


def test_churning_attempts_never_cross_descriptors():
    """Regression guard, under a time budget: attempts of both services started, superseded,
    cancelled, written to and signed out from several threads at once, while other threads keep
    opening pipes (which take freed numbers) and check their own data. No pipe's data is ever
    taken, every reader stops, every process is reaped and no pty is left open."""
    procs: list[subprocess.Popen[bytes]] = []
    procs_lock = threading.Lock()

    def spawn(service, _cancelled):
        master, slave = os.openpty()
        proc = subprocess.Popen(
            ["sh", "-c", _CHURN_CLI, "sh", _CHURN_PROMPT[service]],
            stdin=slave,
            stdout=slave,
            stderr=slave,
            start_new_session=True,
        )
        os.close(slave)
        with procs_lock:
            procs.append(proc)
        return proc, master

    baseline = _ptys_open()
    signins = SI.SignIns(spawn)
    stop = threading.Event()
    problems: list[str] = []
    numbers = {"claude": 0, "codex": 0}
    numbers_lock = threading.Lock()

    def tab(service: str) -> None:
        rng = random.Random(service)
        while not stop.is_set():
            with numbers_lock:
                numbers[service] += 1
                n = numbers[service]
            signins.start(service, n)
            time.sleep(rng.uniform(0, 0.03))
            action = rng.random()
            with contextlib.suppress(SI.SignInUnsettled):
                if action < 0.4:
                    signins.cancel(service, n)
                elif action < 0.5:
                    signins.cancel(service, n + 1)  # a cancel ahead of its start
            signins.status(service, n)

    def writer() -> None:
        while not stop.is_set():
            current = signins._current["claude"]
            if current is not None:
                with contextlib.suppress(SI.SignInConflict):
                    signins.write("claude", current.number, "SYNTHETIC#incomplete")
            time.sleep(0.005)

    def sign_outs() -> None:
        while not stop.wait(0.15):
            signins.cancel_all()

    def victim(index: int) -> None:
        token = f"SYNTHETIC-PIPE-{index}".encode()
        while not stop.is_set():
            r, w = os.pipe()
            try:
                os.set_blocking(r, False)
                os.write(w, token)
                time.sleep(0.001)
                try:
                    got = os.read(r, 64)
                except BlockingIOError:
                    got = b""
                if got != token:
                    problems.append(f"a pipe lost its data: {got!r}")
            finally:
                os.close(r)
                os.close(w)

    workers = [
        threading.Thread(target=tab, args=("claude",)),
        threading.Thread(target=tab, args=("codex",)),
        threading.Thread(target=writer),
        threading.Thread(target=sign_outs),
        *(threading.Thread(target=victim, args=(i,)) for i in range(3)),
    ]
    for worker in workers:
        worker.start()
    time.sleep(3.0)
    stop.set()
    for worker in workers:
        worker.join(30)
        assert not worker.is_alive(), "a churn thread did not finish"
    _until(signins.cancel_all, timeout=30, what="every attempt to be settled")
    signins.join()
    assert not [t for t in signins._threads if t.is_alive()], "a reader did not stop"
    assert not problems, problems[:3]
    assert len(procs) > 10, "the churn started too few attempts to mean anything"
    for proc in procs:
        assert proc.returncode is not None, "a process was not reaped"
        assert _group_gone(proc.pid)
    for service in SI.SERVICES:
        current = signins._current[service]
        assert current is None or (current.fd is None and getattr(current, "wake", None) is None)
    assert _ptys_open() == baseline, "a pty was left open"


def test_a_process_not_reaped_in_time_stays_owed(monkeypatch):
    """A killed process that is not reaped within the bound (a process stuck in the kernel) is
    never reported as gone: cancels and sign-outs fail retryably until a settle reaps it."""
    monkeypatch.setattr(SI, "REAP_S", 0.1)
    stuck = threading.Event()
    stuck.set()

    class SlowToReap(subprocess.Popen):
        def wait(self, timeout=None):
            if stuck.is_set():
                raise subprocess.TimeoutExpired(self.args, timeout)
            return super().wait(timeout)

    def spawn(_service, _cancelled):
        master, slave = os.openpty()
        proc = SlowToReap(
            ["sleep", "60"], stdin=slave, stdout=slave, stderr=slave, start_new_session=True
        )
        os.close(slave)
        return proc, master

    signins = SI.SignIns(spawn)
    signins.start("codex", 1)
    _until(lambda: signins._current["codex"].fd is not None, what="the reader to start")
    pid = signins._current["codex"].proc.pid
    with pytest.raises(SI.SignInUnsettled):
        signins.cancel("codex", 1)
    assert signins.cancel_all() is False
    stuck.clear()
    assert signins.cancel("codex", 1)["state"] == "cancelled"
    assert signins.cancel_all() is True
    assert _group_gone(pid)
    signins.join()


def test_a_code_the_cli_cannot_take_fails_the_attempt():
    """The pty is non-blocking: a code that cannot be written whole (the CLI's input is full, or
    the CLI is gone) fails the attempt at once instead of waiting under the lock."""
    signins = SI.SignIns(lambda s, c: (_ for _ in ()).throw(OSError()))
    r, w = os.pipe()
    try:
        os.set_blocking(w, False)
        with contextlib.suppress(BlockingIOError):
            while True:
                os.write(w, b"x" * 4096)
        attempt = SI.Attempt("claude", 1, state="awaiting_user", url="https://claude.com/x")
        attempt.fd = w
        attempt.spawned.set()
        signins._current["claude"] = attempt
        view = signins.write("claude", 1, "SYNTHETIC#code")
        assert view == {
            "service": "claude",
            "attempt": 1,
            "state": "failed",
            "reason": "cli_exited",
        }
    finally:
        os.close(r)
        os.close(w)


def test_output_beyond_its_bound_is_unexpected():
    attempt = SI.Attempt("codex", 1, started=0.0, deadline=100.0)
    attempt.out += b"x" * (SI.MAX_OUTPUT_BYTES + 1)
    signins = SI.SignIns(lambda s, c: (_ for _ in ()).throw(OSError()), clock=lambda: 1.0)
    with signins._lock:
        assert signins._step(attempt, exited=False)
    assert attempt.view()["reason"] == "unexpected_output"


def test_only_claude_takes_a_code_and_never_a_control_character():
    signins = SI.SignIns(lambda s, c: (_ for _ in ()).throw(OSError()))
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
