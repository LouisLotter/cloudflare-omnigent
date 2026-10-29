"""The setup terminal's shells on the computer, inside the image (WP3.28, FH-38).

The real ttyd 1.7.7 with the image's command line (``main.terminal_argv``), started by the
supervisor as the person's account, the real tmux and the wrapper ``terminal_shell.py``, reached
over a WebSocket as WorkspaceDO's bridge reaches it (``ttyd_client.py``):

- a reconnect after the bridge's connection is cut prints the same ``$$``;
- ``attach`` to a session that does not exist ends the stream and starts nothing, and nothing
  but WorkspaceDO's two forms starts a session; an older WorkspaceDO's dial gets a plain shell;
- ``new`` for the next window ends the previous window's session;
- the supervisor's backstops each leave no session: ``terminal_end``, a sign-out, a stop's final
  capture, the credential barrier, a sign-in from the page, the 45-second reaper with its real
  timing, and the 30-minute cap (shortened);
- the capture freezer pauses the tmux server and the shell in it (the cgroup freezer here; the
  container suite checks the SIGSTOP freezer under tini).
"""

from __future__ import annotations

import contextlib
import os
import socket
import subprocess
import threading
import time
from pathlib import Path

import pytest
from harness import FAKES, Rig, new_id
from ttyd_client import Closed, TtydClient, shell_pid

from cfo_computer import procs as P
from cfo_computer.main import terminal_argv
from cfo_computer.paths import Account
from cfo_computer.supervisor import Tools
from cfo_computer.terminals import TerminalSessions

UID = 1000


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _home(tmp_path: Path) -> Path:
    home = tmp_path / "home"
    home.mkdir(parents=True)
    os.chown(home, UID, UID)
    for parent in home.parents:  # pytest makes its directories 0700; the account must reach home
        if parent == Path("/"):
            break
        parent.chmod(parent.stat().st_mode | 0o011)
    return home


def _wait(predicate, timeout: float = 20.0, what: str = "the condition") -> None:
    end = time.monotonic() + timeout
    while not predicate():
        if time.monotonic() > end:
            raise AssertionError(f"timed out waiting for {what}")
        time.sleep(0.05)


def _listening(port: int) -> bool:
    with contextlib.suppress(OSError), socket.create_connection(("127.0.0.1", port), timeout=0.2):
        return True
    return False


class Computer:
    """A supervisor with the real ttyd, started as on a computer once both restores are done."""

    def __init__(self, tmp_path: Path, *, cgroup_dir: str | None = None) -> None:
        self.port = _free_port()
        tools = Tools(
            claude=str(FAKES / "claude"),
            codex=str(FAKES / "codex"),
            terminal=terminal_argv(self.port),
        )
        home = _home(tmp_path)
        self.rig = Rig(tmp_path / "rig", tools=tools, cgroup_dir=cgroup_dir, terminal_socket=None)
        self.rig.sup.account = Account("omnigent", UID, UID, home)
        self.rig.sup.terminals = TerminalSessions(uid=UID)
        self.sessions = self.rig.sup.terminals
        self.sessions.end_all()
        self.rig.boot()  # the install starts ttyd
        _wait(lambda: _listening(self.port), what="ttyd")

    def connect(self, *args: str, retries: float = 10.0) -> TtydClient:
        """A stream; ttyd takes one client at a time, so a new one may wait for an old one."""
        end = time.monotonic() + retries
        while True:
            try:
                return TtydClient(self.port, list(args))
            except (Closed, OSError):
                if time.monotonic() > end:
                    raise
                time.sleep(0.1)

    def names(self) -> list[str]:
        return sorted(s.name for s in self.sessions.sessions())

    def close(self) -> None:
        try:
            self.sessions.end_all()
        finally:
            self.rig.close()


@pytest.fixture
def computer(tmp_path: Path):
    c = Computer(tmp_path)
    yield c
    c.close()


def test_a_reconnect_after_the_bridge_drops_prints_the_same_shell(computer: Computer) -> None:
    first = computer.connect("new", "1")
    pid = shell_pid(first, "one")
    assert computer.names() == ["w1"]
    first.drop()  # no close frame: as a Durable Object reset leaves it
    _wait(lambda: computer.sessions.sessions()[0].attached == 0, what="the detach")
    again = computer.connect("attach", "1")
    assert shell_pid(again, "two") == pid
    assert P.read_proc(pid) is not None and P.read_proc(pid).uid == UID
    again.close()


