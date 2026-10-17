# Copyright 2026 The Senseplane Authors
# SPDX-License-Identifier: Apache-2.0
"""A small Senseplane API client for sensor integration tokens.

No Home Assistant imports, so it is testable on its own. An integration token
(``sit_...``) can only read its own source and push readings to it.
"""

from __future__ import annotations

from typing import Any

import aiohttp

TIMEOUT = aiohttp.ClientTimeout(total=20)


class SenseplaneError(Exception):
    """An API call failed. ``retry`` says whether trying again later can help."""

    def __init__(self, message: str, status: int | None = None, retry: bool = True) -> None:
        super().__init__(message)
        self.status = status
        self.retry = retry


class AuthError(SenseplaneError):
    """The token was refused (wrong, rotated or revoked)."""

    def __init__(self, message: str = "the integration token was refused") -> None:
        super().__init__(message, 401, retry=False)


def normalize_url(url: str) -> str:
    """Accept the API URL with or without a trailing slash or /v1."""
    url = url.strip().rstrip("/")
    if url.endswith("/v1"):
        url = url[: -len("/v1")]
    return url


class SenseplaneClient:
    """Calls the Senseplane API with an integration token."""

    def __init__(self, session: aiohttp.ClientSession, url: str, token: str) -> None:
        self._session = session
        self._base = normalize_url(url)
        self._token = token.strip()

    async def _request(self, method: str, path: str, body: Any = None) -> Any:
        try:
            async with self._session.request(
                method,
                f"{self._base}{path}",
                json=body,
                headers={"Authorization": f"Bearer {self._token}"},
                timeout=TIMEOUT,
            ) as res:
                if res.status == 401:
                    raise AuthError()
                if res.status >= 400:
                    try:
                        err = (await res.json()).get("error", {})
                    except (aiohttp.ContentTypeError, ValueError):
                        err = {}
                    message = err.get("message") or res.reason or "request failed"
                    # 4xx other than 429 won't succeed on retry (bad reading, wrong source).
                    raise SenseplaneError(message, res.status, retry=res.status == 429 or res.status >= 500)
                if res.status == 204:
                    return None
                return await res.json()
        except (aiohttp.ClientError, TimeoutError) as err:
            raise SenseplaneError(f"cannot reach Senseplane: {err}") from err

    async def integration(self) -> dict[str, Any]:
        """The sensor source this token feeds (``{"id", "name", "senses", ...}``)."""
        out = await self._request("GET", "/v1/integration")
        return out["source"]

    async def post_readings(self, source_id: str, readings: list[dict[str, Any]]) -> dict[str, Any]:
        """Push readings: ``[{"sense", "value", "unit", "at"}]``."""
        return await self._request("POST", f"/v1/sources/{source_id}/readings", {"readings": readings})
