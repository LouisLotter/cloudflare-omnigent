"""Pause-lease guard: the single authority that stops and resumes the workload (from spike S3).

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
import math
import os
import select
import signal
import sys
import time
from collections.abc import Callable
from contextlib import suppress

from . import procs as P
from .freeze import thaw_cgroup, thaw_pids

# The contract's hard pause ceiling (PauseLease.hardMs <= 40_000).
MAX_BUDGET_S = 40.0
MAX_LINE_BYTES = 4096
MAX_EVENTS = 128
LINGER_S = 600.0
RETRY_THAW_S = 0.05


class ProtocolError(ValueError):
    """Invalid private-controller input; end the lease and thaw before exiting."""


class LeaseGuard:
    def __init__(self, budget_s: float, say: Callable[[str], None]) -> None:
        if not math.isfinite(budget_s) or not 0 < budget_s <= MAX_BUDGET_S:
            raise ValueError("budget must be finite, positive and at most 40 seconds")
        self.budget_s = budget_s
        self.say = say
        self.state = "unarmed"
        self.deadline: float | None = None
        self.linger_until: float | None = None
        self.outcome = "unknown"
        self.stopped: dict[int, int] = {}
        self.frozen: set[str] = set()
        self.events: list[dict[str, object]] = []
        self.counts = {"stopped": 0, "refused": 0}
        self.started = time.monotonic()

    def log(self, event: str, **kw: object) -> None:
        now = time.monotonic()
        # Keep diagnostics bounded even if the controller floods invalid/late requests.
        if len(self.events) >= MAX_EVENTS:
            self.events.pop(0)
        self.events.append({"t": round(now - self.started, 4), "mono": now, "event": event, **kw})

    def resume(self, reason: str) -> None:
        t0 = time.monotonic()
        n = ncg = 0
        for pid, start in list(self.stopped.items()):
            try:
                n += thaw_pids([(pid, start)])
            except OSError as exc:
                # A failure for one target must not prevent recovery of the rest. Keep
                # its identity so the ended lease can retry, including on final exit.
                self.log("process_thaw_failed", pid=pid, error=type(exc).__name__)
            else:
                del self.stopped[pid]
        for cg in list(self.frozen):
            try:
                thaw_cgroup(cg)
            except OSError as exc:
                self.log("cgroup_thaw_failed", error=type(exc).__name__)
            else:
                self.frozen.remove(cg)
                ncg += 1
        self.log(
            "resumed",
            reason=reason,
            resumed=n,
            cgroups=ncg,
            pending=len(self.stopped) + len(self.frozen),
            thaw_s=round(time.monotonic() - t0, 4),
        )

    def end(self, outcome: str) -> None:
        # Transition BEFORE cleanup: a failed resume cannot reactivate stop authority.
        self.state = "ended"
        self.outcome = outcome
        self.linger_until = time.monotonic() + LINGER_S
        self.resume(outcome)

    def check_deadline(self) -> None:
        if self.state == "active" and time.monotonic() >= self.deadline:
            self.end("expired")
            self.say("expired")

    def refusal(self) -> str | None:
        self.check_deadline()
        if self.state == "unarmed":
            return "unarmed"
        if self.state == "ended":
            return "expired"
        return None

    def stop(self, pid: int, start: int) -> None:
        reason = self.refusal()
        if reason is None:
            st = P.read_stat(pid)
            if st is None or st[0] in ("Z", "X"):
                reason = "gone"
            elif st[3] != start:
                reason = "identity"
            elif st[0] in ("T", "t"):
                reason = "prestopped"
            else:
                # Reading process state may have consumed the remaining budget.
                reason = self.refusal()
                if reason is None:
                    try:
                        os.kill(pid, signal.SIGSTOP)
                    except ProcessLookupError:
                        reason = "gone"
                    else:
                        self.stopped[pid] = start
                        self.counts["stopped"] += 1
                        self.say(f"ok stop {pid}")
                        return
        self.counts["refused"] += 1
        self.say(f"refused stop {pid} {reason}")

    def freeze(self, cg: str) -> None:
        reason = self.refusal()
        if reason is not None:
            self.say(f"refused freeze {reason}")
            return
        with open(os.path.join(cg, "cgroup.freeze")) as fh:
            if fh.read(2).strip() == "1":
                self.say("refused freeze prestopped")
                return
        reason = self.refusal()
        if reason is not None:
            self.say(f"refused freeze {reason}")
            return
        with open(os.path.join(cg, "cgroup.freeze"), "w") as fh:
            # Own the cleanup before a write/close that could fail after taking effect.
            self.frozen.add(cg)
            fh.write("1")
        self.say("ok freeze")

    def command(self, line: bytes) -> None:
        if len(line) > MAX_LINE_BYTES:
            raise ProtocolError("command too long")
        try:
            parts = line.decode("utf-8").split()
        except UnicodeDecodeError as exc:
            raise ProtocolError("invalid encoding") from exc
        if not parts:
            return
        self.check_deadline()
        match parts:
            case ["arm"]:
                if self.state == "unarmed":
                    self.deadline = time.monotonic() + self.budget_s
                    self.state = "active"
                    self.log("armed", budget_s=self.budget_s)
                else:
                    self.say(f"refused arm {self.state}")
            case ["stop", pid_text, start_text]:
                try:
                    pid, start = int(pid_text), int(start_text)
                except ValueError as exc:
                    raise ProtocolError("invalid process identity") from exc
                if pid <= 1 or pid == os.getpid() or start < 0:
                    raise ProtocolError("invalid process identity")
                self.stop(pid, start)
            case ["freeze", cg] if "\0" not in cg:
                self.freeze(cg)
            case ["release"]:
                if self.state != "ended":
                    self.end("released")
                self.say(self.outcome)
            case _:
                raise ProtocolError("invalid command")

    def run(self, fd: int) -> int:
        buf = b""
        status = 0
        try:
            self.say("ready")
            self.log("ready")
            while True:
                self.check_deadline()
                now = time.monotonic()
                if self.linger_until is not None and now >= self.linger_until:
                    self.log("linger_timeout")
                    break
                if self.state == "active":
                    timeout = max(0.0, self.deadline - now)
                elif self.linger_until is not None:
                    timeout = max(0.0, self.linger_until - now)
                else:
                    timeout = None
                if self.state == "ended" and (self.stopped or self.frozen):
                    self.resume("retry")
                    timeout = min(timeout, RETRY_THAW_S)
                ready, _, _ = select.select([fd], [], [], timeout)
                if not ready:
                    continue
                chunk = os.read(fd, MAX_LINE_BYTES)
                if not chunk:
                    if self.state != "ended":
                        self.end("controller_lost")
                    break
                buf += chunk
                while b"\n" in buf:
                    line, _, buf = buf.partition(b"\n")
                    self.command(line)
                if len(buf) > MAX_LINE_BYTES:
                    raise ProtocolError("command too long")
        except ProtocolError:
            status = 2
            self.end("protocol_error")
        except Exception as exc:
            status = 2
            self.log("guard_error", error=type(exc).__name__)
            self.end("guard_error")
        finally:
            self.resume("final_sweep")
        if self.stopped or self.frozen:
            status = 2
        self.log("exit", outcome=self.outcome, **self.counts)
        return status


def main() -> int:
    for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(sig, signal.SIG_IGN)
    ap = argparse.ArgumentParser()
    ap.add_argument("--lease-id", required=True)
    ap.add_argument("--budget-s", type=float, required=True)
    ap.add_argument("--log", required=True)
    args = ap.parse_args()

    # A wedged controller may stop reading replies. Its output pipe must never block
    # the guard's only recovery thread; the local deadline/EOF remains authoritative.
    out_fd = sys.stdout.fileno()
    os.set_blocking(out_fd, False)

    def say(line: str) -> None:
        with suppress(BlockingIOError, BrokenPipeError):
            os.write(out_fd, (line + "\n").encode())

    try:
        guard = LeaseGuard(args.budget_s, say)
    except ValueError as exc:
        ap.error(str(exc))
    status = guard.run(sys.stdin.fileno())
    # Persist diagnostics only AFTER the final thaw; log failures cannot strand targets.
    tmp = args.log + ".tmp"
    with open(tmp, "w") as fh:
        json.dump(
            {"lease_id": args.lease_id, "outcome": guard.outcome, "events": guard.events},
            fh,
            indent=1,
        )
    os.rename(tmp, args.log)
    return status


if __name__ == "__main__":
    raise SystemExit(main())
