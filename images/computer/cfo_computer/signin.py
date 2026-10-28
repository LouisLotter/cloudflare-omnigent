"""Sign-in from the setup page (WP3.23; design, Signing in, D31).

The supervisor runs each CLI's own, unmodified login in a pty, as the computer's user, with the
terminal's environment and under the workload's spawn and capture controls:

  claude auth login --claudeai     prints Anthropic's link, then "Paste code here if prompted >";
                                   the person signs in and pastes the code, which the page relays
  codex login --device-auth        prints OpenAI's link and a one-time code; the person enters
                                   the code on OpenAI's page and Codex finishes by itself

It reads the link (and Codex's code) from what the CLI prints, and accepts a link only if it is
HTTPS on exactly the host and path the pinned CLI uses (``LINKS``, the same rule as the contract's
``signInLinkAllowed``). Completion is the CLI's own: on success the credential watcher sees the
login file change and publishes it, as after a terminal sign-in.

Fencing (contracts/src/computer-protocol.ts). Per service, ``fence`` is the highest attempt seen
in a start or a cancel. A start below the fence, or at it once cancelled or finished, is
``superseded`` (or answers the finished attempt's state); a newer start ends the running attempt
first; a cancel raises the fence, so a start delayed in transit never begins after its cancel.

Ending an attempt (cancel, the 10-minute deadline, a failure, a parser failure, a newer start, a
sign-out) kills its whole process group and reaps it before anything else is answered, so the
terminal offered as the fallback never races a login still running.

Descriptors (WP3.26). Each attempt's thread owns its pty and a wake pipe from the spawn on: only
it reads them and only it closes them, once the attempt has ended. Ending an attempt from another
thread kills the CLI and writes to the wake pipe; it never closes a descriptor the reader may
still be using, because the number, once free, goes to the next open (another attempt's pty, a
pipe, a socket), and the reader would block on it or read what it holds. The pty is non-blocking,
so no read or write ever waits on the CLI; every other wait here has a bound.

Custody. The link, Codex's code and the pasted code live in this process's memory only, for the
attempt's life: they are never written to a file, an alert, a log or the report. Only fixed state
names and failure reasons ever leave this module. The CLI's output is buffered in memory, bounded,
and wiped when the attempt ends.

Parsing is pure (``parse``), tested against the pinned CLIs' captured transcripts
(images/computer/fakes/login_transcripts.json, with synthetic values).
"""

from __future__ import annotations

import contextlib
import os
import re
import select
import signal
import subprocess
import threading
import time
import urllib.parse
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

SERVICES = ("claude", "codex")
#: Where each pinned CLI's link goes (Claude Code 2.1.311, Codex 0.164.0).
LINKS = {
    "claude": ("claude.com", "/cai/oauth/authorize"),
    "codex": ("auth.openai.com", "/codex/device"),
}
#: The login commands, after the CLI's own name.
LOGIN_ARGS = {"claude": ["auth", "login", "--claudeai"], "codex": ["login", "--device-auth"]}
#: The platform's deadline for an attempt; a provider's code may expire sooner.
DEADLINE_S = 600.0
#: A CLI that has not printed a valid link and prompt by then printed something unexpected.
LINK_TIMEOUT_S = 60.0
#: The most output kept for an attempt; more is unexpected.
MAX_OUTPUT_BYTES = 64 * 1024
#: Finished attempts remembered for their status, per service.
KEEP_FINISHED = 8
#: How long ending an attempt waits for its spawn to finish (the spawn gives up waiting for a
#: capture's gate as soon as the attempt ends, so this is a bound on a wedged spawn only).
SPAWN_SETTLE_S = 30.0
#: How long a reader waits for output before it looks at its attempt again (the deadline, the
#: link timeout, the process); ending the attempt wakes it at once.
POLL_S = 0.2
#: The most a reader takes from the pty at once.
READ_BYTES = 65536
#: How long ending an attempt waits for its killed process to be reaped.
REAP_S = 10.0

