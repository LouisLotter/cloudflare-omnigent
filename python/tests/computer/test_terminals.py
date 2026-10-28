"""The setup terminal's sessions on the computer (WP3.28, FH-38): the wrapper ttyd runs, and the
supervisor's ending of sessions (``terminals.py``) and its backstops.

The wrapper's argument check and the supervisor's paths run here, without root. Where tmux is
installed, the session manager also runs against a real tmux server on a socket of the test's
own; the image's suite (``images/computer/tests/test_terminal_sessions.py``) runs the whole
chain as root with the real ttyd, tmux and the person's account.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import threading
import time
from pathlib import Path
from typing import Any

import pytest
from cfo_computer import main as M
from cfo_computer import procs as P
from cfo_computer import terminal_shell as TS
from cfo_computer import terminals as T
from harness import Rig
from hypothesis import given
from hypothesis import strategies as st

# ---------------------------------------------------------------------------------------------
# The wrapper's arguments: only WorkspaceDO's two forms.


@pytest.mark.parametrize(
    ("argv", "parsed"),
    [
        (["new", "1"], ("new", 1)),
        (["attach", "42"], ("attach", 42)),
        (["new", "999999999"], ("new", 999_999_999)),
        (["new", "0"], None),
        (["new", "01"], None),
        (["new", "1000000000"], None),
        (["new", "-1"], None),
        (["new", "1 "], None),
        (["new", "1\n"], None),
        (["new", "w1"], None),
        (["kill", "1"], None),
        (["NEW", "1"], None),
        (["new"], None),
        (["new", "1", "x"], None),
        (["new", "1", "-c", "x"], None),
        (["attach", "=w1"], None),
        (["attach", "１"], None),
    ],
)
def test_the_wrapper_takes_only_a_mode_and_a_window(argv: list[str], parsed: object) -> None:
    assert TS.parse(argv) == parsed


@given(st.lists(st.text(max_size=12), max_size=4))
def test_anything_else_is_refused(argv: list[str]) -> None:
    parsed = TS.parse(argv)
    if parsed is not None:
        mode, window = parsed
        assert argv == [mode, str(window)] and mode in ("new", "attach")
        assert 1 <= window <= 999_999_999


def test_a_refused_call_runs_nothing(capsys: pytest.CaptureFixture[str]) -> None:
    assert TS.main(["sh", "-c", "id"]) == TS.USAGE
    assert "refused" in capsys.readouterr().err


def test_ttyd_runs_the_wrapper_with_the_url_arguments() -> None:
    argv = M.terminal_argv()
    assert argv[:7] == [
        "/usr/local/bin/ttyd",
        "--port",
        "7681",
        "--writable",
        "--max-clients",
        "1",
        "--url-arg",
    ]
    assert argv[7:] == ["/usr/local/bin/python3", "-I", "-m", "cfo_computer.terminal_shell"]
    assert TS.CONFIG.exists() and TS.CONFIG.name == "terminal-tmux.conf"


def test_the_tmux_configuration_leaves_the_person_nothing_to_get_stuck_in() -> None:
    lines = {line.strip() for line in TS.CONFIG.read_text().splitlines()}
    for line in (
        "set -g prefix None",
        "set -g prefix2 None",
        "unbind-key -a",
        "set -g status off",
        "set -g mouse off",
        "set -s escape-time 0",
    ):
        assert line in lines


def test_the_socket_is_the_persons_own() -> None:
    assert TS.socket_path(1000) == Path("/tmp/tmux-1000/cfo-terminal")
    assert T._names_socket(["tmux", "-L", "cfo-terminal", "new-session"], TS.socket_path(1000))
    assert T._names_socket(["tmux", "-S", "/x/y", "ls"], Path("/x/y"))
    assert not T._names_socket(["tmux", "-L", "default", "ls"], TS.socket_path(1000))
    assert not T._names_socket(["tmux", "new-session"], TS.socket_path(1000))


def test_tmux_processes_have_their_own_kind() -> None:
    def proc(comm: str, *argv: str) -> P.Proc:
        return P.Proc(10, 1, "S", comm, 1, 1000, list(argv))

    assert P.kind(proc("tmux: server", "/usr/bin/tmux", "-L", "cfo-terminal", "new-session")) == (
        "terminal-session"
    )
    assert P.kind(proc("tmux: server", "tmux", "new-session")) == "tmux"
    # Not the supervisor, though their command lines name its package (the pause evidence).
    config = "/usr/local/lib/python3.12/site-packages/cfo_computer/terminal-tmux.conf"
    server = proc(
        "tmux: server", "/usr/bin/tmux", "-L", "cfo-terminal", "-f", config, "new-session"
    )
    assert P.kind(server) == "terminal-session"
    ttyd = proc(
        "ttyd", "/usr/local/bin/ttyd", "--url-arg", "python3", "-m", "cfo_computer.terminal_shell"
    )
    assert P.kind(ttyd) == "terminal"
    wrapper = proc("python3", "/usr/local/bin/python3", "-I", "-m", "cfo_computer.terminal_shell")
    assert P.kind(wrapper) == "terminal-session"
    assert P.kind(proc("python3", "python3", "-m", "cfo_computer.main")) == "supervisor"


# ---------------------------------------------------------------------------------------------
# The session manager, against a scripted tmux.


class FakeTmux:
    """Answers the session manager's tmux commands from a table of sessions."""

    def __init__(self) -> None:
        self.sessions: dict[str, tuple[int, int]] = {}
        self.calls: list[list[str]] = []
        self.hang = False
        self.server = True

    def __call__(self, argv: list[str], **_: Any) -> subprocess.CompletedProcess[str]:
        args = argv[3:]
        self.calls.append(args)
        if self.hang:
            raise subprocess.TimeoutExpired(argv, 5)
        if not self.server:
            return subprocess.CompletedProcess(argv, 1, "", "no server running")
        if args[0] == "list-sessions":
            out = "".join(f"{n} {c} {a}\n" for n, (c, a) in self.sessions.items())
            return subprocess.CompletedProcess(argv, 0, out + "garbage line\n", "")
        if args[0] == "kill-session":
            self.sessions.pop(args[2].removeprefix("="), None)
        if args[0] == "kill-server":
            self.sessions.clear()
        return subprocess.CompletedProcess(argv, 0, "", "")


