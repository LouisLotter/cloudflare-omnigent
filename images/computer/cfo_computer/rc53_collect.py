"""RC-53's value collector, inside a computer: every live token the scan must not find.

    sudo python3 -I -m cfo_computer.rc53_collect PATH...   (collect, then scan PATHs)

Run as root inside a computer during a staging check. The check is opt-in: once
``/var/cfo/rc53/enabled`` exists (``sudo touch`` it from the setup terminal), the supervisor runs
this before every capture and the capture worker scans each staged layer with the values before
reporting it staged, recording only counts. It gathers, without printing any:
- every process environment variable whose name says token, key, secret or auth (the launch
  token ``OMNIGENT_HOST_TOKEN``, runner binding tokens, delegated owner tokens);
- every string value of 16 characters or more in the native harnesses' bridge files, in the
  home and under ``$TMPDIR`` (policy hook headers, bridge, relay, router and serve tokens, the
  provider key, Claude-native's hooks and ``apiKeyHelper``);
- every string value of 16 characters or more in the declared login files;
- the GitHub token the host's credential broker hands git, if one is linked.
The values exist only in memory: the supervisor keeps them for the container's life (so every
generation of a rotated token is kept) and hands them to the capture worker on an anonymous
memory descriptor. Nothing here writes a value to disk, argv or a log.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import socket
from pathlib import Path

NAME = re.compile(r"(TOKEN|SECRET|KEY|AUTH|PASSWORD)", re.I)
MIN = 16
HOME = Path("/home/omnigent")
LOGINS = (
    ".claude/.credentials.json",
    ".claude/.device-keys.json",
    ".codex/auth.json",
    ".codex/.credentials.json",
)
BRIDGE_NAMES = {
    "policy_hook.json",
    "bridge.json",
    "server.json",
    "tool_relay.json",
    "tool_relay.env",
    "turn_router.json",
    "subagent_router.json",
    "provider_key",
    "permission_hook.json",
    "claude-settings.json",
}


def strings(value) -> list[str]:
    if isinstance(value, dict):
        return [s for v in value.values() for s in strings(v)]
    if isinstance(value, list):
        return [s for v in value for s in strings(v)]
    if isinstance(value, str):
        out = [value] if len(value) >= MIN else []
        out += [m for m in re.findall(r"Bearer\s+(\S+)", value) if len(m) >= MIN]
        return out
    return []


def from_file(path: Path) -> list[str]:
    try:
        text = path.read_text(errors="replace")
    except OSError:
        return []
    try:
        return strings(json.loads(text))
    except ValueError:
        found = re.findall(r"=['\"]?([^'\"\s]{16,})", text)
        return found or ([text.strip()] if len(text.strip()) >= MIN else [])


def _process_ids(process_scope: set[int] | None) -> list[str]:
    """Every process, or (outside a computer, as in tests) only these trees."""
    if process_scope is None:
        return [p for p in os.listdir("/proc") if p.isdigit()]
    from . import procs as P

    return [str(pid) for pid in P.descendants(P.scan(with_cmdline=False), process_scope)]


def collect(
    home: Path = HOME,
    *,
    tmp_roots: list[Path] | None = None,
    process_scope: set[int] | None = None,
    broker_root: Path | None = None,
) -> set[str]:
    """The live values, in memory.

    ``process_scope``: None reads every process's environment (inside a computer); a set
    reads only those trees. ``tmp_roots``: where the native bridges under ``$TMPDIR`` live
    (``/tmp``). ``broker_root``: where the host's credential-broker sockets live (``/tmp``
    inside a computer); None asks no broker.
    """
    values: set[str] = set()
    for pid in _process_ids(process_scope):
        try:
            environ = Path(f"/proc/{pid}/environ").read_bytes()
        except OSError:
            continue
        for item in environ.split(b"\0"):
            name, _, value = item.decode("utf-8", "replace").partition("=")
            if NAME.search(name) and len(value) >= MIN:
                values.add(value)
    for rel in LOGINS:
        values.update(from_file(home / rel))
    for root in [home / ".omnigent", *(tmp_roots if tmp_roots is not None else [Path("/tmp")])]:
        for dirpath, _dirs, files in os.walk(root):
            for name in files:
                if name in BRIDGE_NAMES or any(
                    name.startswith(f".{b}.") or name.startswith(f"{b}.") for b in BRIDGE_NAMES
                ):
                    values.update(from_file(Path(dirpath, name)))
    if broker_root is not None:
        values.update(github_token(broker_root))
    return {v for v in values if len(v) >= MIN}


def github_token(broker_root: Path) -> list[str]:
    """Ask each credential-broker socket for github.com, as git does (core change 17)."""
    out = []
    for sock in broker_root.glob("omnigent-*/credentials-*.sock"):
        try:
            with socket.socket(socket.AF_UNIX) as s:
                s.settimeout(5)
                s.connect(str(sock))
                s.sendall(b"protocol=https\nhost=github.com\n\n")
                s.shutdown(socket.SHUT_WR)
                reply = b""
                while chunk := s.recv(4096):
                    reply += chunk
        except OSError:
            continue
        for line in reply.decode("utf-8", "replace").splitlines():
            if line.startswith("password=") and len(line) > 9 + MIN:
                out.append(line[9:])
    return out


def main() -> int:
    """Collect the values in memory and scan PATHs with them; print the scan's report only."""
    from . import rc53

    ap = argparse.ArgumentParser()
    ap.add_argument("paths", nargs="+", type=Path)
    args = ap.parse_args()
    values = collect(broker_root=Path("/tmp"))
    code, report = rc53.run(args.paths, sorted(values), [])
    print(json.dumps({"status": code, "values": len(values), **report}, indent=1))
    return code


if __name__ == "__main__":
    raise SystemExit(main())
