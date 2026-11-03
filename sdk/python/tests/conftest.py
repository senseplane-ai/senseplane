# Copyright 2026 The Senseplane Authors
# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import json
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any

import httpx
import pytest

from senseplane import AsyncSenseplane, Senseplane

REPO = Path(__file__).resolve().parents[3]
BASE = "http://api.test/v1"

Handler = Callable[[httpx.Request], httpx.Response]


def respond(body: Any = None, status: int = 200, headers: dict[str, str] | None = None) -> httpx.Response:
    if body is None:
        return httpx.Response(status, headers=headers)
    return httpx.Response(status, json=body, headers=headers)


def sse(*chunks: str) -> httpx.Response:
    """A text/event-stream response that arrives in the given chunks."""
    return httpx.Response(
        200,
        headers={"content-type": "text/event-stream"},
        stream=httpx.ByteStream(b"".join(c.encode() for c in chunks)),
    )


class Recorder:
    """Records each request (method, path with query, body) and answers with `handler`."""

    def __init__(self, handler: Handler) -> None:
        self.handler = handler
        self.requests: list[httpx.Request] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        return self.handler(request)

    @property
    def calls(self) -> list[str]:
        out = []
        for r in self.requests:
            line = f"{r.method} {r.url.path}{'?' + r.url.query.decode() if r.url.query else ''}"
            if r.content:
                line += " " + r.content.decode()
            out.append(line)
        return out

    def json(self, i: int) -> Any:
        return json.loads(self.requests[i].content)


@pytest.fixture
def no_sleep(monkeypatch: pytest.MonkeyPatch) -> list[float]:
    """Records retry and poll sleeps instead of sleeping."""
    slept: list[float] = []

    async def fake_async_sleep(s: float) -> None:
        slept.append(s)

    monkeypatch.setattr("senseplane._sync_client.time.sleep", slept.append)
    monkeypatch.setattr("senseplane._async_client.asyncio.sleep", fake_async_sleep)
    return slept


def make_client(handler: Handler, **kw: Any) -> tuple[Senseplane, Recorder]:
    rec = Recorder(handler)
    client = Senseplane(
        api_key="test-key", base_url=BASE, http_client=httpx.Client(transport=httpx.MockTransport(rec)), **kw
    )
    return client, rec


def make_async_client(handler: Handler, **kw: Any) -> tuple[AsyncSenseplane, Recorder]:
    rec = Recorder(handler)
    client = AsyncSenseplane(
        api_key="test-key", base_url=BASE, http_client=httpx.AsyncClient(transport=httpx.MockTransport(rec)), **kw
    )
    return client, rec


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


def pages(*items: list[dict[str, Any]]) -> Iterator[dict[str, Any]]:
    for i, data in enumerate(items):
        yield {"data": data, "next_cursor": f"c{i + 1}" if i + 1 < len(items) else None}
