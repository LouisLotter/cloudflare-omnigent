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
    fd: int | None = None
    out: bytearray = field(default_factory=bytearray)
    #: Offset in the decoded output at the last pasted code; -1 before any.
    after_input: int = -1
    stop: threading.Event = field(default_factory=threading.Event)
    #: Set once its spawn is over: the process is assigned, or killed and reaped, or never made.
    spawned: threading.Event = field(default_factory=threading.Event)

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
#: ``cancelled()`` turns true while it waits.
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
                self._end(attempt, "failed", "not_ready")
                attempt.spawned.set()
                return attempt.view()
        # The older attempt is ended first: its process killed and reaped, even mid-spawn. A
        # wedged spawn does not hold the new attempt back; its own thread kills it when it ends.
        if superseded is not None and not self._settle([superseded]):
            self._alert("sign_in_failed")
        thread = threading.Thread(
            target=self._run, args=(attempt,), name=f"sign-in-{service}", daemon=True
        )
        with self._lock:
            self._threads.append(thread)
        thread.start()
        self._on_change()
        return self.status(service, number)

    def write(self, service: str, number: int, code: str) -> dict[str, Any]:
        """Claude: the pasted code and a carriage return, to the attempt's pty."""
        if service != "claude" or not _CODE.match(code):
            raise SignInConflict("only Claude takes a code, of printable characters")
        with self._lock:
            attempt = self._current[service]
            if attempt is None or attempt.number != number:
                raise SignInConflict("not the running attempt")
            if attempt.state != "awaiting_user" or attempt.fd is None:
                raise SignInConflict("the attempt is not waiting for a code")
            text = attempt.out.decode("utf-8", "replace")
            attempt.after_input = len(text)
            attempt.notice = None
            os.write(attempt.fd, code.encode("ascii") + b"\r")
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
        settled = self._settle(ended)
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
            ended = []
            for service in SERVICES:
                current = self._current[service]
                if current is not None and current.state in ACTIVE:
                    self._fence[service] = max(self._fence[service], current.number)
                    self._end(current, "cancelled")
                    ended.append(current)
        settled = self._settle(ended)
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

    def _settle(self, ended: list[Attempt]) -> bool:
        """Waits (never under the lock: the spawning thread needs it) until each ended attempt's
        spawn is over, then kills and reaps what it made. True once none can still start."""
        settled = True
        for attempt in ended:
            if not attempt.spawned.wait(SPAWN_SETTLE_S):
                settled = False
                continue
            _kill(attempt.proc)
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
        """Ends an attempt (under the lock): kill and reap its process group, wipe its secrets,
        and remember only its final state and reason."""
        if attempt.state in FINAL:
            return
        attempt.stop.set()
        _kill(attempt.proc)
        if attempt.fd is not None:
            with contextlib.suppress(OSError):
                os.close(attempt.fd)
            attempt.fd = None
        attempt.state = state
        attempt.reason = reason if state == "failed" else None
        attempt.url = None
        attempt.user_code = None
        attempt.notice = None
        attempt.out[:] = bytes(len(attempt.out))
        attempt.out.clear()
        if state == "failed":
            self._alert("sign_in_failed")
        self._finished[attempt.service][attempt.number] = attempt.view()
        self._trim(attempt.service)

    def _run(self, attempt: Attempt) -> None:
        try:
            proc, fd = self._spawn(attempt.service, attempt.stop.is_set)
        except Exception:  # noqa: BLE001 - never the exception's text (a cancel's included)
            with self._lock:
                self._end(attempt, "failed", "start_failed")
            attempt.spawned.set()
            self._on_change()
            return
        with self._lock:
            stopped = attempt.stop.is_set()
            if not stopped:
                attempt.proc = proc
                attempt.fd = fd
        if stopped:
            # Ended while it was being spawned (a cancel, a newer start): killed and reaped
            # before anyone waiting on the spawn is told it is over.
            _kill(proc)
            with contextlib.suppress(OSError):
                os.close(fd)
            attempt.spawned.set()
            return
        attempt.spawned.set()
        try:
            self._read(attempt)
        except Exception:  # noqa: BLE001 - a reader failure ends the attempt, never silently
            with self._lock:
                self._end(attempt, "failed", "cli_exited")
        self._on_change()

    def _read(self, attempt: Attempt) -> None:
        while not attempt.stop.is_set():
            fd = attempt.fd
            if fd is None:
                return
            try:
                ready, _, _ = select.select([fd], [], [], 0.2)
            except (OSError, ValueError):
                ready = []
            chunk = b""
            if ready:
                try:
                    chunk = os.read(fd, 65536)
                except OSError:
                    chunk = b""
            with self._lock:
                if attempt.stop.is_set():
                    return
                if chunk:
                    attempt.out += chunk
                exited = attempt.proc is not None and attempt.proc.poll() is not None
                if ready and not chunk and not exited:
                    # The pty closed (EIO) but the process has not been seen to exit yet.
                    with contextlib.suppress(subprocess.TimeoutExpired):
                        attempt.proc.wait(timeout=1.0)  # type: ignore[union-attr]
                    exited = attempt.proc.poll() is not None  # type: ignore[union-attr]
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
            # Whatever is left to read has been read: the pty's other side is gone.
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


def _kill(proc: subprocess.Popen[bytes] | None) -> None:
    """Kills the attempt's whole process group (its own session) and reaps the process."""
    if proc is None:
        return
    with contextlib.suppress(ProcessLookupError, PermissionError):
        os.killpg(proc.pid, signal.SIGKILL)
    with contextlib.suppress(ProcessLookupError, PermissionError):
        proc.kill()
    with contextlib.suppress(subprocess.TimeoutExpired, ChildProcessError):
        proc.wait(timeout=10)


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
