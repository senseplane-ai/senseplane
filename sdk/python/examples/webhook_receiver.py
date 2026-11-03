# Copyright 2026 The Senseplane Authors
# SPDX-License-Identifier: Apache-2.0
"""A webhook receiver with only the standard library: verifies each delivery, then prints it.

SENSEPLANE_WEBHOOK_SECRET=whsec_... python examples/webhook_receiver.py   # listens on :8000/hooks/senseplane
"""

import os
from http.server import BaseHTTPRequestHandler, HTTPServer

from senseplane import WebhookVerificationError, verify_webhook

SECRET = os.environ["SENSEPLANE_WEBHOOK_SECRET"]
seen: set[str] = set()


class Hook(BaseHTTPRequestHandler):
    def do_POST(self) -> None:
        body = self.rfile.read(int(self.headers.get("content-length", 0)))  # the raw body, before any parsing
        try:
            event = verify_webhook(body, self.headers.get("Senseplane-Signature"), SECRET)
        except WebhookVerificationError as err:
            self.send_response(400)
            self.end_headers()
            print(f"rejected: {err}")
            return
        self.send_response(204)  # answer within 10 seconds; slow work goes elsewhere
        self.end_headers()
        delivery = self.headers.get("Senseplane-Delivery", "")
        if delivery in seen:  # a delivery can arrive more than once
            return
        seen.add(delivery)
        print(f"{event.type}: {event.summary}")


HTTPServer(("", 8000), Hook).serve_forever()