_LINK_CHARS = re.compile(r"^https://[A-Za-z0-9\-._~:/?#@!$&()*+,;=%]+$")
_USER_CODE = re.compile(r"^[A-Z0-9]{4,12}(?:-[A-Z0-9]{4,12}){0,3}$")
_CODE = re.compile(r"^[\x21-\x7e]{1,1024}$")
_OSC8 = re.compile(r"\x1b\]8;[^;\x07\x1b]*;([^\x07\x1b]*)(?:\x07|\x1b\\)")
_OSC = re.compile(r"\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)")
_CSI = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")
_HTTPS = re.compile(r"https://\S+")

# What the pinned CLIs print (the captured transcripts).
CLAUDE_PROMPT = "Paste code here if prompted"
CLAUDE_SUCCESS = "Login successful."
CLAUDE_REJECTED = "Login failed:"
CLAUDE_INCOMPLETE = "Invalid code. Please make sure the full code was copied."
CODEX_LINK_INTRO = "Open this link in your browser"
CODEX_CODE_INTRO = "Enter this one-time code"
CODEX_SUCCESS = "Successfully logged in"
CODEX_ERROR = "Error logging in with device code:"
CODEX_NETWORK = "error sending request"
CODEX_DENIED = "device auth failed with status"

ACTIVE = frozenset({"starting", "awaiting_user", "completing"})
FINAL = frozenset({"done", "failed", "expired", "cancelled", "superseded"})


def link_allowed(service: str, url: str) -> bool:
    """HTTPS on exactly the pinned CLI's host and path; no port, no user information."""
    if len(url) > 2048 or not _LINK_CHARS.match(url):
        return False
    try:
        parts = urllib.parse.urlsplit(url)
        port = parts.port
    except ValueError:
        return False
    host, path = LINKS[service]
    return (
        parts.scheme == "https"
        and parts.netloc == host
        and parts.hostname == host
        and port is None
        and parts.username is None
        and parts.path == path
    )


def plain(text: str) -> str:
    """The text a person would read: escape sequences and carriage returns removed."""
    return _CSI.sub("", _OSC.sub("", text)).replace("\r", "")


@dataclass(frozen=True)
class Parsed:
    """What the output so far says. ``url``/``user_code`` only once accepted."""

    url: str | None = None
    user_code: str | None = None
    #: The CLI waits for the person (Claude: its prompt; Codex: the link and code are shown).
    waiting: bool = False
    #: A fixed failure reason the output already proves, or None.
    failure: str | None = None
    #: The CLI said it succeeded.
    success: bool = False
    #: Claude said the last pasted code was incomplete, and waits again.
    incomplete: bool = False


def _complete(text: str) -> str:
    """The complete lines only: a read can end in the middle of a line, and a link cut short
    must never be judged."""
    return text[: text.rfind("\n") + 1]


def _claude(raw: str, after_input: int) -> Parsed:
    text = plain(raw)
    targets = _OSC8.findall(raw)
    candidates = [t for t in targets if t] or _HTTPS.findall(_complete(text))
    url = candidates[0] if candidates else None
    if url is not None and not link_allowed("claude", url):
        return Parsed(failure="unexpected_output")
    tail = plain(raw[after_input:]) if after_input >= 0 else ""
    return Parsed(
        url=url,
        waiting=url is not None and CLAUDE_PROMPT in text,
        failure="code_rejected" if CLAUDE_REJECTED in tail else None,
        success=CLAUDE_SUCCESS in tail,
        incomplete=CLAUDE_INCOMPLETE in tail,
    )


def _next_token(lines: list[str], intro: str) -> str | None:
    for i, line in enumerate(lines):
        if intro in line:
            for later in lines[i + 1 :]:
                token = later.strip()
                if token:
                    return token
    return None


