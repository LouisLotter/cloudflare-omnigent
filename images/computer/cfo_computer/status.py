"""The supervisor's part of the computer's status (WP3.23, ``computer_status``).

Only names, normalized versions, enum states and bounded counts leave the computer: never an
alert's text (it can hold an exception's name or a path), never a capture result whole (its
detail can quote paths), never a path under the CLIs' homes, an environment value or a file's
contents. WorkspaceDO composes the page's status from these metrics, the published credential
manifest, the sign-out phase and its own history of final save outcomes.
"""

from __future__ import annotations

import os
import re
from collections.abc import Callable, Sequence
from pathlib import Path
from typing import Any

#: Alert kinds by the message's start: the alerts' fixed openings (supervisor.py, credentials.py).
_ALERT_KINDS: tuple[tuple[str, str], ...] = (
    ("command failed", "command_failed"),
    ("a restored layer held", "restore_stripped"),
    ("restore failed", "restore_failed"),
    ("RC-53: the live values could not be collected", "rc53_collect_failed"),
    ("RC-53:", "rc53_finding"),
    ("the capture left paths out", "capture_skipped_paths"),
    ("resumed ", "capture_resumed"),
    ("the capture's stop journal", "capture_journal_failed"),
    ("a capture failed before", "capture_no_result"),
    ("credential checkpoint refused", "credential_refused"),
    ("hello not answered", "hello_unanswered"),
    ("report failed", "report_failed"),
    ("sign_in_failed", "sign_in_failed"),
)
ALERT_KINDS = frozenset(kind for _prefix, kind in _ALERT_KINDS) | {"credential_alert", "other"}

_VERSION = re.compile(r"(\d{1,4}\.\d{1,4}\.\d{1,6})")
VERSION_COMMANDS = {
    "claude": ["--version"],  # "2.1.311 (Claude Code)"
    "codex": ["--version"],  # "codex-cli 0.164.0"
    "gh": ["--version"],  # "gh version 2.103.3 (2026-…)"
}


def alert_kind(message: str, *, credential: bool = False) -> str:
    """The fixed kind of an alert, from its opening words; the text itself stays here."""
    for prefix, kind in _ALERT_KINDS:
        if message.startswith(prefix):
            return kind
    return "credential_alert" if credential else "other"


def normalized_version(output: bytes | None) -> str | None:
    """The first ``N.N.N`` of a version command's first line, or None."""
    if not output:
        return None
    first = output.decode("utf-8", "replace").strip().split("\n", 1)[0]
    match = _VERSION.search(first)
    return match.group(1) if match else None


def versions(
    run: Callable[[Sequence[str], float], tuple[int | None, bytes]], tools: dict[str, str]
):
    """Each CLI's normalized version (None when it cannot be read)."""
    out: dict[str, str | None] = {}
    for name, args in VERSION_COMMANDS.items():
        try:
            code, output = run([tools[name], *args], 30.0)
        except Exception:  # noqa: BLE001 - a missing CLI has no version
            code, output = None, b""
        out[name] = normalized_version(output) if code == 0 else None
    return out


def disk(path: Path) -> dict[str, int] | None:
    try:
        st = os.statvfs(path)
    except OSError:
        return None
    return {"totalBytes": st.f_blocks * st.f_frsize, "freeBytes": st.f_bavail * st.f_frsize}


def rc53_counts(result: dict[str, Any]) -> dict[str, int] | None:
    """A capture result's RC-53 counts, checked to be counts; None when the check did not run."""
    raw = result.get("rc53")
    if not isinstance(raw, dict):
        return None
    counts = {}
    for key in ("status", "values", "files", "findings", "incomplete"):
        value = raw.get(key)
        if not isinstance(value, int) or isinstance(value, bool) or value < 0:
            return None
        counts[key] = min(value, 255) if key == "status" else value
    return counts
