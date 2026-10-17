# Copyright 2026 The Senseplane Authors
# SPDX-License-Identifier: Apache-2.0
"""HTTP endpoints every service exposes: /healthz and /metrics."""

import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread

from prometheus_client import CONTENT_TYPE_LATEST, CollectorRegistry, Gauge, generate_latest
from prometheus_client import gc_collector, platform_collector, process_collector

from . import __version__


class BrainService:
    def __init__(self, port: int = 8070, host: str = "0.0.0.0") -> None:
        self.registry = CollectorRegistry()
        process_collector.ProcessCollector(registry=self.registry)
        platform_collector.PlatformCollector(registry=self.registry)
        gc_collector.GCCollector(registry=self.registry)
        self.up = Gauge("senseplane_brain_up", "Brain service is running", registry=self.registry)
        self.up.set(1)
        service = self

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self) -> None:  # noqa: N802
                if self.path == "/healthz":
                    self._send(200, "application/json", json.dumps({"status": "ok", "version": __version__}).encode())
                elif self.path == "/metrics":
                    self._send(200, CONTENT_TYPE_LATEST, generate_latest(service.registry))
                else:
                    self._send(404, "application/json", b'{"status":"not_found"}')

            def _send(self, status: int, content_type: str, body: bytes) -> None:
                self.send_response(status)
                self.send_header("content-type", content_type)
                self.send_header("content-length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *args: object) -> None:  # keep access logs out of stdout
                pass

        self.server = ThreadingHTTPServer((host, port), Handler)
        self._thread = Thread(target=self.server.serve_forever, daemon=True)

    @property
    def port(self) -> int:
        return self.server.server_address[1]

    def start(self) -> "BrainService":
        self._thread.start()
        return self

    def stop(self) -> None:
        self.server.shutdown()
        self.server.server_close()
