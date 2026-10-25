"""The container's main process: ``python3 -I -m cfo_computer.main`` under tini.

tini is PID 1 and the supervisor its only child, so the supervisor's death ends the container
(FH-34): WorkspaceDO then records an unexpected stop, and the next wake starts a new generation
with a new token. tini forwards SIGTERM to the supervisor alone (no ``-g``); the workload, the
guard and the capture worker each run in their own session.
"""

from __future__ import annotations

import os
import signal
import sys
import threading
from pathlib import Path

from .api import ComputerApi
from .contract import Contract
from .paths import (
    COMPUTER_API_URL,
    ENV_COMPUTER_ID,
    ENV_GENERATION,
    SUPERVISOR_API_PORT,
    TERMINAL_PORT,
    Account,
    Layout,
)
from .policy import Policy
from .server import CommandServer
from .supervisor import Supervisor, Tools

WORKLOAD_CGROUP = "/sys/fs/cgroup/workload"


def workload_cgroup() -> str | None:
    """The cgroup v2 freezer, where the cgroup filesystem is writable (Cloudflare: yes, S3);
    otherwise None, and captures pause with SIGSTOP."""
    try:
        os.makedirs(WORKLOAD_CGROUP, exist_ok=True)
    except OSError:
        return None
    if os.access(os.path.join(WORKLOAD_CGROUP, "cgroup.freeze"), os.W_OK):
        return WORKLOAD_CGROUP
    return None


def under_container_init() -> bool:
    """Whether this process is the only child of the image's init (tini): only then may a
    capture pause every other process in the PID namespace."""
    try:
        init = Path("/proc/1/comm").read_text().strip()
    except OSError:
        return False
    return os.getppid() == 1 and init in ("tini", "docker-init")


def terminal_argv(port: int = TERMINAL_PORT) -> list[str]:
    """ttyd for the setup page's terminal: one writable client at a time, a login shell."""
    return ["/usr/local/bin/ttyd", "--port", str(port), "--writable", "--max-clients", "1", "bash", "-l"]


def main() -> int:
    computer_id = os.environ.get(ENV_COMPUTER_ID, "")
    try:
        generation = int(os.environ.get(ENV_GENERATION, ""))
    except ValueError:
        print("cfo-supervisor: CFO_GENERATION is missing or invalid", file=sys.stderr)
        return 78
    layout = Layout()
    contract = Contract(layout.schema_dir)
    try:
        contract.schemas.validate(
            "InterceptProps",
            {"propsVersion": 1, "computerId": computer_id, "generation": generation, "hostId": None},
        )
    except Exception:  # noqa: BLE001
        print("cfo-supervisor: CFO_COMPUTER_ID or CFO_GENERATION is invalid", file=sys.stderr)
        return 78
    policy = Policy.load(layout.policy_file)
    account = Account.lookup()
    supervisor = Supervisor(
        computer_id=computer_id,
        generation=generation,
        layout=layout,
        account=account,
        contract=contract,
        policy=policy,
        api=ComputerApi(COMPUTER_API_URL, contract),
        tools=Tools(terminal=terminal_argv() if os.path.exists("/usr/local/bin/ttyd") else None),
        cgroup_dir=workload_cgroup(),
        whole_container=under_container_init(),
    )
    server = CommandServer(("0.0.0.0", SUPERVISOR_API_PORT), supervisor)

    def on_sigterm(_signum: int, _frame: object) -> None:
        threading.Thread(target=supervisor.request_save, name="sigterm", daemon=True).start()

    signal.signal(signal.SIGTERM, on_sigterm)
    supervisor.start_loops()
    print(
        f"cfo-supervisor: serving on {SUPERVISOR_API_PORT}, generation {generation}, "
        f"pause by {'cgroup' if supervisor.cgroup_dir else 'SIGSTOP'}",
        file=sys.stderr,
        flush=True,
    )
    server.serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
