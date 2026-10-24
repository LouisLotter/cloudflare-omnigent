"""WP2.6 staging seeder (test code): a database of a given size in the R2 replica, written by the
server image itself.

It runs the image's own entrypoint as a child (a fresh installation: the owner is created from
the bootstrap credentials), waits for Omnigent to answer, adds conversation items beside it in
transactions of 5,000 until the database file reaches ``SEED_MB`` megabytes, waits until the
replica covers every commit (``/position``: a same-boot ``replicatedTxid`` reaching the
``txid`` read after the last commit), then stops the entrypoint with SIGTERM, which confirms the
final sync and exits 0. ``GET :8080/result`` reports the outcome; it holds sizes and times only.
"""

from __future__ import annotations

import json
import os
import signal
import sqlite3
import subprocess
import sys
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

DB = "/data/omnigent.db"
RESULT: dict[str, object] = {"done": False}

INSERT = """
WITH RECURSIVE n(i) AS (SELECT ? UNION ALL SELECT i + 1 FROM n WHERE i < ?)
INSERT INTO conversation_items (id, conversation_id, response_id, created_at, position, data,
  search_text, created_by, workspace_id, type, status)
SELECT randomblob(16), CAST(printf('seed-conv-%06d', i % 300) AS BLOB),
  printf('resp_%016x', random()), 1700000000 + i, i,
  json_object('type', 'message', 'role', 'assistant', 'content',
    json_array(json_object('type', 'output_text', 'text',
      hex(randomblob(300)) || ' agent conversation computer schedule replica restore' ||
      ' barrier durable window host runner token grant session item turn wake'))),
  hex(randomblob(300)) || ' search text for the seeder',
  'owner', 0, 1 + (i % 11), 1 + (i % 4) FROM n
"""


def say(event: str, **fields: object) -> None:
    print(json.dumps({"cfo": "wp26_seeder", "event": event, **fields}), flush=True)


def get_json(url: str) -> dict:
    with urllib.request.urlopen(url, timeout=10) as response:
        return json.loads(response.read())


def healthy() -> bool:
    try:
        with urllib.request.urlopen("http://127.0.0.1:8000/health", timeout=5) as response:
            return response.status == 200
    except OSError:
        return False


def serve() -> None:
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args: object) -> None:
            pass

        def do_GET(self) -> None:
            body = json.dumps(RESULT).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    ThreadingHTTPServer(("0.0.0.0", 8080), Handler).serve_forever()


def run() -> dict[str, object]:
    target = int(float(os.environ.get("SEED_MB", "1200")) * 1024 * 1024)
    started = time.monotonic()
    child = subprocess.Popen([sys.executable, "-m", "cfo_server.entrypoint"])
    fields: dict[str, object] = {"targetBytes": target}
    try:
        while not healthy():
            if child.poll() is not None:
                return {
                    "ok": False,
                    "detail": f"the server exited {child.returncode}",
                    "fields": fields,
                }
            if time.monotonic() - started > 900:
                return {"ok": False, "detail": "the server never answered", "fields": fields}
            time.sleep(1)
        fields["healthyAfterSeconds"] = round(time.monotonic() - started, 1)
        seeding = time.monotonic()
        conn = sqlite3.connect(DB, timeout=120, isolation_level=None)
        rows = 0
        try:
            while True:
                (pages,) = conn.execute("PRAGMA page_count").fetchone()
                (size,) = conn.execute("PRAGMA page_size").fetchone()
                if pages * size >= target:
                    break
                conn.execute("BEGIN IMMEDIATE")
                conn.execute(INSERT, (rows + 1, rows + 5000))
                conn.execute("COMMIT")
                rows += 5000
        finally:
            conn.close()
        fields.update(
            rows=rows, bytes=pages * size, seedSeconds=round(time.monotonic() - seeding, 1)
        )
        say("seeded", rows=rows, bytes=pages * size)
        catching_up = time.monotonic()
        target_txid = get_json("http://127.0.0.1:8001/position")["txid"]
        while True:
            position = get_json("http://127.0.0.1:8001/position")
            if position["replicatedTxid"] >= target_txid:
                break
            if time.monotonic() - catching_up > 3600:
                return {"ok": False, "detail": "the replica never caught up", "fields": fields}
            time.sleep(1)
        fields["replicatedAfterSeconds"] = round(time.monotonic() - catching_up, 1)
        child.send_signal(signal.SIGTERM)
        code = child.wait(timeout=900)
        fields["exitCode"] = code
        if code != 0:
            return {
                "ok": False,
                "detail": f"the final sync was not confirmed ({code})",
                "fields": fields,
            }
        fields["seconds"] = round(time.monotonic() - started, 1)
        return {"ok": True, "detail": "seeded and replicated", "fields": fields}
    except Exception as exc:  # noqa: BLE001 - reported, the run decides
        return {"ok": False, "detail": f"{type(exc).__name__}: {exc}"[:200], "fields": fields}
    finally:
        if child.poll() is None:
            child.send_signal(signal.SIGTERM)


def main() -> None:
    threading.Thread(target=serve, daemon=True).start()
    outcome = run()
    RESULT.update(outcome, done=True)
    say("done", ok=outcome["ok"], detail=outcome["detail"])
    while True:  # the run removes this container
        time.sleep(3600)


if __name__ == "__main__":
    main()
