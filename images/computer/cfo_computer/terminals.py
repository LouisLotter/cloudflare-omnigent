"""The setup terminal's sessions on the computer, as the supervisor ends them (WP3.28).

Each terminal window's shell runs in its own tmux session (``terminal_shell.py``) on a tmux
server of its own (``-L cfo-terminal``, the person's account). The session outlives its stream, so
a reconnect after a dropped connection or a Durable Object reset finds the same shell (FH-38).
Every way a stream may stop for good must therefore end the session here, on the computer:

- WorkspaceDO's ``terminal_end``: the sessions of every window up to the one it names;
- the credential-sensitive steps, first: a sign-out, a stop's final capture or its credential
  barrier, and a sign-in from the page (``end_all``, which must confirm every session's process
  gone, or the step does not run);
- the reaper, which holds even if WorkspaceDO never comes back: a session with no stream
  attached for ``idle_s`` (45 s: the bridge's 30-second grace plus a margin), and any session
  older than ``max_age_s`` (30 minutes, the window's deadline).

The supervisor runs as root, but its tmux commands run as the person's account, the server's
owner: the socket's directory belongs to that account, and tmux's protocol lets a server have its
client run a command (``detach-client -E``), so a root client is never pointed at it. It never
reads what a session holds; it lists names, times and attached client counts, and kills.
``end_all`` does not depend on the server answering: whatever tmux server on this socket, or
process that was in a session, is still alive after ``kill-server`` is killed by signal (as
root).
"""

from __future__ import annotations

import contextlib
import os
import signal
import subprocess
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

from . import procs as P
from .terminal_shell import SESSION, socket_path

TMUX = "/usr/bin/tmux"
#: A session with no stream attached is ended after this (the bridge's grace is 30 s).
IDLE_S = 45.0
#: Any session is ended this long after it started (the window's deadline).
MAX_AGE_S = 30 * 60.0
#: How often the reaper looks.
REAP_INTERVAL_S = 5.0
#: How long one tmux command may take before the server counts as not answering.
TMUX_TIMEOUT_S = 5.0
#: How long a session's processes get after their hang-up before ``end_all`` kills them.
HANGUP_GRACE_S = 1.0
#: How long ``end_all`` keeps killing what it finds before it says it could not.
KILL_WAIT_S = 3.0
#: How long ``end_all`` must find nothing before it is done: a session that a wrapper started
#: just before its stream was closed is found too.
SETTLE_S = 0.3

Runner = Callable[..., subprocess.CompletedProcess[str]]


class NotAnswering(Exception):
    """The tmux server did not answer in time (a capture may have paused it)."""


class NotEnded(Exception):
    """A setup-terminal process outlived every attempt to end it."""


@dataclass(frozen=True)
class Session:
    name: str
    #: When tmux created it, in seconds since the epoch (tmux's own clock, the container's).
    created: int
    #: How many clients (streams through ttyd) are attached now.
    attached: int

    @property
    def window(self) -> int | None:
        return int(self.name[1:]) if SESSION.fullmatch(self.name) else None