@pytest.fixture
def fake(tmp_path: Path) -> tuple[T.TerminalSessions, FakeTmux, list[float]]:
    sock = tmp_path / "cfo-terminal"
    sock.touch()
    tmux = FakeTmux()
    clock = [1_000_000.0]
    sessions = T.TerminalSessions(
        uid=os.getuid(),
        socket=sock,
        run=tmux,
        clock=lambda: clock[0],
        monotonic=lambda: clock[0],
    )
    return sessions, tmux, clock


def test_end_kills_the_windows_up_to_its_own_and_strays(fake) -> None:
    sessions, tmux, clock = fake
    tmux.sessions = {"w1": (int(clock[0]), 0), "w2": (int(clock[0]), 1), "w3": (0, 1), "x": (0, 0)}
    assert sessions.end(2) == 1
    assert list(tmux.sessions) == ["w3"]


def test_the_reaper_ends_a_session_left_without_a_stream_for_45_seconds(fake) -> None:
    sessions, tmux, clock = fake
    assert (sessions.idle_s, sessions.max_age_s) == (45.0, 1800.0)
    now = int(clock[0])
    tmux.sessions = {"w1": (now, 0), "w2": (now, 1)}
    assert sessions.reap() == []
    clock[0] += 30
    tmux.sessions["w1"] = (now, 1)  # a reconnect attached in time: the clock starts again
    assert sessions.reap() == []
    tmux.sessions["w1"] = (now, 0)
    clock[0] += 44
    assert sessions.reap() == []
    clock[0] += 1
    assert sessions.reap() == []
    clock[0] += 44
    assert sessions.reap() == ["w1"]
    assert list(tmux.sessions) == ["w2"]


