"""The setup terminal's sessions on the computer, as the supervisor ends them (WP3.28).

Each terminal window's shell runs in its own tmux session (``terminal_shell.py``) on a tmux
server of its own (``-L cfo-terminal``, the person's account). The session outlives its stream, so
a reconnect after a dropped connection or a Durable Object reset finds the same shell (FH-38).
Every way a stream may stop for good must therefore end the session here, on the computer:

- WorkspaceDO's ``terminal_end``: the sessions of every window up to the one it names;
- the credential-sensitive steps, first: a sign-out, a stop's final capture or its credential
  barrier, and a sign-in from the page (``end_all``);
- the reaper, which holds even if WorkspaceDO never comes back: a session with no stream
  attached for ``idle_s`` (45 s: the bridge's 30-second grace plus a margin), and any session
  older than ``max_age_s`` (30 minutes, the window's deadline).

The supervisor runs as root, but its tmux commands run as the person's account, the server's
owner: the socket's directory belongs to that account, and tmux's protocol lets a server have its
client run a command (``detach-client -E``), so a root client is never pointed at it. It never
reads what a session holds; it lists names, times and attached client counts, and kills.
``end_all`` does not depend on the server answering: whatever tmux server on this socket is still
alive after ``kill-server`` is killed by signal (as root).
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
from .terminal_shell import SESSION, SOCKET_NAME, socket_path

TMUX = "/usr/bin/tmux"
#: A session with no stream attached is ended after this (the bridge's grace is 30 s).
IDLE_S = 45.0
#: Any session is ended this long after it started (the window's deadline).
MAX_AGE_S = 30 * 60.0
#: How often the reaper looks.
REAP_INTERVAL_S = 5.0
#: How long one tmux command may take before the server counts as not answering.
TMUX_TIMEOUT_S = 5.0

Runner = Callable[..., subprocess.CompletedProcess[str]]


class NotAnswering(Exception):
    """The tmux server did not answer in time (a capture may have paused it)."""


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
        """Ends every session, whether or not the server answers: ``kill-server`` (each shell
        gets its hang-up), then SIGKILL for any server process on this socket still alive (one
        paused by a capture, or wedged)."""
        with self._lock:
            if os.path.exists(self.socket):
                with contextlib.suppress(NotAnswering):
                    self._tmux("kill-server")
            for pid in self.server_pids():
                with contextlib.suppress(ProcessLookupError, PermissionError):
                    os.kill(pid, signal.SIGKILL)
            self._unattached.clear()

    def server_pids(self) -> list[int]:
        """The tmux server processes of this socket, owned by the person's account. A pane's
        process between its fork and its exec looks the same; only the outermost one counts."""
        found = {
            proc.pid: proc
            for proc in P.scan().values()
            if proc.uid == self.uid
            and proc.comm.startswith("tmux")
            and "server" in proc.comm
            and _names_socket(proc.cmdline, self.socket)
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


def _names_socket(argv: list[str], socket: Path) -> bool:
    """Whether a tmux command line uses ``socket``: ``-L cfo-terminal`` (with the default
    directory) or ``-S <socket>``."""
    for i, arg in enumerate(argv[:-1]):
        if arg == "-L" and argv[i + 1] == SOCKET_NAME:
            return socket.name == SOCKET_NAME
        if arg == "-S" and argv[i + 1] == str(socket):
            return True
    return False
