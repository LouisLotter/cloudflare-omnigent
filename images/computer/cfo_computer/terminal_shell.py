"""The setup terminal's command under ttyd (WP3.28): one tmux session per terminal window.

ttyd runs ``python3 -I -m cfo_computer.terminal_shell`` with the arguments of the WebSocket URL
(``--url-arg``), which only WorkspaceDO builds: ``?arg=new&arg=<window>`` for a window's first
stream, ``?arg=attach&arg=<window>`` for every later one. The browser never reaches ttyd, and
nothing else is accepted: exactly two arguments, the mode and a window number of 1 to 9 digits
(or none at all, from an older WorkspaceDO: a plain login shell, as before).

- ``new <window>`` ends every other window's session (a new window never inherits an old shell),
  then starts, or joins if it already exists, the session ``w<window>`` running ``bash -l``.
- ``attach <window>`` joins ``w<window>``, and ends if it does not exist: the stream then ends,
  and the page says the session on the computer ended. A reconnect never gets a new shell
  silently, so a code pasted for a CLI's prompt can never run as a command and land in
  ``~/.bash_history``, which saves include.

The shell outlives its stream: ttyd hangs up only the tmux client. The supervisor ends sessions
(``terminals.py``): on WorkspaceDO's ``terminal_end``, before a sign-out, a stop's final capture
or a sign-in from the page, after 45 s with no stream attached, and 30 minutes after a session
started. Runs as the person's account; standard library only.
"""

from __future__ import annotations

import os
import re
import subprocess
import sys
from pathlib import Path

TMUX = "/usr/bin/tmux"
BASH = "/bin/bash"
#: The tmux server's socket name, separate from any tmux the person or Omnigent run.
SOCKET_NAME = "cfo-terminal"
CONFIG = Path(__file__).resolve().with_name("terminal-tmux.conf")
WINDOW = re.compile(r"[1-9][0-9]{0,8}")
SESSION = re.compile(r"w[1-9][0-9]{0,8}")
#: ``main``'s answer when ``attach`` finds no session for the window (or tmux cannot be asked).
GONE = 3
#: ``main``'s answer to arguments that are not WorkspaceDO's two forms.
USAGE = 2


def socket_path(uid: int) -> Path:
    """Where tmux puts ``-L cfo-terminal``'s socket for ``uid`` (``TMUX_TMPDIR`` unset)."""
    return Path(f"/tmp/tmux-{uid}/{SOCKET_NAME}")


def parse(argv: list[str]) -> tuple[str, int] | None:
    """``(mode, window)`` from exactly ``[mode, window]``, or None."""
    if len(argv) != 2:
        return None
    mode, window = argv
    if mode not in ("new", "attach") or WINDOW.fullmatch(window) is None:
        return None
    return mode, int(window)


def _env() -> dict[str, str]:
    # Never a nested or redirected tmux: the socket is always the one the supervisor manages.
    return {k: v for k, v in os.environ.items() if k not in ("TMUX", "TMUX_PANE", "TMUX_TMPDIR")}


def _tmux(*args: str) -> list[str]:
    return [TMUX, "-L", SOCKET_NAME, "-f", str(CONFIG), *args]


def _sessions(env: dict[str, str]) -> list[str]:
    done = subprocess.run(
        _tmux("list-sessions", "-F", "#{session_name}"),
        env=env,
        capture_output=True,
        text=True,
        timeout=10,
        check=False,
    )
    return done.stdout.split() if done.returncode == 0 else []


def main(argv: list[str] | None = None) -> int:
    args = sys.argv[1:] if argv is None else argv
    if not args:
        # A dial without arguments comes from a WorkspaceDO older than WP3.28, which ends the
        # shell with its stream and never reconnects to it: a plain login shell, as before.
        os.execve(BASH, [BASH, "-l"], _env())
    parsed = parse(args)
    if parsed is None:
        print("cfo-terminal: refused", file=sys.stderr)
        return USAGE
    mode, window = parsed
    name = f"w{window}"
    env = _env()
    if mode == "attach":
        try:
            exists = subprocess.run(
                _tmux("has-session", "-t", f"={name}"),
                env=env,
                capture_output=True,
                timeout=10,
                check=False,
            ).returncode
        except (OSError, subprocess.TimeoutExpired):
            exists = 1
        if exists != 0:
            return GONE
        os.execve(TMUX, _tmux("attach-session", "-t", f"={name}"), env)
    for other in _sessions(env):
        if other != name:
            subprocess.run(
                _tmux("kill-session", "-t", f"={other}"),
                env=env,
                capture_output=True,
                timeout=10,
                check=False,
            )
    os.execve(TMUX, _tmux("new-session", "-A", "-s", name, "bash", "-l"), env)
    return USAGE  # not reached


def exit_status(answer: int) -> int:
    """The process's exit status for ``main``'s answer. ttyd 1.7.7 closes the stream with 1000
    when its command exits 0 and with 1006 otherwise, and WorkspaceDO's bridge reads 1006 as a
    dropped link, after which the page reconnects (Codex WP3.28 r2-2). An ending the wrapper
    decides on (no session to attach to, or a refusal) is final, so it exits 0: the page then says
    the session on the computer ended."""
    return 0 if answer in (GONE, USAGE) else answer


if __name__ == "__main__":
    raise SystemExit(exit_status(main()))