def test_the_reaper_ends_any_session_30_minutes_after_it_started(fake) -> None:
    sessions, tmux, clock = fake
    tmux.sessions = {"w7": (int(clock[0]), 1)}
    clock[0] += 1799
    assert sessions.reap() == []
    clock[0] += 1
    assert sessions.reap() == ["w7"]


def test_a_session_replaced_under_the_same_name_starts_its_own_idle_clock(fake) -> None:
    sessions, tmux, clock = fake
    tmux.sessions = {"w1": (int(clock[0]), 0)}
    sessions.reap()
    clock[0] += 40
    tmux.sessions = {"w1": (int(clock[0]), 0)}
    assert sessions.reap() == []
    clock[0] += 10
    assert sessions.reap() == []


def test_a_server_that_does_not_answer_is_reported_not_guessed(fake) -> None:
    sessions, tmux, _ = fake
    tmux.hang = True
    with pytest.raises(T.NotAnswering):
        sessions.sessions()
    with pytest.raises(T.NotAnswering):
        sessions.end(1)
    assert sessions.count() is None
    sessions.end_all()  # never raises


def test_no_server_means_no_sessions(fake, tmp_path: Path) -> None:
    sessions, tmux, _ = fake
    tmux.server = False
    assert sessions.sessions() == [] and sessions.count() == 0
    gone = T.TerminalSessions(uid=os.getuid(), socket=tmp_path / "none", run=tmux)
    before = len(tmux.calls)
    assert gone.sessions() == [] and gone.end(5) == 0
    gone.end_all()
    assert len(tmux.calls) == before  # no socket: tmux is never asked


def test_tmux_runs_as_the_account_with_a_bare_environment(tmp_path: Path, monkeypatch) -> None:
    """As root, never a root client of the account's server; never the supervisor's variables."""
    sock = tmp_path / "s"
    sock.touch()
    seen: list[dict[str, Any]] = []

    def run(argv: list[str], **kwargs: Any) -> subprocess.CompletedProcess[str]:
        seen.append(kwargs)
        return subprocess.CompletedProcess(argv, 0, "", "")

    monkeypatch.setenv("CFO_SYNTHETIC_SUPERVISOR_ONLY", "x")
    sessions = T.TerminalSessions(uid=1000, gid=1001, socket=sock, run=run)
    monkeypatch.setattr(T.os, "geteuid", lambda: 0)
    sessions.sessions()
    assert seen[-1]["user"] == 1000 and seen[-1]["group"] == 1001
    assert seen[-1]["extra_groups"] == []
    assert seen[-1]["env"] == {"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"}
    monkeypatch.setattr(T.os, "geteuid", lambda: 1000)
    sessions.sessions()
    assert "user" not in seen[-1] and "CFO_SYNTHETIC_SUPERVISOR_ONLY" not in seen[-1]["env"]
    assert T.TerminalSessions(uid=7).gid == 7


# ---------------------------------------------------------------------------------------------
# A real tmux server on the test's own socket, where tmux is installed.

needs_tmux = pytest.mark.skipif(shutil.which("tmux") is None, reason="needs tmux")


def _start(sock: Path, name: str) -> None:
    subprocess.run(
        ["tmux", "-S", str(sock), "-f", "/dev/null", "new-session", "-d", "-s", name, "sleep 600"],
        check=True,
        timeout=10,
        env={k: v for k, v in os.environ.items() if not k.startswith("TMUX")},
    )


