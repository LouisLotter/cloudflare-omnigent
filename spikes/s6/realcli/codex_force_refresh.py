"""Ask the real Codex to refresh its login now, through `codex app-server` (spike S6).

Sends initialize, initialized and `account/read` with refreshToken=true over stdio JSON-RPC,
which runs Codex's normal refresh-token flow and rewrites ~/.codex/auth.json. Prints only
whether the call succeeded and the account type; never account details or tokens.

  python3 -I codex_force_refresh.py [--timeout 60]
"""

from __future__ import annotations

import argparse
import json
import os
import queue
import subprocess
import sys
import threading
import time


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--timeout", type=float, default=60)
    a = ap.parse_args()
    auth = os.path.expanduser(os.path.join(os.environ.get("CODEX_HOME", "~/.codex"), "auth.json"))

    def mtime() -> int | None:
        try:
            return os.stat(auth).st_mtime_ns
        except FileNotFoundError:
            return None

    before = mtime()
    proc = subprocess.Popen(["codex", "app-server"], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                            stderr=subprocess.DEVNULL, text=True, bufsize=1)
    lines: queue.Queue[str] = queue.Queue()
    threading.Thread(target=lambda: [lines.put(x) for x in proc.stdout], daemon=True).start()

    def send(obj: dict) -> None:
        proc.stdin.write(json.dumps(obj) + "\n")
        proc.stdin.flush()

    def wait_for(msg_id: int) -> dict | None:
        deadline = time.time() + a.timeout
        while time.time() < deadline:
            try:
                msg = json.loads(lines.get(timeout=max(0.1, deadline - time.time())))
            except (queue.Empty, ValueError):
                continue
            if msg.get("id") == msg_id:
                return msg
        return None

    result = {"initialized": False, "refresh_requested": True, "ok": False}
    try:
        send({"method": "initialize", "id": 0, "params": {"clientInfo": {"name": "cfo_s6_spike", "title": "S6 spike", "version": "0.0.1"}}})
        result["initialized"] = wait_for(0) is not None
        send({"method": "initialized", "params": {}})
        send({"method": "account/read", "id": 1, "params": {"refreshToken": True}})
        resp = wait_for(1)
        if resp is None:
            result["error"] = "timeout"
        elif "error" in resp:
            result["error"] = str(resp["error"].get("message", "error"))[:200]
        else:
            account = (resp.get("result") or {}).get("account") or {}
            result.update(ok=True, account_type=account.get("type"))
    finally:
        proc.terminate()
        try:
            proc.wait(5)
        except subprocess.TimeoutExpired:
            proc.kill()
    result["auth_json_rewritten"] = before is not None and mtime() != before
    print(json.dumps(result))
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
