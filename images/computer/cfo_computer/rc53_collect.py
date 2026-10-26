"""RC-53's value collector, inside a computer: every live token the scan must not find.

    python3 -I -m cfo_computer.rc53_collect [--out /var/cfo/rc53/values]

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
Values accumulate across runs, so every generation of a rotated token is kept. The file is
root-only, outside every checkpointed root, and never leaves the computer.
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


def _process_ids(roots: set[int] | None) -> list[str]:
    """Every process, or (outside a computer, as in tests) only these trees."""
    if roots is None:
        return [p for p in os.listdir("/proc") if p.isdigit()]
    from . import procs as P

    return [str(pid) for pid in P.descendants(P.scan(with_cmdline=False), roots)]


def collect(
    home: Path = HOME, tmp_roots: list[Path] | None = None, roots: set[int] | None = None
) -> set[str]:
    values: set[str] = set()
    for pid in _process_ids(roots):
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
    roots = [home / ".omnigent", *(tmp_roots or [Path("/tmp")])]
    for root in roots:
        for dirpath, _dirs, files in os.walk(root):
            for name in files:
                if name in BRIDGE_NAMES or any(
                    name.startswith(f".{b}.") or name.startswith(f"{b}.") for b in BRIDGE_NAMES
                ):
                    values.update(from_file(Path(dirpath, name)))
    if roots is None:  # inside a computer only: never ask another machine's broker
        values.update(github_token())
    return {v for v in values if len(v) >= MIN}


def github_token() -> list[str]:
    """Ask each credential-broker socket for github.com, as git does (core change 17)."""
    out = []
    for sock in Path("/tmp").glob("omnigent-*/credentials-*.sock"):  # the broker's socket root
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


def refresh(
    out: Path,
    home: Path = HOME,
    tmp_roots: list[Path] | None = None,
    roots: set[int] | None = None,
) -> tuple[int, int]:
    """Add the values found now to ``out`` (0600); (values in all, new ones)."""
    out.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    old = {v for v in out.read_text().splitlines() if v} if out.exists() else set()
    values = old | collect(home, tmp_roots, roots)
    tmp = out.with_suffix(".tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as fh:
        fh.write("\n".join(sorted(values)) + "\n")
    os.replace(tmp, out)
    return len(values), len(values - old)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="/var/cfo/rc53/values", type=Path)
    args = ap.parse_args()
    total, new = refresh(args.out)
    print(json.dumps({"values": total, "new": new}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
