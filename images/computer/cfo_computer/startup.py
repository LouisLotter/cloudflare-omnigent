"""What the supervisor puts right in its container, as root, before anything else starts (WP3.22).

Cloudflare's ``durable_object`` containers differ from Docker's in two ways the workload notices
(the 27 Oct 2026 staging sitting):

- **The hostname is not in /etc/hosts.** It is the Durable Object's ID, 64 hex characters, and
  nothing maps it, so every ``sudo`` prints "unable to resolve host <hostname>". The name is
  mapped to 127.0.1.1, as Debian maps its own hostname.
- **``/`` is not owned by root** (it was 2346:2346, mode 0755; the image's own layers give it to
  root, as Docker shows, so the runtime assembles the root filesystem that way). Claude Code
  vets every directory from its sockets directory up to ``/`` and refuses one not owned by the
  user or root, so it turned cross-session messaging off ("'/' is not owned by you or root"),
  whatever ``CLAUDE_CODE_TMPDIR`` or ``XDG_RUNTIME_DIR`` said. ``/`` is given back to root; its
  mode is left alone.

Both are idempotent and best-effort: a change that cannot be made is reported, and the supervisor
carries on, as the workload still runs without them.
"""

from __future__ import annotations

import os
import re
import socket
from pathlib import Path

HOSTS = Path("/etc/hosts")
HOSTNAME_ADDRESS = "127.0.1.1"
_HOSTNAME = re.compile(r"[A-Za-z0-9](?:[A-Za-z0-9.-]{0,252})")


def map_hostname(hosts: Path = HOSTS, hostname: str | None = None) -> str:
    """Make this container's hostname resolve through ``hosts``, once. Returns what it did."""
    name = socket.gethostname() if hostname is None else hostname
    if not _HOSTNAME.fullmatch(name) or name == "localhost":
        return "skipped: not a hostname"
    try:
        text = hosts.read_text()
    except FileNotFoundError:
        text = ""
    except OSError as exc:
        return f"failed: {type(exc).__name__}"
    for line in text.splitlines():
        fields = line.split("#", 1)[0].split()
        if len(fields) >= 2 and name in fields[1:]:
            return "unchanged"
    # Appended in place: Docker and other runtimes bind-mount /etc/hosts, so it cannot be renamed.
    try:
        with hosts.open("a") as handle:
            handle.write(
                ("\n" if text and not text.endswith("\n") else "") + f"{HOSTNAME_ADDRESS}\t{name}\n"
            )
    except OSError as exc:
        return f"failed: {type(exc).__name__}"
    return "mapped"


def own_root_directory(root: Path = Path("/"), uid: int = 0, gid: int = 0) -> str:
    """Give ``root`` to ``uid``:``gid`` (root) if another user owns it. Returns what it did."""
    try:
        st = os.stat(root)
        if (st.st_uid, st.st_gid) == (uid, gid):
            return "unchanged"
        os.chown(root, uid, gid)
    except OSError as exc:
        return f"failed: {type(exc).__name__}"
    return f"owner was {st.st_uid}:{st.st_gid}"


def prepare() -> dict[str, str]:
    """Everything above, in a container (the supervisor runs as root)."""
    return {"hostname": map_hostname(), "root": own_root_directory()}
