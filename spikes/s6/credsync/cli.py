"""Command line for the spike's checkpoint code. Run as: python3 -I credsync/cli.py <command>.

  audit       --home H --label L [--state F] [--out FILE]
  start       --controller DB --computer ID                 new generation (a container start)
  capture     --kind credential|workspace --home H --store S --controller DB --computer ID --generation G
  restore     --home H --staging DIR --store S --controller DB --computer ID
  watch       --home H --store S --controller DB --computer ID --generation G [--settle-ms N]
              [--poll-ms N] [--log FILE] [--duration-s N]
  status      --controller DB --computer ID
  export | import | watch-export   checkpoint transfer over stdio, for staging (see stdio.py)

Store S is "dir:/path" or "s3" (S6_S3_ENDPOINT, S6_S3_BUCKET, S6_S3_ACCESS_KEY, S6_S3_SECRET_KEY).
The controller is a SQLite path. In staging the Durable Object is the store and controller, and
moves checkpoints with export and import over exec() stdio.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from audit import audit  # noqa: E402
from controller import Controller  # noqa: E402
from core import CRED_KIND, WORKSPACE_KIND  # noqa: E402
from objstore import store_from_spec  # noqa: E402
from ops import Computer, CredentialWatcher, RestoreNotDone, capture_credentials, capture_workspace, restore  # noqa: E402


def _controller(spec: str):
    return Controller(Path(spec))


def _comp(a) -> Computer:
    return Computer(a.computer, a.generation, store_from_spec(a.store), _controller(a.controller))


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="credsync")
    sub = p.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("audit")
    s.add_argument("--home", default=os.environ.get("HOME"))
    s.add_argument("--label", required=True)
    s.add_argument("--state")
    s.add_argument("--out")

    s = sub.add_parser("start")
    s.add_argument("--controller", required=True)
    s.add_argument("--computer", required=True)

    for name in ("capture", "restore", "watch"):
        s = sub.add_parser(name)
        s.add_argument("--home", default=os.environ.get("HOME"))
        s.add_argument("--store", required=True)
        s.add_argument("--controller", required=True)
        s.add_argument("--computer", required=True)
        s.add_argument("--generation", type=int, default=0)
        if name == "capture":
            s.add_argument("--kind", choices=[CRED_KIND, WORKSPACE_KIND], required=True)
        if name == "restore":
            s.add_argument("--staging", required=True)
        if name == "watch":
            s.add_argument("--settle-ms", type=float, default=500)
            s.add_argument("--poll-ms", type=float, default=50)
            s.add_argument("--log")
            s.add_argument("--duration-s", type=float, default=0)

    s = sub.add_parser("export")
    s.add_argument("--kind", choices=[CRED_KIND, WORKSPACE_KIND], required=True)
    s.add_argument("--home", default=os.environ.get("HOME"))
    s = sub.add_parser("import")
    s.add_argument("--kind", choices=[CRED_KIND, WORKSPACE_KIND], required=True)
    s.add_argument("--home", default=os.environ.get("HOME"))
    s.add_argument("--staging", required=True)
    s = sub.add_parser("watch-export")
    s.add_argument("--home", default=os.environ.get("HOME"))
    s.add_argument("--settle-ms", type=float, default=500)
    s.add_argument("--poll-ms", type=float, default=50)
    s.add_argument("--log")

    s = sub.add_parser("watch-summary")
    s.add_argument("--log", required=True)

    s = sub.add_parser("status")
    s.add_argument("--controller", required=True)
    s.add_argument("--computer", required=True)

    a = p.parse_args(argv)

    if a.cmd in ("export", "import", "watch-export", "watch-summary"):
        import stdio

        if a.cmd == "watch-summary":
            return stdio.watch_summary(a.log)
        if a.cmd == "export":
            return stdio.export(a.kind, Path(a.home))
        if a.cmd == "import":
            return stdio.import_(a.kind, Path(a.home), Path(a.staging))
        return stdio.watch_export(Path(a.home), a.settle_ms, a.poll_ms, a.log)
    if a.cmd == "audit":
        report = audit(Path(a.home), Path(a.state) if a.state else None, a.label)
        text = json.dumps(report, indent=1)
        if a.out:
            Path(a.out).write_text(text + "\n")
        else:
            print(text)
        return 0
    if a.cmd == "start":
        print(json.dumps({"generation": Controller(Path(a.controller)).start_generation(a.computer)}))
        return 0
    if a.cmd == "status":
        c = _controller(a.controller)
        print(json.dumps({"generation": c.current_generation(a.computer),
                          "credential": c.current(a.computer, CRED_KIND), "workspace": c.current(a.computer, WORKSPACE_KIND),
                          "refusals": c.refusals(a.computer)}))
        return 0

    comp = _comp(a)
    if a.cmd == "capture":
        if a.kind == CRED_KIND:
            try:
                seq, ok, snap = capture_credentials(comp, Path(a.home))
            except RestoreNotDone:
                # Exit 3: refused by the restore gate; this computer's checkpoint is still the
                # latest state, so callers may go on from the checkpoint.
                print(json.dumps({"kind": a.kind, "refused": "the restore has not finished"}))
                return 3
            print(json.dumps({"kind": a.kind, "seq": seq, "published": ok,
                              "files": [{"path": r.path, "state": r.state, "size": r.size, "mode": r.mode} for r in snap.records]}))
        else:
            seq, ok, manifest = capture_workspace(comp, Path(a.home))
            print(json.dumps({"kind": a.kind, "seq": seq, "published": ok, "file_count": manifest["file_count"], "bytes": manifest["bytes"]}))
        return 0 if ok else 1
    if a.cmd == "restore":
        print(json.dumps(restore(comp, Path(a.home), Path(a.staging))))
        return 0
    if a.cmd == "watch":
        logf = open(a.log, "a") if a.log else sys.stdout

        def log(e: dict) -> None:
            logf.write(json.dumps(e) + "\n")
            logf.flush()

        w = CredentialWatcher(comp, Path(a.home), settle_s=a.settle_ms / 1000, poll_s=a.poll_ms / 1000, log=log)
        log({"event": "watching", "settle_ms": a.settle_ms, "poll_ms": a.poll_ms, "at": time.time()})
        deadline = time.time() + a.duration_s if a.duration_s else None
        try:
            w.run(until=(lambda: time.time() >= deadline) if deadline else None)
        except KeyboardInterrupt:
            pass
        return 0
    return 2


if __name__ == "__main__":
    sys.exit(main())