def _codex(raw: str) -> Parsed:
    text = plain(raw)
    lines = _complete(text).split("\n")
    url = _next_token(lines, CODEX_LINK_INTRO)
    code = _next_token(lines, CODEX_CODE_INTRO)
    if url is not None and not link_allowed("codex", url):
        return Parsed(failure="unexpected_output")
    if code is not None and not _USER_CODE.match(code):
        return Parsed(failure="unexpected_output")
    failure = None
    if CODEX_ERROR in text:
        failure = (
            "network"
            if CODEX_NETWORK in text
            else "denied"
            if CODEX_DENIED in text
            else "cli_exited"
        )
    return Parsed(
        url=url,
        user_code=code,
        waiting=url is not None and code is not None,
        failure=failure,
        success=CODEX_SUCCESS in text,
    )


def parse(service: str, raw: str, after_input: int = -1) -> Parsed:
    """What ``raw`` (the CLI's whole output so far) says. ``after_input``: the offset in ``raw``
    at the last pasted code (Claude), or -1 before any."""
    return _claude(raw, after_input) if service == "claude" else _codex(raw)


# ---------------------------------------------------------------------------------------------


class SignInConflict(Exception):
    """The command does not fit the attempt's state (no such attempt, not waiting, Codex)."""


class SignInUnsettled(Exception):
    """An ended attempt's spawn has not finished in time: its process may still start; the
    caller answers "try again" (Codex WP3.23 r1-3)."""


class SpawnCancelled(Exception):
    """The attempt ended while its spawn waited (for a capture's gate)."""


@dataclass
class Attempt:
    service: str
    number: int
    state: str = "starting"
    reason: str | None = None
    notice: str | None = None
    url: str | None = None
    user_code: str | None = None
    started: float = 0.0
    deadline: float = 0.0
    proc: subprocess.Popen[bytes] | None = None
    #: The pty master, while its reader runs (set and cleared under the lock; the reader owns it).
    fd: int | None = None
    #: The write end of the reader's wake pipe, while its reader runs: ending the attempt writes a
    #: byte to it so the reader stops at once (the reader owns and closes it).
    wake: int | None = None
    out: bytearray = field(default_factory=bytearray)
    #: Offset in the decoded output at the last pasted code; -1 before any.
    after_input: int = -1
    stop: threading.Event = field(default_factory=threading.Event)
    #: Set once its spawn is over: the process is assigned, or killed and reaped, or never made.
    spawned: threading.Event = field(default_factory=threading.Event)
    #: Held for each kill of its process, check to reap: two callers (a settle and another, or
    #: the reader and an end) never interleave, so a group is never signalled after the other
    #: one reaped its leader (Codex WP3.26 r1-1).
    reaping: threading.Lock = field(default_factory=threading.Lock)

    def view(self) -> dict[str, Any]:
        view: dict[str, Any] = {
            "service": self.service,
            "attempt": self.number,
            "state": self.state,
        }
        if self.state in ("awaiting_user", "completing") and self.url is not None:
            view["url"] = self.url
        if self.state == "awaiting_user" and self.user_code is not None:
            view["userCode"] = self.user_code
        if self.state == "failed" and self.reason is not None:
            view["reason"] = self.reason
        if self.state == "awaiting_user" and self.notice is not None:
            view["notice"] = self.notice
        return view


#: spawn(service, cancelled) -> (process, pty master): the CLI's login, as workload, in a new
#: session whose controlling terminal is the pty. Raises on failure, and ``SpawnCancelled`` when
#: ``cancelled()`` turns true while it waits (the attempt ended, or its deadline passed).
Spawn = Callable[[str, Callable[[], bool]], "tuple[subprocess.Popen[bytes], int]"]