def test_the_shell_is_a_login_shell_in_tmux_with_nothing_to_get_stuck_in(
    computer: Computer,
) -> None:
    client = computer.connect("new", "1")
    shell_pid(client, "x")
    client.type("shopt -q login_shell && echo LOGIN-$((40+2)); echo TERM-$TERM\r")
    client.wait_for(b"LOGIN-42")
    client.wait_for(b"TERM-tmux-256color")
    # No alternate screen: what scrolls off stays in the browser terminal's own scrollback.
    assert b"\x1b[?1049h" not in client.output and b"\x1b[?47h" not in client.output
    client.type("\x02d")  # Ctrl-b d: tmux's default prefix and detach, which must not apply
    time.sleep(0.5)
    assert computer.sessions.sessions()[0].attached == 1
    client.type("\x15exit\r")  # Ctrl-u clears the line; the shell's exit ends the stream
    assert client.wait_closed() == 1000
    assert computer.names() == []


def test_attach_without_a_session_ends_the_stream_and_starts_nothing(
    computer: Computer,
) -> None:
    client = computer.connect("attach", "5")
    # A normal close (1000): the bridge tells the page the session ended, and it does not
    # reconnect. ttyd would close with 1006 for a non-zero exit (Codex r2-2).
    assert client.wait_closed() == 1000
    assert computer.names() == []
    first = computer.connect("new", "12")
    shell_pid(first, "a")
    first.close()
    # An exact match only: w1 is not w12.
    client = computer.connect("attach", "1")
    assert client.wait_closed() == 1000
    assert computer.names() == ["w12"]


@pytest.mark.parametrize(
    "args",
    [
        ["new", "0"],
        ["new", "1;id"],
        ["new", "1", "x"],
        ["attach", "=w1"],
        ["kill-server", "1"],
        ["new", "-c", "id"],
        ["attach", "1&arg=2"],
    ],
)
def test_nothing_but_workspacedos_two_forms_starts_a_session(
    computer: Computer, args: list[str]
) -> None:
    client = computer.connect(*args)
    assert client.wait_closed() == 1000
    assert b"uid=" not in client.output
    assert computer.names() == []


def test_an_older_workspacedos_dial_gets_a_plain_shell_that_ends_with_its_stream(
    computer: Computer,
) -> None:
    client = computer.connect()
    pid = shell_pid(client, "old")
    assert computer.names() == []
    client.drop()
    _wait(lambda: P.read_proc(pid) is None or P.read_proc(pid).state == "Z", what="the hang-up")


def test_new_for_the_next_window_ends_the_previous_ones(computer: Computer) -> None:
    one = computer.connect("new", "1")
    old = shell_pid(one, "one")
    one.drop()
    two = computer.connect("new", "2")
    new = shell_pid(two, "two")
    assert new != old
    assert computer.names() == ["w2"]
    two.close()


def test_the_supervisors_tmux_commands_run_as_the_account(computer: Computer) -> None:
    """Root (the supervisor) never speaks tmux's protocol to the account's server."""
    _with_session(computer)
    seen: list[int] = []
    real = computer.sessions._run

    def run(argv, **kwargs):
        done = real(["/bin/sh", "-c", 'id -u; exec "$@"', "sh", *argv], **{**kwargs, "text": True})
        seen.append(int(done.stdout.split("\n", 1)[0]))
        rest = done.stdout.split("\n", 1)[1] if "\n" in done.stdout else ""
        return subprocess.CompletedProcess(argv, done.returncode, rest, done.stderr)

    computer.sessions._run = run
    try:
        assert computer.names() == ["w1"]
        assert computer.rig.ok("terminal_end", window=1)["remaining"] == 0
    finally:
        computer.sessions._run = real
    assert seen and set(seen) == {UID}


# ---------------------------------------------------------------------------------------------
# The supervisor's backstops.


def _with_session(computer: Computer, window: str = "1") -> int:
    client = computer.connect("new", window)
    pid = shell_pid(client, "s")
    client.drop()
    return pid


def test_terminal_end_ends_the_windows_up_to_its_own(computer: Computer) -> None:
    _with_session(computer, "3")
    assert computer.rig.ok("terminal_end", window=2) == {"type": "terminal_end", "remaining": 1}
    assert computer.names() == ["w3"]
    assert computer.rig.ok("terminal_end", window=3) == {"type": "terminal_end", "remaining": 0}
    assert computer.names() == []


def test_a_sign_out_ends_every_session_first(computer: Computer) -> None:
    _with_session(computer)
    computer.rig.ok("sign_out")
    assert computer.names() == []


def test_the_credential_barrier_ends_every_session_first(computer: Computer) -> None:
    _with_session(computer)
    computer.rig.ok("credential_snapshot")
    assert computer.names() == []