class TerminalSessions:
    def __init__(
        self,
        *,
        uid: int,
        gid: int | None = None,
        socket: Path | None = None,
        tmux: str = TMUX,
        run: Runner = subprocess.run,
        clock: Callable[[], float] = time.time,
        monotonic: Callable[[], float] = time.monotonic,
        idle_s: float = IDLE_S,
        max_age_s: float = MAX_AGE_S,
        timeout_s: float = TMUX_TIMEOUT_S,
    ) -> None:
        self.uid = uid
        self.gid = uid if gid is None else gid
        self.socket = socket if socket is not None else socket_path(uid)
        self.tmux = tmux
        self._run = run
        self._clock = clock
        self._monotonic = monotonic
        self.idle_s = idle_s
        self.max_age_s = max_age_s
        self.timeout_s = timeout_s
        self._lock = threading.Lock()
        #: When the reaper first saw each session with nothing attached (monotonic).
        self._unattached: dict[tuple[str, int], float] = {}
        #: Processes an ``end_all`` could not end, looked for again by the next one.
        self._owed: set[tuple[int, int]] = set()

    # -- tmux --------------------------------------------------------------------------------

    def _as_account(self) -> dict[str, object]:
        """As root, tmux runs as the account (never a root client of the account's server)."""
        if os.geteuid() != 0 or self.uid == 0:
            return {}
        return {"user": self.uid, "group": self.gid, "extra_groups": []}

    def _tmux(self, *args: str) -> subprocess.CompletedProcess[str]:
        try:
            return self._run(
                [self.tmux, "-S", str(self.socket), *args],
                capture_output=True,
                text=True,
                timeout=self.timeout_s,
                check=False,
                stdin=subprocess.DEVNULL,
                env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"},
                **self._as_account(),
            )
        except subprocess.TimeoutExpired as exc:
            raise NotAnswering(args[0]) from exc

    def sessions(self) -> list[Session]:
        """The sessions alive now; none when no server runs. Raises NotAnswering."""
        if not os.path.exists(self.socket):
            return []
        done = self._tmux(
            "list-sessions", "-F", "#{session_name} #{session_created} #{session_attached}"
        )
        if done.returncode != 0:
            # "no server running" or "error connecting": a socket left by a server that died.
            return []
        out: list[Session] = []
        for line in done.stdout.splitlines():
            parts = line.split(" ")
            if len(parts) != 3 or not parts[1].isdigit() or not parts[2].isdigit():
                continue
            out.append(Session(parts[0], int(parts[1]), int(parts[2])))
        return out

    def count(self) -> int | None:
        """How many sessions are alive, or None if the server did not answer."""
        try:
            return len(self.sessions())
        except NotAnswering:
            return None

    def _kill(self, name: str) -> None:
        self._tmux("kill-session", "-t", f"={name}")

    # -- ending ------------------------------------------------------------------------------

    def end(self, window: int) -> int:
        """Ends the sessions of every window up to ``window``, and any session that is not a
        window's; returns how many remain. Raises NotAnswering."""
        with self._lock:
            for session in self.sessions():
                number = session.window
                if number is None or number <= window:
                    self._kill(session.name)
            return len(self.sessions())

    def end_all(self) -> None:
        """Ends every session and every process of one, whether or not the server answers, and
        confirms it: raises NotEnded (or the error that stopped it) otherwise, so the step it
        guards does not run (Codex WP3.28 r1-3, r2-1).

        A process of the terminal is a tmux server on this socket, anything below one, or any
        process whose environment says it runs in one of its panes (tmux's ``TMUX``, which a
        process keeps when its server's death, or a ``kill-session`` before this, orphaned it);
        plus any an earlier call could not end. ``kill-server`` first (each shell gets its
        hang-up), a short grace, then SIGKILL (checked by start time) for every process of the
        terminal found, again and again, until none has been found for ``SETTLE_S``: so a session
        that a wrapper was starting as this began is ended too. Code that deliberately hides from
        all of these (a changed environment and a new parent) is a rogue agent, which the
        security calibration accepts."""
        with self._lock:
            self._unattached.clear()
            targets = self._terminal(P.scan()) | self._owed
            # Nothing to settle when no server ran and nothing of the terminal was found.
            settle = SETTLE_S if targets or os.path.exists(self.socket) else 0.0
            if os.path.exists(self.socket):
                # Even a client that cannot start (no descriptors left) leaves the signals.
                with contextlib.suppress(NotAnswering, OSError):
                    self._tmux("kill-server")
            targets = _wait_gone(targets, HANGUP_GRACE_S)
            deadline = time.monotonic() + KILL_WAIT_S
            quiet: float | None = None
            while True:
                left = _alive(targets) | self._terminal(P.scan())
                now = time.monotonic()
                if not left:
                    if quiet is None:
                        quiet = now
                    if now - quiet >= settle:
                        break
                elif now >= deadline:
                    self._owed = left
                    raise NotEnded
                else:
                    quiet = None
                    for pid, start in left:
                        _kill(pid, start)
                    targets = left
                time.sleep(0.05)
            self._owed = set()

    def _terminal(self, procs: dict[int, P.Proc]) -> set[tuple[int, int]]:
        """The terminal's processes now (see ``end_all``), zombies left out."""
        servers = set(self._server_pids(procs))
        found = P.descendants(procs, servers) | {pid for pid in procs if _in_pane(pid, self.socket)}
        return {procs[pid].key for pid in found if pid in procs and procs[pid].state != "Z"}

    def server_pids(self) -> list[int]:
        """The tmux server processes of this socket, owned by the person's account."""
        return self._server_pids(P.scan())

    def _server_pids(self, procs: dict[int, P.Proc]) -> list[int]:
        """A pane's process between its fork and its exec looks the same as its server; only
        the outermost one counts."""
        found = {
            proc.pid: proc
            for proc in procs.values()
            if proc.uid == self.uid
            and proc.comm.startswith("tmux")
            and "server" in proc.comm
            and _names_socket(proc.cmdline, self.socket, proc.uid)
        }
        return sorted(pid for pid, proc in found.items() if proc.ppid not in found)

    def reap(self) -> list[str]:
        """One pass of the reaper; returns the sessions it ended. Raises NotAnswering."""
        now = self._clock()
        mono = self._monotonic()
        ended: list[str] = []
        with self._lock:
            sessions = self.sessions()
            alive = {(s.name, s.created) for s in sessions}
            for key in [k for k in self._unattached if k not in alive]:
                del self._unattached[key]
            for s in sessions:
                key = (s.name, s.created)
                too_old = now - s.created >= self.max_age_s
                if s.attached > 0:
                    self._unattached.pop(key, None)
                    idle = False
                else:
                    first = self._unattached.setdefault(key, mono)
                    idle = mono - first >= self.idle_s
                if too_old or idle:
                    self._kill(s.name)
                    self._unattached.pop(key, None)
                    ended.append(s.name)
        return ended


