# Copyright 2026 The Senseplane Authors
# SPDX-License-Identifier: Apache-2.0
"""A camera, a watch, and its events as they arrive.

SENSEPLANE_API_KEY=... SENSEPLANE_API_URL=http://localhost:8080/v1 python examples/quickstart.py
"""

from senseplane import Senseplane

with Senseplane() as sp:
    # Safe to run again: the same idempotency key returns the first source instead of a second one.
    src = sp.sources.create(name="Front door", type="browser", idempotency_key="quickstart-front-door")
    print(f"Open the capture link on a phone to start the camera: {src.ingest.capture_url if src.ingest else '-'}")

    watch = sp.watches.create(instruction="Tell me if a package is left at the front door", sources=[src.id])
    print(f"Watching: {watch.instruction} ({watch.status})")

    print("Waiting for events (Ctrl-C to stop)…")
    for event in sp.events.stream(source=src.id):
        print(f"{event.occurred_at:%H:%M:%S} {event.type}: {event.summary}")
