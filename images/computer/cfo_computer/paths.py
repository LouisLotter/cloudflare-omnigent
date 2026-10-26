"""Where the supervisor keeps things on a computer, and the names 3.C fixed.

Everything the supervisor writes for itself lives under ``/var/cfo`` (root only), on the same
filesystem as the home directory, so a staged layer can hard-link the kept snapshot and a
restore can move whole roots into place by rename. ``$TMPDIR`` (``/tmp``) is outside every
checkpointed root (S6's follow-up): Claude-native's bridge and the host's credential-broker
socket live there and are never captured.
"""

from __future__ import annotations

import os
import pwd
from dataclasses import dataclass
from pathlib import Path

#: The computer API (contracts/src/computer-protocol.ts).
COMPUTER_API_URL = "http://computer.internal/v1/messages"
SUPERVISOR_API_PORT = 8090
SUPERVISOR_COMMANDS_PATH = "/v1/commands"
OMNIGENT_INTERNAL_URL = "http://omnigent.internal"
ENV_COMPUTER_ID = "CFO_COMPUTER_ID"
ENV_GENERATION = "CFO_GENERATION"

#: The person's account on the computer: the host, runners, CLIs and terminal run as it.
WORKLOAD_USER = "omnigent"
#: The setup terminal's port (proposed name; the platform reaches it over the container port).
TERMINAL_PORT = 7681


@dataclass(frozen=True)
class Layout:
    """The supervisor's directories. Tests root them under a temporary directory."""

    home: Path = Path("/home/omnigent")
    state: Path = Path("/var/cfo")
    log: Path = Path("/var/log/cfo")
    contracts: Path = Path("/opt/cfo/contracts")

    @property
    def snapshot(self) -> Path:
        """The kept snapshot: the last cut, kept for the container's life (capture step 7)."""
        return self.state / "snapshot"

    @property
    def staged(self) -> Path:
        """Staged layers, ``staged/<layerId>``, which WorkspaceDO uploads with DirectoryBackup."""
        return self.state / "staged"

    @property
    def restore(self) -> Path:
        """Where WorkspaceDO restores each layer with DirectoryBackup (``layerDirs``)."""
        return self.state / "restore"

    @property
    def merge(self) -> Path:
        return self.state / "merge"

    @property
    def replaced(self) -> Path:
        return self.state / "replaced"

    @property
    def credentials_staging(self) -> Path:
        return self.state / "credentials-staging"

    @property
    def scratch(self) -> Path:
        return self.state / "scratch"

    @property
    def data(self) -> Path:
        """The published index, a pending one, and the hash cache."""
        return self.state / "data"

    @property
    def schema_dir(self) -> Path:
        return self.contracts / "schema"

    @property
    def policy_file(self) -> Path:
        return self.contracts / "checkpoint-policy-v1.json"

    def ensure(self) -> None:
        for d in (
            self.state,
            self.snapshot,
            self.staged,
            self.restore,
            self.merge,
            self.replaced,
            self.credentials_staging,
            self.scratch,
            self.data,
            self.log,
        ):
            d.mkdir(parents=True, exist_ok=True)
            if os.geteuid() == 0:
                os.chmod(d, 0o700)


@dataclass(frozen=True)
class Account:
    """The workload account's identity."""

    name: str
    uid: int
    gid: int
    home: Path

    @classmethod
    def lookup(cls, name: str = WORKLOAD_USER) -> Account:
        entry = pwd.getpwnam(name)
        return cls(name, entry.pw_uid, entry.pw_gid, Path(entry.pw_dir))

    @classmethod
    def current(cls, home: Path) -> Account:
        """The test process's own account, for tests that run without root."""
        return cls(pwd.getpwuid(os.getuid()).pw_name, os.getuid(), os.getgid(), home)
