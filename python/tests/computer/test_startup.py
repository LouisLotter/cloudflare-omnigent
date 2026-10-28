"""The supervisor's start fixes (WP3.22): the hostname resolves, and ``/`` is root's.

Without root here: the image's own suite runs them for real (``images/computer/tests``), and the
container suite under the real supervisor (``images/computer/integration``).
"""

from __future__ import annotations

import os
from pathlib import Path

import pytest
from cfo_computer import startup

NAME = "7ab29ab7f43a9ce295b3862f04eb8100952032a17a187857f07bf1d83d957b7a"
DOCKER_HOSTS = (
    "127.0.0.1\tlocalhost\n::1\tlocalhost ip6-localhost ip6-loopback\nfe00::\tip6-localnet\n"
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
