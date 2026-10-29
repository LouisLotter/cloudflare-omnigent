"""The supervisor's start fixes inside the image, as root (WP3.22, WP3.27).

Run the suite under a 64-character hostname, as a Cloudflare ``durable_object`` container has
(``docker run --hostname "$(openssl rand -hex 32)"``, docs/testing.md). Docker maps the hostname
in ``/etc/hosts`` on a network and gives ``/`` to root, so each test first puts the container as
Cloudflare left it (checking that the symptom shows), then applies the fix and restores the
container afterwards. On Cloudflare ``/etc/hosts`` is a read-only overlay mount that does not
name the host (the 28 Oct sitting): the image resolves the name through NSS ``myhostname``
instead, which the read-only case checks, with Docker's ``-v <file>:/etc/hosts:ro`` or, in a
privileged run, a read-only bind mount the test makes itself. The container suite
(``images/computer/integration``) checks the same under the real supervisor, with Claude Code's
messaging sockets.
"""

from __future__ import annotations

import contextlib
import os
import socket
import subprocess
import tempfile
from collections.abc import Iterator
from pathlib import Path

import pytest

from cfo_computer import startup

HOSTS = Path("/etc/hosts")
NSSWITCH = Path("/etc/nsswitch.conf")
NAME = socket.gethostname()


def _sudo_stderr() -> str:
    return subprocess.run(
        ["runuser", "-u", "omnigent", "--", "sudo", "-n", "true"],
        capture_output=True,
        text=True,
        timeout=60,
        check=True,
    ).stderr


def _without_name(text: str) -> str:
    return "".join(
        line
        for line in text.splitlines(keepends=True)
        if NAME not in line.split("#", 1)[0].split()[1:]
    )


def _maps_name(text: str) -> bool:
    return _without_name(text) != text


def _writable(path: Path) -> bool:
    try:
        with path.open("a"):
            return True
    except OSError:
        return False


@contextlib.contextmanager
def _nss(hosts_line: str) -> Iterator[None]:
    original = NSSWITCH.read_text()
    lines = [hosts_line if line.startswith("hosts:") else line for line in original.splitlines()]
    try:
        NSSWITCH.write_text("\n".join(lines) + "\n")
        yield
    finally:
        NSSWITCH.write_text(original)


@contextlib.contextmanager
def _unmapped_hosts() -> Iterator[None]:
    """``/etc/hosts`` without the hostname: rewritten if Docker left it writable, kept if it is
    already a read-only file without the name."""
    if not _writable(HOSTS):
        yield
        return
    original = HOSTS.read_text()
    try:
        HOSTS.write_text(_without_name(original))
        yield
    finally:
        HOSTS.write_text(original)


@contextlib.contextmanager
def _read_only_hosts() -> Iterator[None]:
    """``/etc/hosts`` read-only and without the hostname, as Cloudflare mounts it."""
    if not _writable(HOSTS):
        yield
        return
    with tempfile.TemporaryDirectory() as scratch:
        copy = Path(scratch) / "hosts"
        copy.write_text(_without_name(HOSTS.read_text()))
        mounted = subprocess.run(["mount", "--bind", str(copy), str(HOSTS)], capture_output=True)
        if mounted.returncode != 0:
            pytest.skip("run with --privileged, or with -v <file>:/etc/hosts:ro")
        try:
            subprocess.run(["mount", "-o", "remount,ro,bind", str(HOSTS)], check=True)
            yield
        finally:
            subprocess.run(["umount", str(HOSTS)], check=True)


def test_the_image_resolves_its_hostname_through_nss_myhostname() -> None:
    assert len(NAME) == 64, "run the suite under a Durable Object's 64-character hostname"
    hosts_line = next(
        line for line in NSSWITCH.read_text().splitlines() if line.startswith("hosts:")
    )
    assert hosts_line.split() == ["hosts:", "files", "myhostname", "dns"]
    assert Path("/usr/lib/x86_64-linux-gnu/libnss_myhostname.so.2").exists()
    with _unmapped_hosts():
        assert not _maps_name(HOSTS.read_text())
        assert _sudo_stderr() == ""
        assert startup.hostname_resolution() == "resolved"
        assert startup.resolve_hostname() == "resolved"


def test_without_myhostname_the_symptom_shows_and_the_mapping_is_the_fallback() -> None:
    if not _writable(HOSTS):
        pytest.skip("/etc/hosts is read-only here: the fallback cannot map it")
    original = HOSTS.read_text()
    try:
        with _nss("hosts:          files dns"):
            HOSTS.write_text(_without_name(original))
            assert f"unable to resolve host {NAME}" in _sudo_stderr()
            assert startup.hostname_resolution() == "unresolved"
            assert startup.resolve_hostname() == "unresolved, /etc/hosts mapped"
            assert _sudo_stderr() == ""
            assert startup.hostname_resolution() == "resolved"
            assert startup.map_hostname() == "unchanged"
            mapped = [line for line in HOSTS.read_text().splitlines() if NAME in line.split()]
            assert mapped == [f"127.0.1.1\t{NAME}"]
    finally:
        HOSTS.write_text(original)


def test_with_a_read_only_etc_hosts_as_on_cloudflare_sudo_is_quiet_and_status_resolved() -> None:
    with _read_only_hosts():
        assert not _writable(HOSTS)
        assert not _maps_name(HOSTS.read_text())
        assert _sudo_stderr() == ""
        assert startup.hostname_resolution() == "resolved"
        # The start fix finds it resolved and never tries the read-only file.
        assert startup.resolve_hostname() == "resolved"
        # Asked to anyway, the mapping is best-effort: reported, never raised.
        assert startup.map_hostname().startswith("failed: ")


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
