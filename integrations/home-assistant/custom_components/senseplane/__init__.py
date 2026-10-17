# Copyright 2026 The Senseplane Authors
# SPDX-License-Identifier: Apache-2.0
"""Senseplane: forward Home Assistant temperature and humidity sensors as readings.

Each config entry is one Senseplane sensor source (one integration token).
State changes of the chosen entities are queued and sent in batches; see
forwarder.py. Outbound only: Senseplane never calls Home Assistant.
"""

from __future__ import annotations

import logging

from homeassistant.config_entries import ConfigEntry
from homeassistant.const import ATTR_DEVICE_CLASS, ATTR_UNIT_OF_MEASUREMENT
from homeassistant.core import Event, EventStateChangedData, HomeAssistant, State, callback
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.event import async_track_state_change_event

from .client import SenseplaneClient
from .const import CONF_ENTITIES, CONF_SOURCE_ID, CONF_TOKEN, CONF_URL
from .forwarder import Forwarder, to_reading

_LOGGER = logging.getLogger(__name__)

type SenseplaneConfigEntry = ConfigEntry[Forwarder]


def _reading(state: State | None):
    if state is None:
        return None
    return to_reading(
        state.attributes.get(ATTR_DEVICE_CLASS),
        state.state,
        state.attributes.get(ATTR_UNIT_OF_MEASUREMENT),
        state.last_updated,
    )


async def async_setup_entry(hass: HomeAssistant, entry: SenseplaneConfigEntry) -> bool:
    client = SenseplaneClient(async_get_clientsession(hass), entry.data[CONF_URL], entry.data[CONF_TOKEN])
    source_id = entry.data[CONF_SOURCE_ID]
    forwarder = Forwarder(
        lambda readings: client.post_readings(source_id, readings),
        on_auth_failed=lambda: entry.async_start_reauth(hass),
    )
    entities: list[str] = entry.options.get(CONF_ENTITIES, entry.data.get(CONF_ENTITIES, []))

    # The current value first, so the source has a reading straight away.
    for entity_id in entities:
        if (reading := _reading(hass.states.get(entity_id))) is not None:
            forwarder.add(reading)

    @callback
    def _changed(event: Event[EventStateChangedData]) -> None:
        if (reading := _reading(event.data["new_state"])) is not None:
            forwarder.add(reading)

    entry.async_on_unload(async_track_state_change_event(hass, entities, _changed))
    entry.async_create_background_task(hass, forwarder.run(), "senseplane forwarder")
    entry.async_on_unload(forwarder.stop)
    entry.async_on_unload(entry.add_update_listener(_reload))
    entry.runtime_data = forwarder
    _LOGGER.debug("forwarding %d entities to %s", len(entities), source_id)
    return True


async def async_unload_entry(hass: HomeAssistant, entry: SenseplaneConfigEntry) -> bool:
    # Try once to send what is still queued.
    await entry.runtime_data.flush()
    return True


async def _reload(hass: HomeAssistant, entry: SenseplaneConfigEntry) -> None:
    await hass.config_entries.async_reload(entry.entry_id)
