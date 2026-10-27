"""The supervisor's start fixes inside the image, as root (WP3.22).

Run the suite under a 64-character hostname, as a Cloudflare ``durable_object`` container has
(``docker run --hostname "$(openssl rand -hex 32)"``, docs/testing.md). Docker maps the hostname
in ``/etc/hosts`` on a network and gives ``/`` to root, so each test first puts the container as
Cloudflare left it (checking that the symptom shows), then applies the fix and restores the
container afterwards. The container suite (``images/computer/integration``) checks the same under
the real supervisor, with Claude Code's messaging sockets.
"""

from __future__ import annotations

import os
import socket
import subprocess
from pathlib import Path

from cfo_computer import startup


def _sudo_stderr() -> str:
    return subprocess.run(
        ["runuser", "-u", "omnigent", "--", "sudo", "-n", "true"],
        capture_output=True,
        text=True,
        timeout=60,
        check=True,
    ).stderr


def test_sudo_resolves_the_hostname_once_the_supervisor_maps_it() -> None:
    hosts = Path("/etc/hosts")
    original = hosts.read_text()
    name = socket.gethostname()
    try:
        unmapped = [
            line
            for line in original.splitlines(keepends=True)
            if name not in line.split("#", 1)[0].split()[1:]
        ]
        hosts.write_text("".join(unmapped))
        assert f"unable to resolve host {name}" in _sudo_stderr()
        assert startup.map_hostname() == "mapped"
        assert _sudo_stderr() == ""
        assert startup.map_hostname() == "unchanged"
        mapped = [line for line in hosts.read_text().splitlines() if name in line.split()]
        assert mapped == [f"127.0.1.1\t{name}"]
    finally:
        hosts.write_text(original)


def test_the_root_directory_goes_back_to_root() -> None:
    before = os.stat("/")
    try:
        os.chown("/", 2346, 2346)
        assert startup.own_root_directory() == "owner was 2346:2346"
        assert (os.stat("/").st_uid, os.stat("/").st_gid) == (0, 0)
        assert os.stat("/").st_mode == before.st_mode
        assert startup.own_root_directory() == "unchanged"
    finally:
        os.chown("/", before.st_uid, before.st_gid)
