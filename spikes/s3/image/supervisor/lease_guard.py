"""Pause-lease guard: the single authority that stops and resumes the workload.

The capture worker (the lease's controller) starts this guard, waits for
"ready", arms the lease, and then asks the guard to stop each target. The
guard both stops and resumes, in one thread, so a stop can never land after
the guard has resumed (IR-012). An earlier version only resumed: the worker
stopped processes itself, and a worker that stalled between announcing a
target and stopping it could stop it after the lease had expired and then
die, leaving it stopped for good.

The guard resumes everything it stopped:
* when the controller releases the lease in time ("released");
* at the lease deadline, when the controller is too slow or wedged
  ("expired"); from then on every stop request is refused;
* when the controller disappears (its pipe reaches EOF), with a final sweep.

A target is stopped only if it still has the start time the controller saw
(no reused PID), is running (a process someone else stopped stays theirs),
and the lease is live. Resumes check the start time again.

Protocol, one line each. In: ``arm``, ``stop <pid> <starttime>``,
``freeze <cgroup dir>``, ``release``. Out: ``ready``; ``ok stop <pid>`` or
``refused stop <pid> <reason>``; ``ok freeze`` or ``refused freeze <reason>``;
``released`` or ``expired``.
"""

from __future__ import annotations

import argparse
import json
import os
import select
import signal
import sys
import time

from . import procs as P
from .freeze import thaw_cgroup, thaw_pids

# How long the guard lingers after resuming, waiting for the controller's EOF.
LINGER_S = 600.0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--lease-id", required=True)
    ap.add_argument("--budget-s", type=float, required=True)
    ap.add_argument("--log", required=True)
    args = ap.parse_args()

    stopped: dict[int, int] = {}  # pid -> starttime, stopped by us and not yet resumed
    frozen: list[str] = []  # cgroups frozen by us and not yet thawed
    events: list[dict[str, object]] = []
    counts = {"stopped": 0, "refused": 0}
    started = time.monotonic()

    def log(event: str, **kw: object) -> None:
        now = time.monotonic()
        events.append({"t": round(now - started, 4), "mono": now, "event": event, **kw})

    def say(line: str) -> None:
        try:
            sys.stdout.write(line + "\n")
            sys.stdout.flush()
        except BrokenPipeError:
            pass

    def resume(reason: str) -> None:
        t0 = time.monotonic()
        n = thaw_pids(list(stopped.items()))
        stopped.clear()
        for cg in frozen:
            try:
                thaw_cgroup(cg)
            except OSError as exc:
                log("cgroup_thaw_failed", cgroup=cg, error=str(exc))
        ncg = len(frozen)
        frozen.clear()
        log("resumed", reason=reason, resumed=n, cgroups=ncg, thaw_s=round(time.monotonic() - t0, 4))

    def do_stop(pid: int, start: int) -> None:
        if lease_over:
            reason = "expired"
        else:
            st = P.read_stat(pid)
            if st is None:
                reason = "gone"
            elif st[3] != start:
                reason = "identity"  # the PID now belongs to another process
            elif st[0] in ("T", "t"):
                reason = "prestopped"  # stopped by someone else: never ours to resume
            elif st[0] in ("Z", "X"):
                reason = "gone"
            else:
                try:
                    os.kill(pid, signal.SIGSTOP)
                    stopped[pid] = start
                    counts["stopped"] += 1
                    say(f"ok stop {pid}")
                    return
                except ProcessLookupError:
                    reason = "gone"
        counts["refused"] += 1
        say(f"refused stop {pid} {reason}")

    def do_freeze(cg: str) -> None:
        if lease_over:
            say("refused freeze expired")
            return
        try:
            with open(os.path.join(cg, "cgroup.freeze"), "w") as fh:
                fh.write("1")
        except OSError as exc:
            say(f"refused freeze {type(exc).__name__}")
            return
        frozen.append(cg)
        say("ok freeze")

    say("ready")
    log("ready")
    fd = sys.stdin.fileno()
    buf = b""
    deadline: float | None = None
    outcome = "unknown"
    lease_over = False
    linger_until: float | None = None

    def check_deadline() -> None:
        nonlocal lease_over, outcome, linger_until
        if not lease_over and deadline is not None and time.monotonic() >= deadline:
            resume("lease_expired")
            lease_over = True
            outcome = "expired"
            linger_until = time.monotonic() + LINGER_S
            say("expired")

    while True:
        check_deadline()
        now = time.monotonic()
        if linger_until is not None and now >= linger_until:
            log("linger_timeout")
            break
        if deadline is not None and not lease_over:
            timeout = max(0.0, deadline - now)
        elif linger_until is not None:
            timeout = max(0.0, linger_until - now)
        else:
            timeout = None
        ready, _, _ = select.select([fd], [], [], timeout)
        if not ready:
            continue
        chunk = os.read(fd, 65536)
        if not chunk:
            # Controller gone: resume whatever is still ours (a final sweep).
            if not lease_over:
                outcome = "controller_lost"
            resume("controller_lost" if outcome == "controller_lost" else "final_sweep")
            break
        buf += chunk
        while b"\n" in buf:
            line, _, buf = buf.partition(b"\n")
            parts = line.decode().split()
            if not parts:
                continue
            # Every action is checked against the deadline first, in this thread.
            check_deadline()
            if parts[0] == "arm" and deadline is None:
                deadline = time.monotonic() + args.budget_s
                log("armed", budget_s=args.budget_s)
            elif parts[0] == "stop":
                do_stop(int(parts[1]), int(parts[2]))
            elif parts[0] == "freeze":
                do_freeze(parts[1])
            elif parts[0] == "release":
                if lease_over:
                    say(outcome)
                else:
                    resume("released")
                    lease_over = True
                    outcome = "released"
                    linger_until = time.monotonic() + LINGER_S
                    say("released")
    log("exit", outcome=outcome, **counts)
    tmp = args.log + ".tmp"
    with open(tmp, "w") as fh:
        json.dump({"lease_id": args.lease_id, "outcome": outcome, "events": events}, fh, indent=1)
    os.rename(tmp, args.log)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
