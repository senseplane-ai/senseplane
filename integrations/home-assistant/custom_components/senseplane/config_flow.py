# Copyright 2026 The Senseplane Authors
# SPDX-License-Identifier: Apache-2.0
"""Config flow: API URL + integration token, then the sensor entities to forward."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

import voluptuous as vol
from homeassistant.config_entries import ConfigEntry, ConfigFlow, ConfigFlowResult, OptionsFlow
from homeassistant.core import callback
from homeassistant.helpers import selector
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .client import AuthError, SenseplaneClient, SenseplaneError, normalize_url
from .const import CONF_ENTITIES, CONF_SOURCE_ID, CONF_TOKEN, CONF_URL, DOMAIN, SENSES


def _entities_schema(senses: list[str], default: list[str]) -> vol.Schema:
    return vol.Schema(
        {
            vol.Required(CONF_ENTITIES, default=default): selector.EntitySelector(
                selector.EntitySelectorConfig(domain="sensor", device_class=[s for s in senses if s in SENSES], multiple=True)
            )
        }
    )


class SenseplaneConfigFlow(ConfigFlow, domain=DOMAIN):
    """Adds one Senseplane sensor source."""

    VERSION = 1

    def __init__(self) -> None:
        self._data: dict[str, Any] = {}
        self._source: dict[str, Any] = {}

    async def _check(self, url: str, token: str) -> tuple[dict[str, Any] | None, str | None]:
        client = SenseplaneClient(async_get_clientsession(self.hass), url, token)
        try:
            return await client.integration(), None
        except AuthError:
            return None, "invalid_auth"
        except SenseplaneError:
            return None, "cannot_connect"

    async def async_step_user(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        errors: dict[str, str] = {}
        if user_input is not None:
            url = normalize_url(user_input[CONF_URL])
            source, error = await self._check(url, user_input[CONF_TOKEN])
            if error:
                errors["base"] = error
            else:
                await self.async_set_unique_id(source["id"])
                self._abort_if_unique_id_configured()
                self._data = {CONF_URL: url, CONF_TOKEN: user_input[CONF_TOKEN].strip(), CONF_SOURCE_ID: source["id"]}
                self._source = source
                return await self.async_step_entities()
        return self.async_show_form(
            step_id="user",
            data_schema=vol.Schema(
                {
                    vol.Required(CONF_URL, default=(user_input or {}).get(CONF_URL, "")): str,
                    vol.Required(CONF_TOKEN): selector.TextSelector(selector.TextSelectorConfig(type=selector.TextSelectorType.PASSWORD)),
                }
            ),
            errors=errors,
        )

    async def async_step_entities(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        if user_input is not None:
            return self.async_create_entry(title=self._source.get("name", "Senseplane"), data={**self._data, CONF_ENTITIES: user_input[CONF_ENTITIES]})
        return self.async_show_form(
            step_id="entities",
            data_schema=_entities_schema(self._source.get("senses", list(SENSES)), []),
            description_placeholders={"name": self._source.get("name", "")},
        )

    async def async_step_reauth(self, entry_data: Mapping[str, Any]) -> ConfigFlowResult:
        return await self.async_step_reauth_confirm()

    async def async_step_reauth_confirm(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        entry = self._get_reauth_entry()
        errors: dict[str, str] = {}
        if user_input is not None:
            source, error = await self._check(entry.data[CONF_URL], user_input[CONF_TOKEN])
            if error:
                errors["base"] = error
            elif source["id"] != entry.data[CONF_SOURCE_ID]:
                errors["base"] = "wrong_source"
            else:
                return self.async_update_reload_and_abort(entry, data_updates={CONF_TOKEN: user_input[CONF_TOKEN].strip()})
        return self.async_show_form(
            step_id="reauth_confirm",
            data_schema=vol.Schema({vol.Required(CONF_TOKEN): selector.TextSelector(selector.TextSelectorConfig(type=selector.TextSelectorType.PASSWORD))}),
            errors=errors,
        )

    @staticmethod
    @callback
    def async_get_options_flow(config_entry: ConfigEntry) -> OptionsFlow:
        return SenseplaneOptionsFlow()


class SenseplaneOptionsFlow(OptionsFlow):
    """Change which entities are forwarded."""

    async def async_step_init(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        if user_input is not None:
            return self.async_create_entry(data={CONF_ENTITIES: user_input[CONF_ENTITIES]})
        current = self.config_entry.options.get(CONF_ENTITIES, self.config_entry.data.get(CONF_ENTITIES, []))
        return self.async_show_form(step_id="init", data_schema=_entities_schema(list(SENSES), current))