def test_a_stops_final_capture_ends_every_session_and_a_save_does_not(computer: Computer) -> None:
    _with_session(computer)
    op, job = computer.rig.capture()
    assert job["state"] == "staged"
    assert computer.names() == ["w1"]
    computer.rig.finish(op)
    status, reply = computer.rig.send(
        "capture",
        layerId=new_id("lyr"),
        kind="base",
        parent=None,
        policyVersion=1,
        lease={"targetMs": 20000, "hardMs": 40000},
        endTerminals=True,
    )
    assert status == 200, reply
    computer.rig.wait_job(reply["job"]["jobOperationId"])
    assert computer.names() == []


def test_a_sign_in_from_the_page_ends_every_session_before_its_cli_starts(
    computer: Computer,
) -> None:
    _with_session(computer)
    computer.rig.ok("sign_in_start", service="codex", attempt=1)
    _wait(lambda: computer.names() == [], what="the session's end")
    computer.rig.ok("sign_in_cancel", service="codex", attempt=1)


def test_the_status_counts_the_sessions(computer: Computer) -> None:
    assert computer.rig.ok("computer_status")["status"]["terminals"] == 0
    _with_session(computer)
    assert computer.rig.ok("computer_status")["status"]["terminals"] == 1


def test_the_reaper_ends_a_session_left_without_a_stream_for_45_seconds(
    computer: Computer,
) -> None:
    """The production timing, through the supervisor's own loop."""
    assert (computer.sessions.idle_s, computer.sessions.max_age_s) == (45.0, 1800.0)
    attached = computer.connect("new", "1")
    shell_pid(attached, "a")
    loop = threading.Thread(target=computer.rig.sup._terminal_loop, daemon=True)
    loop.start()
    try:
        # Attached: kept well past 45 s of its own life. The client answers ttyd's pings
        # meanwhile, as the bridge does; one that never answers is dropped after about 10 s.
        attached.pump(time.monotonic() + 12)
        assert computer.names() == ["w1"]
        attached.drop()
        dropped = time.monotonic()
        _wait(lambda: computer.names() == [], timeout=70, what="the reaper")
        waited = time.monotonic() - dropped
        # 45 s from the first look that saw it unattached; the reaper looks every 5 s.
        assert 44 <= waited <= 58, waited
    finally:
        computer.rig.sup._stop.set()
        loop.join(10)


def test_the_cap_ends_a_session_however_attached(computer: Computer) -> None:
    computer.sessions.max_age_s = 2.0
    client = computer.connect("new", "1")
    shell_pid(client, "a")
    assert computer.sessions.reap() == []
    time.sleep(2.2)
    assert computer.sessions.reap() == ["w1"]
    client.wait_closed()
    assert computer.names() == []


# ---------------------------------------------------------------------------------------------
# The capture freezer pauses tmux.

CGROUPS = Path("/sys/fs/cgroup")


def _cgroups_writable() -> bool:
    try:
        probe = CGROUPS / f"cfo-probe-{os.getpid()}"
        probe.mkdir()
        probe.rmdir()
        return True
    except OSError:
        return False


@pytest.mark.skipif(not _cgroups_writable(), reason="cgroupfs is not writable here")
def test_a_capture_pauses_the_tmux_server_and_the_shell_in_it(tmp_path: Path) -> None:
    group = CGROUPS / f"cfo-test-terminal-{os.getpid()}"
    group.mkdir()
    computer = None
    try:
        computer = Computer(tmp_path, cgroup_dir=str(group))
        client = computer.connect("new", "1")
        pid = shell_pid(client, "f")
        client.drop()
        servers = computer.sessions.server_pids()
        assert len(servers) == 1
        members = {int(x) for x in (group / "cgroup.procs").read_text().split()}
        assert {pid, servers[0]} <= members, "the server and its shell are workload"
        op, job = computer.rig.capture()
        assert job["state"] == "staged", job
        result = computer.rig.result(op)
        assert result["mechanism"] == "cgroup"
        # The frozen group's members, by kind: the tmux server and the shell in it.
        kinds = result["stoppedByKind"]
        assert kinds.get("terminal-session", 0) == 1, kinds
        assert kinds.get("other:bash", 0) >= 1, kinds
        assert (group / "cgroup.freeze").read_text().strip() == "0"
        # Resumed: the same shell answers again.
        again = computer.connect("attach", "1")
        assert shell_pid(again, "g") == pid
        again.close()
    finally:
        if computer is not None:
            computer.close()
            ttyd = computer.rig.sup.terminal
            if ttyd is not None:
                ttyd.wait(10)
        _wait(lambda: (group / "cgroup.procs").read_text().strip() == "", what="an empty group")
        group.rmdir()
