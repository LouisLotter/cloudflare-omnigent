"""Each CLI's own sign-in status and sign-out, run as the person's account (WP3.C, Q5).

The platform never reads a login file: the supervisor runs each CLI's status command and
reports what it says. Observed with the pinned CLIs in a throwaway home, without an account:
- ``claude auth status`` prints JSON with ``loggedIn``; it exits 0 when signed in and 1 when
  not. A login whose access token has expired still reads ``loggedIn: true`` (Claude refreshes
  on use), so ``expired`` is never derived from it.
- ``codex login status`` prints "Logged in …" and exits 0, or "Not logged in" and exits 1; a
  login file it cannot read gives "Error checking login status" with exit 1, reported as
  ``unknown``.
Anything else (a timeout, other output) is ``unknown``: unknown is never shown as signed out.

Logout: ``claude auth logout`` and ``codex logout``. Both exit 0 even when revocation at the
provider failed (S6), so ``ok`` proves a local sign-out at most.
"""

from __future__ import annotations

import json
from collections.abc import Callable, Sequence

STATUS_TIMEOUT_S = 30.0
LOGOUT_TIMEOUT_S = 60.0

# run(argv, timeout) -> (exit status or None on timeout, output)
Runner = Callable[[Sequence[str], float], tuple[int | None, bytes]]


def claude_status(run: Runner, claude: str = "claude") -> str:
    code, out = run([claude, "auth", "status", "--json"], STATUS_TIMEOUT_S)
    if code is None:
        return "unknown"
    try:
        start = out.index(b"{")
        data = json.loads(out[start : out.rindex(b"}") + 1])
    except ValueError:
        return "unknown"
    logged_in = data.get("loggedIn") if isinstance(data, dict) else None
    if logged_in is True and code == 0:
        return "signed_in"
    if logged_in is False and code in (0, 1):
        return "signed_out"
    return "unknown"


def codex_status(run: Runner, codex: str = "codex") -> str:
    code, out = run([codex, "login", "status"], STATUS_TIMEOUT_S)
    if code is None:
        return "unknown"
    text = out.decode("utf-8", "replace")
    lines = [line.strip() for line in text.splitlines() if line.strip() and not line.startswith("WARNING")]
    if code == 0 and any(line.startswith("Logged in") for line in lines):
        return "signed_in"
    if code == 1 and any(line == "Not logged in" for line in lines):
        return "signed_out"
    return "unknown"


def sign_out(run: Runner, claude: str = "claude", codex: str = "codex") -> dict[str, str]:
    results = {}
    for name, argv in (("claude", [claude, "auth", "logout"]), ("codex", [codex, "logout"])):
        code, _out = run(argv, LOGOUT_TIMEOUT_S)
        results[name] = "ok" if code == 0 else "failed"
    return results
