# Copyright 2026 The Senseplane Authors
# SPDX-License-Identifier: Apache-2.0
"""Constants for the Senseplane integration."""

DOMAIN = "senseplane"

CONF_URL = "url"
CONF_TOKEN = "token"
CONF_SOURCE_ID = "source_id"
CONF_ENTITIES = "entities"

# Senseplane senses this integration forwards, keyed by Home Assistant device class.
SENSES = ("temperature", "humidity")

# How often queued readings are sent, and how many at most per request.
BATCH_SECONDS = 10.0
MAX_BATCH = 500
# Readings kept while Senseplane is unreachable; the oldest are dropped beyond this.
MAX_QUEUE = 5000
