# Copyright 2026 The Senseplane Authors
# SPDX-License-Identifier: Apache-2.0
"""Structured JSON logs on stdout."""

import json
import logging
import sys
from datetime import UTC, datetime

from .telemetry import log_ids


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        entry = {
            "time": datetime.fromtimestamp(record.created, UTC).isoformat(),
            "level": record.levelname.lower(),
            "logger": record.name,
            "msg": record.getMessage(),
        }
        entry.update(log_ids())  # trace_id/span_id inside a span (ADR 0033)
        if record.exc_info:
            entry["err"] = self.formatException(record.exc_info)
        entry.update(getattr(record, "fields", {}))
        return json.dumps(entry)


def configure(level: str = "INFO") -> None:
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(JsonFormatter())
    logging.basicConfig(level=level.upper(), handlers=[handler], force=True)
