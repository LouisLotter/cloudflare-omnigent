"""Pause-lease guard: a separate process that guarantees the resume.

The capture worker (the lease's controller) starts this guard before it pauses
anything, waits for "ready", arms the lease, and then tells the guard every
target before stopping it (write-ahead). The guard resumes everything:

* at once, when the controller disappears (its pipe reaches EOF: the worker
  crashed, was killed, or the supervisor died);
* at the lease deadline, when the controller is still alive but too slow or
  wedged. It answers "expired", and the controller must discard its copy;
* when the controller releases the lease in time. It resumes, then answers
  "released", and the controller's copy is valid.

After it has resumed, the guard stays until the controller's pipe closes and
resumes any target it hears about late: a controller that stops a process
after the deadline (it raced the expiry) must not leave it stopped. Found by
this spike: an earlier version exited at expiry and left a whole workload
stopped when the lease expired before the controller finished freezing.

Protocol on stdin (one line each): ``arm``, ``pid <pid> <starttime>``,
``cgroup <dir>``, ``release``. On stdout: ``ready``, then ``released`` or
``expired``.
"""

from __future__ import annotations

import argparse
import json
import os
import select
import sys
import time

from .freeze import thaw_cgroup, thaw_pids

# How long the guard lingers after resuming, waiting for the controller's EOF.
LINGER_S = 600.0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--lease-id", required=True)
    ap.add_argument("--budget-s", type=float, required=True)
    ap.add_argument("--log", required=True)
    args = ap.parse_args()

    pids: list[tuple[int, int]] = []
    cgroups: list[str] = []
    events: list[dict[str, object]] = []
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
        n = thaw_pids(pids)
        for cg in cgroups:
            try:
                thaw_cgroup(cg)
            except OSError as exc:
                log("cgroup_thaw_failed", cgroup=cg, error=str(exc))
        log("resumed", reason=reason, resumed=n, cgroups=len(cgroups), thaw_s=round(time.monotonic() - t0, 4))

    say("ready")
    log("ready")
    fd = sys.stdin.fileno()
    buf = b""
    deadline: float | None = None
    outcome = "unknown"
    resumed = False
    linger_until: float | None = None
    while True:
        now = time.monotonic()
        if not resumed and deadline is not None and now >= deadline:
            resume("lease_expired")
            resumed = True
            outcome = "expired"
            linger_until = now + LINGER_S
            say("expired")
        if linger_until is not None and now >= linger_until:
            log("linger_timeout")
            break
        if deadline is not None and not resumed:
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
            if not resumed:
                resume("controller_lost")
                outcome = "controller_lost"
            break
        buf += chunk
        while b"\n" in buf:
            line, _, buf = buf.partition(b"\n")
            parts = line.decode().split()
            if not parts:
                continue
            if parts[0] == "arm" and deadline is None:
                deadline = time.monotonic() + args.budget_s
                log("armed", budget_s=args.budget_s)
            elif parts[0] == "pid":
                entry = (int(parts[1]), int(parts[2]))
                pids.append(entry)
                if resumed:
                    # Stopped after the guard resumed: resume it now.
                    log("late_target_resumed", pid=entry[0], resumed=thaw_pids([entry]))
            elif parts[0] == "cgroup":
                cgroups.append(parts[1])
                if resumed:
                    thaw_cgroup(parts[1])
                    log("late_cgroup_resumed", cgroup=parts[1])
            elif parts[0] == "release":
                if resumed:
                    say(outcome if outcome == "expired" else "released")
                else:
                    resume("released")
                    resumed = True
                    outcome = "released"
                    linger_until = time.monotonic() + LINGER_S
                    say("released")
    log("exit", outcome=outcome, pids=len(pids))
    tmp = args.log + ".tmp"
    with open(tmp, "w") as fh:
        json.dump({"lease_id": args.lease_id, "outcome": outcome, "events": events}, fh, indent=1)
    os.rename(tmp, args.log)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