def _in_pane(pid: int, socket: Path) -> bool:
    """Whether the process's environment names a pane of this socket's server (``TMUX``)."""
    try:
        environ = Path(f"/proc/{pid}/environ").read_bytes()
    except OSError:
        return False
    marker = b"TMUX=" + os.fsencode(str(socket)) + b","
    return any(entry.startswith(marker) for entry in environ.split(b"\0"))


def _alive(keys: set[tuple[int, int]]) -> set[tuple[int, int]]:
    """Which of these processes (pid, start time) still run; a zombie has ended."""
    out: set[tuple[int, int]] = set()
    for pid, start in keys:
        proc = P.read_proc(pid, with_cmdline=False)
        if proc is not None and proc.starttime == start and proc.state != "Z":
            out.add((pid, start))
    return out


def _wait_gone(keys: set[tuple[int, int]], timeout_s: float) -> set[tuple[int, int]]:
    """Waits up to ``timeout_s`` for these processes to end; returns those still running."""
    deadline = time.monotonic() + timeout_s
    left = _alive(keys)
    while left and time.monotonic() < deadline:
        time.sleep(0.05)
        left = _alive(left)
    return left


def _kill(pid: int, start: int) -> None:
    """SIGKILL to this very process, checked by its start time (never a recycled ID)."""
    proc = P.read_proc(pid, with_cmdline=False)
    if proc is None or proc.starttime != start:
        return
    with contextlib.suppress(ProcessLookupError, PermissionError):
        os.kill(pid, signal.SIGKILL)


def _names_socket(argv: list[str], socket: Path, uid: int) -> bool:
    """Whether a tmux command line, run as ``uid``, uses ``socket``: ``-L <name>`` (the default
    directory of that account, ``TMUX_TMPDIR`` unset, as the wrapper runs it) or ``-S <socket>``.
    The whole path counts, never the name alone: another socket called ``cfo-terminal`` (a test's)
    is not this one."""
    for i, arg in enumerate(argv[:-1]):
        if arg == "-L":
            return Path(f"/tmp/tmux-{uid}/{argv[i + 1]}") == socket
        if arg == "-S":
            return Path(argv[i + 1]) == socket
    return False
