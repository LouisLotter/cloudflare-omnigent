"""Drive the real `claude auth login --claudeai` through a terminal, against the fake Anthropic
endpoint, as the owner does in the setup terminal: wait for the sign-in link, then paste a
synthetic authorization code with the link's state (spike S6 follow-up). Prints only whether
the prompt appeared and the exit code; never the link, the code or any output text.

  python3 -I pty_claude_login.py [--timeout 90]
"""

from __future__ import annotations

import argparse
import json
import os
import pty
import re
import select
import time
import urllib.parse


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--timeout", type=float, default=90)
    a = ap.parse_args()
    pid, fd = pty.fork()
    if pid == 0:
        os.execvp("claude", ["claude", "auth", "login", "--claudeai"])
    buf = b""
    pasted = False
    deadline = time.time() + a.timeout
    status = None
    while time.time() < deadline:
        r, _, _ = select.select([fd], [], [], 0.5)
        if r:
            try:
                chunk = os.read(fd, 65536)
            except OSError:
                break
            if not chunk:
                break
            buf += chunk
        text = re.sub(r"\x1b\[[0-9;?]*[A-Za-z]", "", buf.decode(errors="replace")).replace("\r", "").replace("\n", "")
        if not pasted:
            m = re.search(r"https://\S*?[?&]state=([A-Za-z0-9_\-]+)", text)
            if m and "aste" in text:
                state = urllib.parse.unquote(m.group(1))
                time.sleep(0.5)
                os.write(fd, f"s6-synthetic-code#{state}\r".encode())
                pasted = True
        done, st = os.waitpid(pid, os.WNOHANG)
        if done:
            status = st
            break
    if status is None:
        os.kill(pid, 9)
        _, status = os.waitpid(pid, 0)
    code = os.waitstatus_to_exitcode(status)
    print(json.dumps({"login_prompt_seen": pasted, "code_pasted": pasted, "login_exit": code}))
    return 0 if pasted and code == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
