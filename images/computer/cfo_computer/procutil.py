"""Starting the supervisor's helper processes and the workload.

Helpers (the capture worker, the lease guard) run on the same interpreter in isolated mode
(``-I``), so no environment variable or working directory can put code on their import path;
the package is found from its own location.

Workload processes (Omnigent's host, the setup terminal, the CLIs the supervisor runs) run as
the person's account, in their own session (so a signal to the supervisor's process group never
reaches them), with an environment built from an allowlist, and inside the workload cgroup when
the cgroup freezer is in use, so a capture pauses them and everything they start.
"""

from __future__ import annotations

import os
import subprocess
import sys
from collections.abc import Mapping, Sequence
from pathlib import Path

PACKAGE_PARENT = str(Path(__file__).resolve().parent.parent)

_BOOT = (
    "import runpy, sys; sys.path.insert(0, sys.argv[1]); module = sys.argv[2]; "
    "sys.argv = [module, *sys.argv[3:]]; runpy.run_module(module, run_name='__main__', "
    "alter_sys=True)"
)


def module_argv(module: str, *args: str) -> list[str]:
    """argv that runs ``module`` from this package on this interpreter, isolated."""
    return [sys.executable, "-I", "-c", _BOOT, PACKAGE_PARENT, module, *args]


#: Claude Code's telemetry, error reporting and updates off, in every CLI the computer runs
#: (design, "Network"). Codex's settings are in /etc/codex/managed_config.toml.
CLI_ENV = {
    "DISABLE_TELEMETRY": "1",
    "DISABLE_ERROR_REPORTING": "1",
    "DISABLE_UPDATES": "1",
    "DISABLE_AUTOUPDATER": "1",
}

#: The workload's PATH: Omnigent's environment first (it holds the gh broker wrapper).
WORKLOAD_PATH = "/opt/venv/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"


def workload_env(
    home: Path,
    user: str,
    extra: Mapping[str, str] | None = None,
    *,
    path: str = WORKLOAD_PATH,
) -> dict[str, str]:
    """A fresh environment for a workload process; nothing is inherited from the supervisor.

    So nothing the platform passes the supervisor (the computer's identity, and never a
    platform secret, GitHub App, Databricks or credential-key variable) reaches the workload
    unless it is named here.
    """
    env = {
        "HOME": str(home),
        "USER": user,
        "LOGNAME": user,
        "SHELL": "/bin/bash",
        "PATH": path,
        "LANG": "C.UTF-8",
        "LC_ALL": "C.UTF-8",
        "TMPDIR": "/tmp",
        "IS_SANDBOX": "1",
        **CLI_ENV,
    }
    env.update(extra or {})
    return env


def workload_argv(
    argv: Sequence[str],
    *,
    uid: int,
    gid: int,
    cgroup_dir: str | None,
) -> list[str]:
    """Wrap ``argv`` so it runs as ``uid``/``gid``, inside the workload cgroup if any.

    The wrapper writes its own PID into ``cgroup.procs`` before exec, so the process is in the
    cgroup before it can fork. Without root (tests), argv runs unchanged.
    """
    if os.geteuid() != 0:
        return list(argv)
    join = f'echo $$ > "{cgroup_dir}/cgroup.procs" && ' if cgroup_dir else ""
    drop = f"setpriv --reuid={uid} --regid={gid} --init-groups -- " if uid != 0 else ""
    return ["/bin/sh", "-c", f'{join}exec {drop}"$@"', "workload", *argv]


def spawn_workload(
    argv: Sequence[str],
    *,
    env: Mapping[str, str],
    cwd: Path,
    uid: int,
    gid: int,
    cgroup_dir: str | None,
    stdout: int | object = subprocess.DEVNULL,
    stdin: int | object = subprocess.DEVNULL,
) -> subprocess.Popen[bytes]:
    return subprocess.Popen(
        workload_argv(argv, uid=uid, gid=gid, cgroup_dir=cgroup_dir),
        env=dict(env),
        cwd=str(cwd),
        stdin=stdin,
        stdout=stdout,
        stderr=subprocess.STDOUT if stdout is not subprocess.DEVNULL else subprocess.DEVNULL,
        start_new_session=True,
        close_fds=True,
    )


def run_workload(
    argv: Sequence[str],
    *,
    env: Mapping[str, str],
    cwd: Path,
    uid: int,
    gid: int,
    cgroup_dir: str | None,
    timeout: float,
    on_spawn=None,
) -> tuple[int | None, bytes]:
    """Run a short workload command; (exit status or None on timeout, output)."""
    proc = subprocess.Popen(
        workload_argv(argv, uid=uid, gid=gid, cgroup_dir=cgroup_dir),
        env=dict(env),
        cwd=str(cwd),
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        start_new_session=True,
        close_fds=True,
    )
    if on_spawn is not None:
        on_spawn(proc.pid)
    try:
        out, _ = proc.communicate(timeout=timeout)
        return proc.returncode, out
    except subprocess.TimeoutExpired:
        try:
            os.killpg(proc.pid, 9)
        except ProcessLookupError:
            pass
        proc.communicate()
        return None, b""