@needs_tmux
def test_a_real_server_lists_ends_and_reaps(tmp_path: Path) -> None:
    sock = tmp_path / "s"
    clock = [time.time()]
    sessions = T.TerminalSessions(
        uid=os.getuid(), socket=sock, tmux=shutil.which("tmux") or "tmux", idle_s=0.2
    )
    try:
        for name in ("w1", "w2", "w3"):
            _start(sock, name)
        names = sorted(s.name for s in sessions.sessions())
        assert names == ["w1", "w2", "w3"]
        assert all(s.attached == 0 and abs(s.created - clock[0]) < 60 for s in sessions.sessions())
        assert sessions.end(1) == 2
        assert sorted(s.name for s in sessions.sessions()) == ["w2", "w3"]
        assert sorted(sessions.reap()) == []  # first sight starts the idle clock
        time.sleep(0.3)
        assert sorted(sessions.reap()) == ["w2", "w3"]
        assert sessions.count() == 0
    finally:
        subprocess.run(["tmux", "-S", str(sock), "kill-server"], capture_output=True, check=False)


@needs_tmux
def test_end_all_kills_a_server_that_does_not_answer(tmp_path: Path) -> None:
    sock = tmp_path / "s"
    sessions = T.TerminalSessions(
        uid=os.getuid(), socket=sock, tmux=shutil.which("tmux") or "tmux", timeout_s=1.0
    )
    _start(sock, "w4")
    try:
        pids = sessions.server_pids()
        assert len(pids) == 1
        os.kill(pids[0], 19)  # SIGSTOP: as a capture's pause leaves it
        sessions.end_all()
        deadline = time.monotonic() + 5
        while sessions.server_pids() and time.monotonic() < deadline:
            time.sleep(0.05)
        assert sessions.server_pids() == []
    finally:
        for pid in sessions.server_pids():
            os.kill(pid, 9)


@needs_tmux
def test_end_all_kills_a_sessions_process_that_ignores_its_hang_up(tmp_path: Path) -> None:
    sock = tmp_path / "s"
    sessions = T.TerminalSessions(uid=os.getuid(), socket=sock, tmux=shutil.which("tmux") or "tmux")
    marker = f"cfo-wp328-hup-{os.getpid()}"
    subprocess.run(
        [
            "tmux",
            "-S",
            str(sock),
            "-f",
            "/dev/null",
            "new-session",
            "-d",
            "-s",
            "w1",
            f"bash -c 'trap \"\" HUP; exec -a {marker} sleep 600'",
        ],
        check=True,
        timeout=10,
        env={k: v for k, v in os.environ.items() if not k.startswith("TMUX")},
    )

    def stubborn() -> list[int]:
        return [p.pid for p in P.scan().values() if p.cmdline[:1] == [marker] and p.state != "Z"]

    try:
        end = time.monotonic() + 5
        while not stubborn() and time.monotonic() < end:
            time.sleep(0.05)
        assert len(stubborn()) == 1
        sessions.end_all()
        assert stubborn() == [] and sessions.server_pids() == []
    finally:
        for pid in stubborn():
            os.kill(pid, 9)
        subprocess.run(["tmux", "-S", str(sock), "kill-server"], capture_output=True, check=False)


# ---------------------------------------------------------------------------------------------
# The supervisor: `terminal_end`, the backstops, the reaper and the status.


class Recorder:
    def __init__(self) -> None:
        self.events: list[str] = []
        self.remaining = 0
        self.fail: Exception | None = None

    def end(self, window: int) -> int:
        if self.fail is not None:
            raise self.fail
        self.events.append(f"end {window}")
        return self.remaining

    def end_all(self) -> None:
        self.events.append("end_all")

    def count(self) -> int | None:
        return 2

    def reap(self) -> list[str]:
        self.events.append("reap")
        return ["w9"]


@pytest.fixture
def rig(tmp_path: Path):
    r = Rig(tmp_path / "rig")
    r.boot()
    recorder = Recorder()
    r.sup.terminals = recorder  # type: ignore[assignment]
    yield r, recorder
    r.close()


