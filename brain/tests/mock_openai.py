# Copyright 2026 The Senseplane Authors
# SPDX-License-Identifier: Apache-2.0
"""A tiny OpenAI-compatible server for tests and CI: no network, no key.
Replies come from a handler function; every request is recorded (without
headers, so no Authorization value is ever kept)."""

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class MockOpenAI:
    def __init__(self, handler):
        self.handler = handler  # (request json) -> (status, content string)
        self.requests: list[dict] = []
        mock = self

        class H(BaseHTTPRequestHandler):
            def do_POST(self):  # noqa: N802
                body = json.loads(self.rfile.read(int(self.headers["content-length"])))
                mock.requests.append(body)
                status, content = mock.handler(body)
                payload = {"id": "mock", "object": "chat.completion", "model": body["model"],
                           "choices": [{"index": 0, "message": {"role": "assistant", "content": content}, "finish_reason": "stop"}],
                           "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15, "cost": 0.0001}}
                data = json.dumps(payload if status == 200 else {"error": {"message": content}}).encode()
                self.send_response(status)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def log_message(self, *a):
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), H)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.server.server_address[1]}/v1"

    def close(self):
        self.server.shutdown()