class SignIns:
    """The sign-in attempts of one supervisor: at most one running per service."""

    def __init__(
        self,
        spawn: Spawn,
        *,
        ready: Callable[[], bool] = lambda: True,
        alert: Callable[[str], None] = lambda _kind: None,
        on_change: Callable[[], None] = lambda: None,
        clock: Callable[[], float] = time.monotonic,
        deadline_s: float = DEADLINE_S,
        link_timeout_s: float = LINK_TIMEOUT_S,
    ) -> None:
        self._spawn = spawn
        self._ready = ready
        self._alert = alert
        self._on_change = on_change
        self._clock = clock
        self.deadline_s = deadline_s
        self.link_timeout_s = link_timeout_s
        self._lock = threading.RLock()
        self._fence = dict.fromkeys(SERVICES, 0)
        self._current: dict[str, Attempt | None] = dict.fromkeys(SERVICES)
        self._finished: dict[str, dict[int, dict[str, Any]]] = {s: {} for s in SERVICES}
        self._threads: list[threading.Thread] = []
        #: Ended attempts whose spawn is not yet confirmed over: kept, whatever their visible
        #: state, until a settle sees them over and reaped (Codex WP3.23 r2-1).
        self._unsettled: list[Attempt] = []

    # -- the commands -----------------------------------------------------------------------

    def start(self, service: str, number: int) -> dict[str, Any]:
        with self._lock:
            fence = self._fence[service]
            current = self._current[service]
            if number < fence or (number == fence and fence > 0):
                if current is not None and current.number == number:
                    return current.view()
                return self._known(service, number)
            self._fence[service] = number
            superseded = current if current is not None and current.state in ACTIVE else None
            if superseded is not None:
                self._end(superseded, "superseded")
            attempt = Attempt(service, number, started=self._clock())
            attempt.deadline = attempt.started + self.deadline_s
            self._current[service] = attempt
            if not self._ready():
                attempt.spawned.set()
                self._end(attempt, "failed", "not_ready")
                return attempt.view()
        # The older attempts are ended first: their processes killed and reaped, even mid-spawn.
        # A wedged spawn does not hold the new attempt back, but stays owed: any later cancel of
        # this service, or a sign-out, waits for it.
        if superseded is not None and not self._settle(
            lambda a: a.service == service and a.number < number
        ):
            self._alert("sign_in_failed")
        thread = threading.Thread(
            target=self._run, args=(attempt,), name=f"sign-in-{service}", daemon=True
        )
        with self._lock:
            # Only finished threads are dropped (one not started yet has no ident).
            self._threads = [t for t in self._threads if t.ident is None or t.is_alive()]
            self._threads.append(thread)
        thread.start()
        self._on_change()
        return self.status(service, number)

    def write(self, service: str, number: int, code: str) -> dict[str, Any]:
        """Claude: the pasted code and a carriage return, to the attempt's pty. The pty is
        non-blocking: a CLI that no longer takes its input (gone, or not reading it) fails the
        attempt instead of holding the lock."""
        if service != "claude" or not _CODE.match(code):
            raise SignInConflict("only Claude takes a code, of printable characters")
        with self._lock:
            attempt = self._current[service]
            if attempt is None or attempt.number != number:
                raise SignInConflict("not the running attempt")
            if attempt.state != "awaiting_user" or attempt.fd is None:
                raise SignInConflict("the attempt is not waiting for a code")
            text = attempt.out.decode("utf-8", "replace")
            data = code.encode("ascii") + b"\r"
            try:
                written = os.write(attempt.fd, data)
            except OSError:  # BlockingIOError included: the input queue is full
                written = -1
            if written != len(data):
                self._end(attempt, "failed", "cli_exited")
                return attempt.view()
            attempt.after_input = len(text)
            attempt.notice = None
            attempt.state = "completing"
            return attempt.view()

    def cancel(self, service: str, number: int) -> dict[str, Any]:
        """Ends the attempt (and any older one); answers only once its process can no longer
        start and any it made is reaped. Raises ``SignInUnsettled`` otherwise."""
        with self._lock:
            self._fence[service] = max(self._fence[service], number)
            current = self._current[service]
            ended = []
            if current is not None and current.number <= number:
                self._end(current, "cancelled" if current.number == number else "superseded")
                ended.append(current)
            if current is None or current.number != number:
                finished = self._finished[service]
                finished.setdefault(
                    number, {"service": service, "attempt": number, "state": "cancelled"}
                )
                self._trim(service)
            view = self._known(service, number)
        # Every attempt this cancel covers (its own and any older of the service), including
        # ones ended earlier whose spawn is still not over.
        settled = self._settle(lambda a: a.service == service and a.number <= number)
        self._on_change()
        if not settled:
            raise SignInUnsettled("the attempt's spawn has not finished")
        return view

    def status(self, service: str, number: int) -> dict[str, Any]:
        with self._lock:
            current = self._current[service]
            if current is not None and current.number == number:
                return current.view()
            return self._known(service, number)

    def cancel_all(self) -> bool:
        """Ends every running attempt (a sign-out, a stop): killed and reaped before returning.
        False if a spawn has not finished in time (its process may still start)."""
        with self._lock:
            for service in SERVICES:
                current = self._current[service]
                if current is not None and current.state in ACTIVE:
                    self._fence[service] = max(self._fence[service], current.number)
                    self._end(current, "cancelled")
        # Every ended attempt still owed a settle, earlier ones included.
        settled = self._settle(lambda _a: True)
        self._on_change()
        return settled

    def states(self) -> dict[str, str]:
        """Each service's latest attempt's state, or ``none``: names only, for the status."""
        with self._lock:
            return {
                s: (self._current[s].state if self._current[s] is not None else "none")  # type: ignore[union-attr]
                for s in SERVICES
            }

    def join(self, timeout: float = 5.0) -> None:
        """Waits for the readers (tests)."""
        for thread in list(self._threads):
            thread.join(timeout)

    # -- internals ----------------------------------------------------------------------------

    def _settle(self, covers: Callable[[Attempt], bool]) -> bool:
        """Waits (never under the lock: the spawning thread needs it) until the spawn of every
        owed attempt ``covers`` names is over, then kills and reaps what it made. True once none
        of them can still start and all they made is reaped; the others stay owed for the next
        settle."""
        with self._lock:
            owed = [a for a in self._unsettled if covers(a)]
        settled = True
        for attempt in owed:
            if not attempt.spawned.wait(SPAWN_SETTLE_S) or not _kill(attempt):
                settled = False
                continue
            with self._lock:
                if attempt in self._unsettled:
                    self._unsettled.remove(attempt)
        return settled

    def _known(self, service: str, number: int) -> dict[str, Any]:
        finished = self._finished[service].get(number)
        if finished is not None:
            return dict(finished)
        state = "superseded" if number < self._fence[service] else "none"
        return {"service": service, "attempt": number, "state": state}

    def _trim(self, service: str) -> None:
        finished = self._finished[service]
        for old in sorted(finished)[:-KEEP_FINISHED]:
            del finished[old]

    def _end(self, attempt: Attempt, state: str, reason: str | None = None) -> None:
        """Ends an attempt (under the lock): kill and reap its process group, wake its reader,
        wipe its secrets, and remember only its final state and reason. It closes no descriptor:
        the reader may be between waking and reading, and closes them itself once it stops."""
        if attempt.state in FINAL:
            return
        attempt.stop.set()
        # Bounded (REAP_S) and under the lock on purpose: the end is visible only once the
        # process is reaped. One not reaped in time stays owed (below) for the next settle.
        reaped = _kill(attempt)
        if attempt.wake is not None:
            # Non-blocking, written once per attempt: it never waits.
            with contextlib.suppress(OSError):
                os.write(attempt.wake, b"\0")
        attempt.state = state
        attempt.reason = reason if state == "failed" else None
        attempt.url = None
        attempt.user_code = None
        attempt.notice = None
        attempt.out[:] = bytes(len(attempt.out))
        attempt.out.clear()
        if state == "failed":
            self._alert("sign_in_failed")
        if not attempt.spawned.is_set() or not reaped:
            self._unsettled.append(attempt)
        self._finished[attempt.service][attempt.number] = attempt.view()
        self._trim(attempt.service)

    def _run(self, attempt: Attempt) -> None:
        """The attempt's thread. From the spawn on it owns the pty and the wake pipe: it alone
        reads them, and it closes them only once it has stopped reading."""
        wake: tuple[int, int] | None = None
        try:
            wake = os.pipe()
            os.set_blocking(wake[1], False)
            # Waiting to spawn (a capture's gate) gives up when the attempt ends or its deadline
            # passes (Codex WP3.26 r1-3).
            proc, fd = self._spawn(
                attempt.service,
                lambda: attempt.stop.is_set() or self._clock() >= attempt.deadline,
            )
        except Exception:  # noqa: BLE001 - never the exception's text (a cancel's included)
            if wake is not None:
                _close(*wake)
            with self._lock:
                if self._clock() >= attempt.deadline:
                    self._end(attempt, "expired")
                else:
                    self._end(attempt, "failed", "start_failed")
            attempt.spawned.set()
            self._on_change()
            return
        with self._lock:
            # The process is the attempt's either way: a settle that finds it not yet reaped
            # retries the kill.
            attempt.proc = proc
            stopped = attempt.stop.is_set()
            if not stopped:
                attempt.fd = fd
                attempt.wake = wake[1]
        if stopped:
            # Ended while it was being spawned (a cancel, a newer start): killed and reaped
            # before anyone waiting on the spawn is told it is over.
            _kill(attempt)
            _close(fd, *wake)
            attempt.spawned.set()
            return
        attempt.spawned.set()
        try:
            self._read(attempt, proc, fd, wake[0])
        except Exception:  # noqa: BLE001 - a reader failure ends the attempt, never silently
            with self._lock:
                self._end(attempt, "failed", "cli_exited")
        finally:
            with self._lock:
                # The reader has stopped: nothing can use these numbers any more.
                attempt.fd = None
                attempt.wake = None
            _close(fd, *wake)
        self._on_change()

    def _read(self, attempt: Attempt, proc: subprocess.Popen[bytes], fd: int, wake: int) -> None:
        """Reads the CLI's output until the attempt ends. Each wait is bounded: the poll by
        ``POLL_S`` (and cut short by ``_end``'s wake), and reads never block."""
        os.set_blocking(fd, False)
        poller = select.poll()
        poller.register(fd, select.POLLIN)
        poller.register(wake, select.POLLIN)
        closed = False  # the pty's other side is gone: everything written to it has been read
        while True:
            ready = {ready_fd for ready_fd, _events in poller.poll(POLL_S * 1000)}
            if attempt.stop.is_set():
                return
            # The exit is observed before the pty is drained, so everything the CLI printed
            # before exiting is read before its end is judged (a read takes the pty's pending
            # output before it answers "nothing now" or "closed"). Codex WP3.26 r1-2.
            exited = _exited(proc)
            chunk = b""
            if not closed and (fd in ready or exited):
                chunk, closed = _drain(fd)
                if closed:
                    poller.unregister(fd)  # from here: the wake and the timeout only
            with self._lock:
                if attempt.stop.is_set():
                    return
                if exited:
                    # Its group (any straggler) is killed and it is reaped before the end is
                    # judged and shown; under the lock, as ``_end``'s kill is, and at once: it has
                    # exited.
                    _kill(attempt)
                if chunk:
                    attempt.out += chunk
                if self._step(attempt, exited):
                    return
            if chunk or exited:
                self._on_change()

    def _step(self, attempt: Attempt, exited: bool) -> bool:
        """Applies what the output says (under the lock); True once the attempt ended."""
        now = self._clock()
        if len(attempt.out) > MAX_OUTPUT_BYTES:
            self._end(attempt, "failed", "unexpected_output")
            return True
        raw = attempt.out.decode("utf-8", "replace")
        parsed = parse(attempt.service, raw, attempt.after_input)
        if exited:
            # The CLI exited before the pty was drained: everything it printed has been read.
            code = attempt.proc.returncode if attempt.proc is not None else None
            if code == 0 and (parsed.success or attempt.state in ("completing", "awaiting_user")):
                self._end(attempt, "done")
            elif parsed.failure is not None:
                self._end(attempt, "failed", parsed.failure)
            else:
                self._end(attempt, "failed", "cli_exited")
            return True
        if parsed.failure == "unexpected_output":
            self._end(attempt, "failed", "unexpected_output")
            return True
        if now >= attempt.deadline:
            self._end(attempt, "expired")
            return True
        if attempt.state == "starting":
            if parsed.waiting:
                attempt.url = parsed.url
                attempt.user_code = parsed.user_code
                attempt.state = "awaiting_user"
            elif now - attempt.started >= self.link_timeout_s:
                self._end(attempt, "failed", "unexpected_output")
                return True
        elif attempt.state == "completing" and parsed.incomplete and not parsed.success:
            attempt.state = "awaiting_user"
            attempt.notice = "incomplete_code"
        return False


