"""A fake OpenAI Responses endpoint on loopback, so the real Codex binary can finish one request
against a synthetic ChatGPT login with no network (spike S6 follow-up, DC-45).

Answers POST .../responses with a streamed reply "OK"; every other path gets 404. The log keeps
methods and paths only, never headers or bodies.

  python3 -I fake_openai_responses.py --port 8766 --log /tmp/responses.jsonl
"""

from __future__ import annotations

import argparse
import json
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class Handler(BaseHTTPRequestHandler):
    log_path = "/tmp/responses.jsonl"
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def _log(self, status: int) -> None:
        with open(self.log_path, "a") as f:
            f.write(json.dumps({"at": time.time(), "method": self.command, "path": self.path.split("?")[0],
                                "status": status}) + "\n")

    def _drain(self) -> None:
        n = int(self.headers.get("Content-Length") or 0)
        if n:
            self.rfile.read(n)

    def do_POST(self):
        self._drain()
        if not self.path.split("?")[0].endswith("/responses"):
            return self._not_found()
        self._log(200)
        item = {"type": "message", "role": "assistant", "id": "msg_s6", "status": "completed",
                "content": [{"type": "output_text", "text": "OK", "annotations": []}]}
        usage = {"input_tokens": 1, "input_tokens_details": None, "output_tokens": 1,
                 "output_tokens_details": None, "total_tokens": 2}
        events = [
            {"type": "response.created", "response": {"id": "resp_s6"}},
            {"type": "response.output_item.done", "output_index": 0, "item": item},
            {"type": "response.completed", "response": {"id": "resp_s6", "usage": usage}},
        ]
        raw = "".join(f"event: {e['type']}\ndata: {json.dumps(e)}\n\n" for e in events).encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        self._not_found()

    def _not_found(self):
        self._log(404)
        raw = b'{"error": "fake endpoint"}'
        self.send_response(404)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8766)
    ap.add_argument("--log", default="/tmp/responses.jsonl")
    a = ap.parse_args()
    Handler.log_path = a.log
    ThreadingHTTPServer(("127.0.0.1", a.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