def test_terminal_end_ends_the_windows_sessions(rig) -> None:
    r, rec = rig
    rec.remaining = 1
    assert r.ok("terminal_end", window=4) == {"type": "terminal_end", "remaining": 1}
    assert rec.events == ["end 4"]


def test_terminal_end_is_idempotent_by_operation_id(rig) -> None:
    r, rec = rig
    command = r.command("terminal_end", window=2)
    assert r.post(command)[0] == 200
    assert r.post(command)[0] == 200
    assert rec.events == ["end 2"]
    assert r.post({**command, "window": 3})[0] == 409


def test_terminal_end_waits_while_a_capture_pauses_the_computer(rig) -> None:
    r, rec = rig
    r.sup.capture_running = True
    status, reply = r.send("terminal_end", window=1)
    assert status == 503 and reply["error"]["retryable"] is True
    r.sup.capture_running = False
    rec.fail = T.NotAnswering("list-sessions")
    status, reply = r.send("terminal_end", window=1)
    assert status == 503 and reply["error"]["retryable"] is True
    assert rec.events == []


def test_a_stops_final_capture_ends_every_session_before_the_pause(rig) -> None:
    r, rec = rig
    order: list[str] = []
    rec.end_all = lambda: order.append(f"end_all, capture running={r.sup.capture_running}")  # type: ignore[method-assign]
    status, reply = r.send(
        "capture",
        layerId="lyr_01hzy5b2c3d4e5f6g7h8j9k0m0",
        kind="base",
        parent=None,
        policyVersion=1,
        lease={"targetMs": 20000, "hardMs": 40000},
        endTerminals=True,
    )
    assert status == 200, reply
    assert r.wait_job(reply["job"]["jobOperationId"])["state"] == "staged"
    assert order == ["end_all, capture running=False"]
    op, _ = r.capture()  # an ordinary save leaves the terminal alone
    assert order == ["end_all, capture running=False"]


def test_the_credential_barrier_and_a_sign_out_end_every_session_first(rig) -> None:
    r, rec = rig
    r.ok("credential_snapshot")
    assert rec.events == ["end_all"]
    first: list[str] = []
    original = r.sup.signins.cancel_all
    r.sup.signins.cancel_all = lambda: (first.append(str(rec.events[-1:])), original())[1]  # type: ignore[method-assign]
    r.ok("sign_out")
    assert rec.events == ["end_all", "end_all"] and first == ["['end_all']"]


def test_a_page_sign_in_ends_every_session_before_its_cli_starts(rig) -> None:
    r, rec = rig
    spawned = threading.Event()

    def spawn(*_a: Any, **_k: Any):
        assert rec.events == ["end_all"]
        spawned.set()
        raise OSError("not in this test")

    import cfo_computer.supervisor as SV

    original = SV.spawn_login
    SV.spawn_login = spawn  # type: ignore[assignment]
    try:
        r.ok("sign_in_start", service="codex", attempt=1)
        assert spawned.wait(10)
        # A repeat of the same start spawns nothing and ends nothing again.
        r.ok("sign_in_start", service="codex", attempt=1)
        time.sleep(0.2)
        assert rec.events == ["end_all"]
    finally:
        SV.spawn_login = original


def test_the_status_counts_the_sessions_and_hello_names_the_feature(rig) -> None:
    r, _ = rig
    assert r.ok("computer_status")["status"]["terminals"] == 2
    r.sup.capture_running = True
    assert "terminals" not in r.ok("computer_status")["status"]
    r.sup.capture_running = False
    from cfo_computer import SUPERVISOR_FEATURES

    assert "terminal_sessions" in SUPERVISOR_FEATURES


def test_the_reaper_runs_beside_the_supervisor_and_skips_a_capture(rig, monkeypatch) -> None:
    r, rec = rig
    import cfo_computer.supervisor as SV

    monkeypatch.setattr(SV, "REAP_INTERVAL_S", 0.02)
    r.sup._capture_gate.acquire()
    thread = threading.Thread(target=r.sup._terminal_loop, daemon=True)
    thread.start()
    time.sleep(0.2)
    assert "reap" not in rec.events
    r.sup._capture_gate.release()
    deadline = time.monotonic() + 5
    while "reap" not in rec.events and time.monotonic() < deadline:
        time.sleep(0.02)
    assert "reap" in rec.events
    r.sup._stop.set()
    thread.join(5)