def _kill(attempt: Attempt) -> bool:
    """Kills the attempt's whole process group (its own session) and reaps the process; True
    once it is reaped (or there is none). The group is signalled only while its leader is not
    yet reaped: until then the leader's ID, which is the group's, cannot be reused. Reaping is
    left to this function alone (``_exited`` does not reap), so it always kills first, and the
    attempt's ``reaping`` lock keeps two callers from interleaving. Waiting for that lock and for
    the reap share one ``REAP_S`` budget, so callers queued behind a process that will not be
    reaped each give up within it (Codex WP3.26 r2-1); False then, and the attempt stays owed."""
    deadline = time.monotonic() + REAP_S
    if not attempt.reaping.acquire(timeout=REAP_S):
        return False
    try:
        proc = attempt.proc
        if proc is None:
            return True
        if proc.returncode is None:
            with contextlib.suppress(ProcessLookupError, PermissionError):
                os.killpg(proc.pid, signal.SIGKILL)
            with contextlib.suppress(ProcessLookupError, PermissionError):
                proc.kill()
        try:
            proc.wait(timeout=max(0.0, deadline - time.monotonic()))
        except subprocess.TimeoutExpired:
            return False
        except ChildProcessError:
            pass
        return True
    finally:
        attempt.reaping.release()


