"""A stand-in for WorkspaceDO's side of the computer API, for the container tests.

Serves ``POST /v1/messages`` on port 80 (the network alias ``computer.internal``), answers per
the contract and appends every message to /tmp/messages.jsonl, which the tests read. Launch
tokens never pass through here (they travel only in commands to the supervisor).
"""

import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_POST(self):  # noqa: N802
        message = json.loads(self.rfile.read(int(self.headers["content-length"])))
        with open("/tmp/messages.jsonl", "a") as fh:
            fh.write(json.dumps(message) + "\n")
        kind = message["type"]
        reply = {
            "hello": {"type": "hello", "protocolVersion": 1},
            "report": {"type": "report", "appliedSeq": message.get("report", {}).get("seq", 0)},
            "save_request": {"type": "save_request", "outcome": "accepted"},
            "credential_checkpoint": {"type": "credential_checkpoint", "outcome": "superseded", "checkpointId": None},
        }[kind]
        data = json.dumps(reply).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *args):
        return


ThreadingHTTPServer(("0.0.0.0", 80), Handler).serve_forever()
