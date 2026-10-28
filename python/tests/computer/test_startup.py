"""The supervisor's start fixes (WP3.22, WP3.27): the hostname resolves, and ``/`` is root's.

Without root here: the image's own suite runs them for real (``images/computer/tests``, also
with a read-only ``/etc/hosts`` as Cloudflare mounts it), and the container suite under the real
supervisor (``images/computer/integration``).
"""

from __future__ import annotations

import os
import socket
import threading
from pathlib import Path

import pytest
from cfo_computer import startup

NAME = "7ab29ab7f43a9ce295b3862f04eb8100952032a17a187857f07bf1d83d957b7a"
DOCKER_HOSTS = (
    "127.0.0.1\tlocalhost\n::1\tlocalhost ip6-localhost ip6-loopback\nfe00::\tip6-localnet\n"
)


def test_reports_whether_the_hostname_resolves_as_sudo_would(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    asked: list[object] = []

    def answer(outcome: object):
        def getaddrinfo(host: object, port: object) -> list[object]:
            asked.append(host)
            if isinstance(outcome, BaseException):
                raise outcome
            return [outcome]

        return getaddrinfo

    monkeypatch.setattr(startup.socket, "getaddrinfo", answer(("addr",)))
    assert startup.hostname_resolution(NAME) == "resolved"
    # As bytes: Python's IDNA codec refuses the 64-character label a Durable Object's name is.
    assert asked == [NAME.encode()]
    for errno in (socket.EAI_NONAME, getattr(socket, "EAI_NODATA", socket.EAI_NONAME)):
        monkeypatch.setattr(startup.socket, "getaddrinfo", answer(socket.gaierror(errno, "no")))
        assert startup.hostname_resolution(NAME) == "unresolved"
    monkeypatch.setattr(
        startup.socket, "getaddrinfo", answer(socket.gaierror(socket.EAI_AGAIN, "later"))
    )
    assert startup.hostname_resolution(NAME) == "unknown"
    monkeypatch.setattr(startup.socket, "getaddrinfo", answer(OSError("odd")))
    assert startup.hostname_resolution(NAME) == "unknown"
    assert startup.hostname_resolution("") == "unknown"
    assert startup.hostname_resolution("é") == "unknown"
    # A lookup that hangs (a slow DNS server) is "unknown" after the timeout, never a stuck read.
    release = threading.Event()
    monkeypatch.setattr(startup.socket, "getaddrinfo", lambda host, port: release.wait(5))
    assert startup.hostname_resolution(NAME, timeout=0.05) == "unknown"
    release.set()
    # This machine's own name, for real: resolved or unresolved, never an exception.
    monkeypatch.undo()
    assert startup.hostname_resolution() in {"resolved", "unresolved", "unknown"}


def test_maps_in_etc_hosts_only_when_the_name_does_not_resolve(tmp_path: Path) -> None:
    hosts = tmp_path / "hosts"
    hosts.write_text(DOCKER_HOSTS)
    assert startup.resolve_hostname(hosts, NAME, lambda: "resolved") == "resolved"
    assert hosts.read_text() == DOCKER_HOSTS
    assert startup.resolve_hostname(hosts, NAME, lambda: "unresolved") == (
        "unresolved, /etc/hosts mapped"
    )
    assert hosts.read_text() == DOCKER_HOSTS + f"127.0.1.1\t{NAME}\n"
    if os.geteuid() != 0:
        # Cloudflare's read-only /etc/hosts: reported, never raised.
        hosts.chmod(0o444)
        assert startup.resolve_hostname(hosts, "other-name", lambda: "unknown") == (
            "unknown, /etc/hosts failed: PermissionError"
        )


def test_maps_a_durable_object_hostname_once(tmp_path: Path) -> None:
    hosts = tmp_path / "hosts"
    hosts.write_text(DOCKER_HOSTS)
    assert startup.map_hostname(hosts, NAME) == "mapped"
    assert startup.map_hostname(hosts, NAME) == "unchanged"
    assert hosts.read_text() == DOCKER_HOSTS + f"127.0.1.1\t{NAME}\n"


def test_keeps_an_existing_mapping_and_ignores_comments(tmp_path: Path) -> None:
    hosts = tmp_path / "hosts"
    docker = DOCKER_HOSTS + f"172.17.0.2\t{NAME}\n"
    hosts.write_text(docker)
    assert startup.map_hostname(hosts, NAME) == "unchanged"
    assert hosts.read_text() == docker
    hosts.write_text(f"127.0.0.1 localhost # {NAME}")  # a comment, and no final newline
    assert startup.map_hostname(hosts, NAME) == "mapped"
    assert hosts.read_text().splitlines()[-1] == f"127.0.1.1\t{NAME}"


def test_creates_a_missing_hosts_file_and_refuses_what_is_not_a_hostname(tmp_path: Path) -> None:
    assert startup.map_hostname(tmp_path / "hosts", NAME) == "mapped"
    for bad in ("", "localhost", "a b", "x\n1.2.3.4 evil", "-x", "a" * 300):
        assert startup.map_hostname(tmp_path / "other", bad) == "skipped: not a hostname"
    assert not (tmp_path / "other").exists()


@pytest.mark.skipif(os.geteuid() == 0, reason="root can write anything")
def test_an_unwritable_hosts_file_is_reported_not_raised(tmp_path: Path) -> None:
    hosts = tmp_path / "hosts"
    hosts.write_text(DOCKER_HOSTS)
    hosts.chmod(0o444)
    assert startup.map_hostname(hosts, NAME) == "failed: PermissionError"


def test_gives_the_root_directory_to_root_only_when_another_user_owns_it(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    me = (os.getuid(), os.getgid())
    assert startup.own_root_directory(tmp_path, *me) == "unchanged"
    calls: list[tuple] = []
    monkeypatch.setattr(startup.os, "chown", lambda *a: calls.append(a))
    other = (me[0] + 4242, me[1] + 4242)
    assert startup.own_root_directory(tmp_path, *other) == f"owner was {me[0]}:{me[1]}"
    assert calls == [(tmp_path, *other)]
    monkeypatch.undo()
    if os.geteuid() != 0:
        assert startup.own_root_directory(tmp_path, *other) == "failed: PermissionError"
    assert startup.own_root_directory(tmp_path / "gone") == "failed: FileNotFoundError"