def _exited(proc: subprocess.Popen[bytes]) -> bool:
    """Whether the CLI has exited, without reaping it (see ``_kill``)."""
    if proc.returncode is not None:
        return True
    try:
        return os.waitid(os.P_PID, proc.pid, os.WEXITED | os.WNOHANG | os.WNOWAIT) is not None
    except ChildProcessError:
        return True


def _drain(fd: int) -> tuple[bytes, bool]:
    """What the pty holds now (at most just over the output bound), and whether its other side
    is closed. Never blocks: the pty is non-blocking."""
    data = bytearray()
    while len(data) <= MAX_OUTPUT_BYTES:
        try:
            chunk = os.read(fd, READ_BYTES)
        except BlockingIOError:
            return bytes(data), False
        except OSError:  # EIO: every descriptor of the pty's other side is closed
            return bytes(data), True
        if not chunk:
            return bytes(data), True
        data += chunk
    return bytes(data), False


def _close(*fds: int) -> None:
    for fd in fds:
        with contextlib.suppress(OSError):
            os.close(fd)


def spawn_login(
    service: str,
    *,
    cli: str,
    env: dict[str, str],
    cwd: str,
    argv_wrapper: Callable[[list[str]], list[str]],
) -> tuple[subprocess.Popen[bytes], int]:
    """The CLI's login on a new pty: ``setsid --ctty`` makes the pty its controlling terminal in
    a session of its own (so the whole group can be killed), inside ``argv_wrapper`` (the
    workload's cgroup join and the drop to the person's account). Not a session leader itself,
    so ``setsid`` never forks: the process's ID is its group's."""
    master, slave = os.openpty()
    try:
        argv = argv_wrapper(["setsid", "--ctty", cli, *LOGIN_ARGS[service]])
        proc = subprocess.Popen(  # noqa: S603 - fixed argv
            argv,
            stdin=slave,
            stdout=slave,
            stderr=slave,
            env={**env, "TERM": env.get("TERM", "xterm-256color")},
            cwd=cwd,
            close_fds=True,
        )
    except BaseException:
        os.close(master)
        raise
    finally:
        os.close(slave)
    return proc, master
