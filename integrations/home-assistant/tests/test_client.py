# Copyright 2026 The Senseplane Authors
# SPDX-License-Identifier: Apache-2.0
"""The API client against a local fake of the Senseplane API."""

import aiohttp
import pytest
from aiohttp import web
from aiohttp.test_utils import TestServer

from senseplane.client import AuthError, SenseplaneClient, SenseplaneError, normalize_url

TOKEN = "sit_test"


@pytest.fixture
async def api():
    received = []

    def authed(request):
        return request.headers.get("Authorization") == f"Bearer {TOKEN}"

    async def integration(request):
        if not authed(request):
            return web.json_response({"error": {"code": "unauthorized", "message": "nope"}}, status=401)
        return web.json_response({"source": {"id": "src_1", "name": "Server room", "senses": ["temperature"]}})

    async def readings(request):
        if not authed(request):
            return web.json_response({"error": {"code": "unauthorized"}}, status=401)
        body = await request.json()
        if any(r["sense"] != "temperature" for r in body["readings"]):
            return web.json_response({"error": {"code": "validation_failed", "message": "this sensor does not measure humidity"}}, status=400)
        if request.match_info["id"] == "src_busy":
            return web.json_response({"error": {"code": "rate_limited", "message": "slow down"}}, status=429)
        received.extend(body["readings"])
        return web.json_response({"accepted": len(body["readings"]), "events": []}, status=202)

    app = web.Application()
    app.router.add_get("/v1/integration", integration)
    app.router.add_post("/v1/sources/{id}/readings", readings)
    server = TestServer(app)
    await server.start_server()
    async with aiohttp.ClientSession() as session:
        yield server, session, received
    await server.close()


def test_normalize_url():
    assert normalize_url(" https://sp.example/v1/ ") == "https://sp.example"
    assert normalize_url("http://localhost:8080") == "http://localhost:8080"


async def test_learns_its_source_and_posts_readings(api):
    server, session, received = api
    client = SenseplaneClient(session, str(server.make_url("/v1")), TOKEN)
    source = await client.integration()
    assert source["id"] == "src_1"
    out = await client.post_readings("src_1", [{"sense": "temperature", "value": 21.5, "unit": "celsius", "at": "2026-10-16T12:00:00+00:00"}])
    assert out["accepted"] == 1
    assert received[0]["value"] == 21.5


async def test_errors_say_whether_to_retry(api):
    server, session, _ = api
    with pytest.raises(AuthError):
        await SenseplaneClient(session, str(server.make_url("/")), "sit_wrong").integration()
    client = SenseplaneClient(session, str(server.make_url("/")), TOKEN)
    with pytest.raises(SenseplaneError) as bad:
        await client.post_readings("src_1", [{"sense": "humidity", "value": 40, "unit": "percent", "at": "x"}])
    assert bad.value.status == 400 and not bad.value.retry and "humidity" in str(bad.value)
    with pytest.raises(SenseplaneError) as busy:
        await client.post_readings("src_busy", [{"sense": "temperature", "value": 1, "unit": "celsius", "at": "x"}])
    assert busy.value.retry
    with pytest.raises(SenseplaneError) as down:
        await SenseplaneClient(session, "http://127.0.0.1:9", TOKEN).integration()
    assert down.value.retry
