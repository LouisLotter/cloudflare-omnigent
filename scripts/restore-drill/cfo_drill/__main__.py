"""Command line of the restore drill, run inside the server container.

python -m cfo_drill drill [--canaries FILE|-] [--conversation HEX]... [--txid N]
                          [--deadline S] [--out FILE] [--keep]
    Restore the replica beside the server and check it (cfo_drill.drill). Prints the
    report; exit 0 when every check passed, 1 when one failed, 2 when it could not run.
python -m cfo_drill position
    One Litestream sync without ``wait``: the local and the replicated position.
python -m cfo_drill query SQL [PARAMS_JSON]
    A read-only query on the live database, rows as JSON (bytes as hex). For the tests.
python -m cfo_drill seed MEGABYTES
    Grow the live database with filler rows (cfo_drill.filler). For measurements only.
python -m cfo_drill harness
    The staging measurement harness (cfo_drill.harness).
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

from cfo_drill import db, drill


def _jsonable(value: Any) -> Any:
    if isinstance(value, bytes | bytearray | memoryview):
        return bytes(value).hex()
    return value


def _cmd_drill(args: argparse.Namespace) -> int:
    canaries: list[db.Canary] = []
    conversations: list[str] = list(args.conversation or [])
    if args.canaries:
        text = sys.stdin.read() if args.canaries == "-" else Path(args.canaries).read_text()
        manifest = json.loads(text)
        canaries = [db.Canary.from_json(c) for c in manifest.get("canaries", [])]
        conversations += [c for c in manifest.get("conversations", []) if c]
    try:
        report = drill.run_drill(
            canaries=canaries,
            conversations=conversations,
            txid=args.txid,
            deadline_s=args.deadline,
            keep=args.keep,
        )
    except drill.DrillError as exc:
        print(json.dumps({"kind": "restore-drill", "ok": False, "error": str(exc)}))
        return 2
    text = drill.dumps(report)
    if args.out:
        Path(args.out).write_text(text + "\n")
    print(text)
    return 0 if report["ok"] else 1


def _cmd_position(_: argparse.Namespace) -> int:
    from cfo_server.litestream import BlockingClient

    with BlockingClient(str(drill.LITESTREAM_SOCKET), str(drill.DB_PATH)) as client:
        result = client.sync()
    print(json.dumps({"txid": result.txid, "replicated_txid": result.replicated_txid}))
    return 0


def _cmd_query(args: argparse.Namespace) -> int:
    params = json.loads(args.params) if args.params else []
    conn = db.connect_readonly(drill.DB_PATH)
    try:
        rows = conn.execute(args.sql, params).fetchall()
    finally:
        conn.close()
    print(json.dumps([[_jsonable(v) for v in row] for row in rows]))
    return 0


def _cmd_seed(args: argparse.Namespace) -> int:
    from cfo_drill import filler

    print(json.dumps(filler.seed(drill.DB_PATH, args.megabytes)))
    return 0


def _cmd_harness(_: argparse.Namespace) -> int:
    from cfo_drill import harness

    return harness.main()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="cfo_drill")
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("drill")
    p.add_argument("--canaries")
    p.add_argument("--conversation", action="append")
    p.add_argument("--txid", type=int)
    p.add_argument("--deadline", type=float, default=drill.DEFAULT_DEADLINE_S)
    p.add_argument("--out")
    p.add_argument("--keep", action="store_true")
    p.set_defaults(func=_cmd_drill)
    sub.add_parser("position").set_defaults(func=_cmd_position)
    p = sub.add_parser("query")
    p.add_argument("sql")
    p.add_argument("params", nargs="?")
    p.set_defaults(func=_cmd_query)
    p = sub.add_parser("seed")
    p.add_argument("megabytes", type=float)
    p.set_defaults(func=_cmd_seed)
    sub.add_parser("harness").set_defaults(func=_cmd_harness)
    args = parser.parse_args(argv)
    return int(args.func(args))


if __name__ == "__main__":
    sys.exit(main())