def test_a_failure_to_end_sessions_refuses_the_step_it_guards(rig) -> None:
    """Unconfirmed, the backstop holds the step back (retryable), before any effect (Codex r1-3)."""
    r, rec = rig

    def broken() -> None:
        raise T.NotEnded

    rec.end_all = broken  # type: ignore[method-assign]
    order = r.sup.creds.order
    status, reply = r.send("credential_snapshot")
    assert status == 503 and reply["error"]["code"] == "unavailable" and reply["error"]["retryable"]
    assert r.sup.creds.order == order  # no snapshot taken
    cancels: list[str] = []
    original = r.sup.signins.cancel_all
    r.sup.signins.cancel_all = lambda: (cancels.append("x"), original())[1]  # type: ignore[method-assign]
    status, reply = r.send("sign_out")
    assert status == 503 and reply["error"]["retryable"] and cancels == []
    capture = {
        "layerId": "lyr_01hzy5b2c3d4e5f6g7h8j9k0m0",
        "kind": "base",
        "parent": None,
        "policyVersion": 1,
        "lease": {"targetMs": 20000, "hardMs": 40000},
        "endTerminals": True,
    }
    command = r.command("capture", **capture)
    status, reply = r.post(command)
    assert status == 503 and reply["error"]["retryable"]
    assert not r.sup.capture_running
    assert r.sup._capture_gate.acquire(blocking=False)  # given back
    r.sup._capture_gate.release()
    assert r.sup.alert_counts.get("other", 0) >= 3
    # Once the sessions can be ended, the same operations run.
    rec.end_all = lambda: rec.events.append("end_all")  # type: ignore[method-assign]
    status, reply = r.post(command)
    assert status == 200, reply
    assert r.wait_job(reply["job"]["jobOperationId"])["state"] == "staged"
    assert r.ok("credential_snapshot")["type"] == "credential_snapshot"


def test_a_page_sign_in_fails_to_start_when_the_sessions_cannot_be_ended(rig) -> None:
    r, rec = rig

    def broken() -> None:
        raise T.NotEnded

    rec.end_all = broken  # type: ignore[method-assign]
    import cfo_computer.supervisor as SV

    spawned: list[str] = []
    original = SV.spawn_login
    SV.spawn_login = lambda *a, **k: spawned.append("x")  # type: ignore[assignment]
    try:
        r.ok("sign_in_start", service="codex", attempt=1)
        deadline = time.monotonic() + 10
        view: dict[str, Any] = {}
        while time.monotonic() < deadline:
            view = r.ok("sign_in_status", service="codex", attempt=1)["view"]
            if view["state"] == "failed":
                break
            time.sleep(0.05)
        assert view == {
            "service": "codex",
            "attempt": 1,
            "state": "failed",
            "reason": "start_failed",
        }
        assert spawned == []
    finally:
        SV.spawn_login = original


def test_end_all_confirms_every_process_gone_or_says_so(fake, monkeypatch) -> None:
    sessions, tmux, _ = fake
    sessions.end_all()  # nothing on the socket: confirmed at once

    # A tmux client that cannot even start (no descriptors left) still leaves the signals.
    def no_client(argv: list[str], **_: Any) -> subprocess.CompletedProcess[str]:
        raise OSError(24, "Too many open files")

    sessions._run = no_client  # type: ignore[assignment]
    sessions.end_all()
    # A server on the socket that survives every signal: not confirmed.
    monkeypatch.setattr(sessions, "server_pids", lambda: [999_999])
    with pytest.raises(T.NotEnded):
        sessions.end_all()
