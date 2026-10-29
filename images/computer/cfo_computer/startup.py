"""What the supervisor puts right in its container, as root, before anything else starts (WP3.22).

Cloudflare's ``durable_object`` containers differ from Docker's in two ways the workload notices
(the 27 Oct 2026 staging sitting):

- **The hostname is not in /etc/hosts.** It is the Durable Object's ID, 64 hex characters, and
  nothing maps it, so every ``sudo`` printed "unable to resolve host <hostname>". There,
  ``/etc/hosts`` is a read-only overlay mount (the 28 Oct sitting), so it cannot be mapped
  (WP3.27). The image resolves the name instead through NSS ``myhostname``
  (``hosts: files myhostname dns``, set at build time). The start checks that it resolves, and
  only if it does not (an image without ``myhostname``) maps it in ``/etc/hosts`` to
  127.0.1.1, as Debian maps its own hostname, where that file can be written.
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
import threading
from collections.abc import Callable
from pathlib import Path

HOSTS = Path("/etc/hosts")
HOSTNAME_ADDRESS = "127.0.1.1"
_HOSTNAME = re.compile(r"[A-Za-z0-9](?:[A-Za-z0-9.-]{0,252})")
#: A lookup that has not answered by then is reported as ``unknown``: a status read never waits
#: on a slow DNS server (``myhostname`` answers before DNS is asked).
RESOLVE_TIMEOUT_S = 2.0
_NOT_FOUND = {socket.EAI_NONAME, getattr(socket, "EAI_NODATA", socket.EAI_NONAME)}
#: At most one lookup at a time: a timeout cannot stop a lookup's thread, so while one still
#: hangs, the next status read says ``unknown`` at once instead of starting another (Codex
#: WP3.27 r1, optional): hung lookups never pile up.
_IN_FLIGHT: list[threading.Thread] = []
_IN_FLIGHT_LOCK = threading.Lock()


def hostname_resolution(name: str | None = None, timeout: float = RESOLVE_TIMEOUT_S) -> str:
    """Whether this container's hostname resolves through the C library (NSS), as ``sudo``
    resolves it: ``resolved``, ``unresolved``, or ``unknown`` (no name, or no answer in time)."""
    try:
        name = socket.gethostname() if name is None else name
        # Bytes: Python's IDNA codec refuses a label over 63 characters, and a Durable Object's
        # hostname is 64.
        host = name.encode("ascii")
    except (OSError, UnicodeError):
        return "unknown"
    if not name:
        return "unknown"
    answer: list[str] = []

    def lookup() -> None:
        try:
            socket.getaddrinfo(host, None)
            answer.append("resolved")
        except socket.gaierror as exc:
            answer.append("unresolved" if exc.errno in _NOT_FOUND else "unknown")
        except (OSError, UnicodeError):
            answer.append("unknown")

    with _IN_FLIGHT_LOCK:
        if any(t.is_alive() for t in _IN_FLIGHT):
            return "unknown"
        worker = threading.Thread(target=lookup, name="cfo-hostname", daemon=True)
        _IN_FLIGHT[:] = [worker]
        worker.start()
    worker.join(timeout)
    return answer[0] if answer else "unknown"


def map_hostname(hosts: Path = HOSTS, hostname: str | None = None) -> str:
    """Map this container's hostname in ``hosts``, once (best-effort: Cloudflare's is read-only).
    Returns what it did."""
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


def resolve_hostname(
    hosts: Path = HOSTS,
    hostname: str | None = None,
    resolution: Callable[[], str] = hostname_resolution,
) -> str:
    """The hostname resolves (NSS ``myhostname``), or else is mapped in ``hosts`` if it can be.
    Returns what holds: ``resolved``, or the resolution and the mapping's outcome."""
    state = resolution()
    if state == "resolved":
        return state
    return f"{state}, /etc/hosts {map_hostname(hosts, hostname)}"


def prepare() -> dict[str, str]:
    """Everything above, in a container (the supervisor runs as root)."""
    return {"hostname": resolve_hostname(), "root": own_root_directory()}
