"""S2 computer supervisor: DNS checks, the raw echo probe, and the Omnigent host with a
conversation driver, all reporting through the private route.
"""

from __future__ import annotations

import asyncio
import threading
import time

import dns_check
import echo_probe
from s2common import report, start_reporter


def dns_checks() -> None:
    dns_check.check("boot")
    time.sleep(20)
    dns_check.check("boot+20s")
    while True:
        time.sleep(1800)
        dns_check.check("periodic")


async def main() -> None:
    report("computer-boot")
    start_reporter()
    threading.Thread(target=dns_checks, name="s2-dns", daemon=True).start()
    tasks = [asyncio.create_task(echo_probe.run(), name="echo")]
    try:
        import omnigent_host

        tasks.append(asyncio.create_task(omnigent_host.run(), name="omnigent"))
    except ImportError:
        report("omnigent-disabled")
    done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_EXCEPTION)
    for task in done:
        report("task-exit", task=task.get_name(), error=repr(task.exception()))


if __name__ == "__main__":
    asyncio.run(main())
