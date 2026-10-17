# Copyright 2026 The Senseplane Authors
# SPDX-License-Identifier: Apache-2.0
"""Entry point: python -m senseplane_brain"""

import asyncio
import logging
import os
import signal

from . import telemetry
from .logging import configure
from .service import BrainService


def main() -> None:
    configure(os.environ.get("LOG_LEVEL", "info"))
    telemetry.setup()  # no-op unless OTEL_EXPORTER_OTLP_ENDPOINT is set
    svc = BrainService(port=int(os.environ.get("PORT", "8070"))).start()
    logging.getLogger("senseplane.brain").info("brain started", extra={"fields": {"port": svc.port}})
    asyncio.run(_run())
    svc.stop()


async def _run() -> None:
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, stop.set)
    valkey_url = os.environ.get("VALKEY_URL")
    if not valkey_url:
        logging.getLogger("senseplane.brain").warning("VALKEY_URL not set: perception is idle")
        await stop.wait()
        return
    from .worker import Worker

    await Worker(valkey_url).run(stop)

if __name__ == "__main__":
    main()
