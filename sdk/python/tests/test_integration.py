# Copyright 2026 The Senseplane Authors
# SPDX-License-Identifier: Apache-2.0
"""End to end against a real API: SENSEPLANE_INTEGRATION=1 uv run pytest -m integration.

By default this starts the API from api/dist (scripts/integration-api.mjs) on a fresh database
on the test Postgres (TEST_ADMIN_DATABASE_URL, as api/vitest.config.ts) and drops it after.
Set SENSEPLANE_TEST_API_URL and SENSEPLANE_TEST_API_KEY to use a running API instead.
"""

from __future__ import annotations

import json
import os
import socket
import subprocess
import threading
import time
from collections.abc import Iterator
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Any

import pytest

from senseplane import (
    AsyncSenseplane,
    AuthenticationError,
    NotFoundError,
    PermissionDeniedError,
    Senseplane,
    SenseplaneError,
    verify_webhook,
)
from senseplane.tools import Toolkit

from .conftest import REPO

pytestmark = [
    pytest.mark.integration,
    pytest.mark.skipif(os.environ.get("SENSEPLANE_INTEGRATION") != "1", reason="set SENSEPLANE_INTEGRATION=1"),
]
PORTS = range(42000, 43000)


def free_port(start: int) -> int:
    for port in range(start, PORTS.stop):
        with socket.socket() as s:
            try:
                s.bind(("127.0.0.1", port))
            except OSError:
                continue
            return port
    raise RuntimeError("no free port in 42000-42999")


@pytest.fixture(scope="module")
def api() -> Iterator[dict[str, str]]:
    if os.environ.get("SENSEPLANE_TEST_API_URL"):
        yield {"url": os.environ["SENSEPLANE_TEST_API_URL"], "api_key": os.environ["SENSEPLANE_TEST_API_KEY"]}
        return
    port = free_port(42000 + os.getpid() % 500)
    proc = subprocess.Popen(
        ["node", str(REPO / "sdk" / "python" / "scripts" / "integration-api.mjs")],
        env={**os.environ, "PORT": str(port)},
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        text=True,
    )
    try:
        assert proc.stdout is not None
        for line in proc.stdout:  # the key stays in this process, never printed
            if line.startswith("senseplane-test-api "):
                break
        else:
            raise RuntimeError(f"the API didn't start (exit {proc.wait(30)}); see its stderr above")
        threading.Thread(target=proc.stdout.read, daemon=True).start()  # keep draining its logs
        yield json.loads(line.split(" ", 1)[1])
    finally:
        proc.terminate()  # by PID: it closes the API and drops its database
        proc.wait(60)


@pytest.fixture(scope="module")
def sp(api: dict[str, str]) -> Iterator[Senseplane]:
    with Senseplane(api["api_key"], base_url=api["url"]) as client:
        yield client


class Receiver:
    """A local webhook endpoint that keeps each delivery's raw body and headers."""

    def __init__(self) -> None:
        self.deliveries: list[tuple[bytes, dict[str, str]]] = []
        received = self.deliveries

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:
                body = self.rfile.read(int(self.headers.get("content-length", 0)))
                received.append((body, {k.lower(): v for k, v in self.headers.items()}))
                self.send_response(204)
                self.end_headers()

            def log_message(self, *args: Any) -> None:
                pass

        self.server = HTTPServer(("127.0.0.1", free_port(42500 + os.getpid() % 400)), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_port}/hook"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def wait(self, n: int, timeout: float = 20) -> None:
        deadline = time.monotonic() + timeout
        while len(self.deliveries) < n and time.monotonic() < deadline:
            time.sleep(0.2)


def test_a_sensor_watch_webhook_and_agent_flow(api: dict[str, str], sp: Senseplane) -> None:
    started = datetime.now(timezone.utc) - timedelta(seconds=1)
    assert sp.account.get().id == api.get("account_id", sp.account.get().id)

    # Sources, with a create that's safe to retry.
    kitchen = sp.sources.create(
        name="Kitchen sensor",
        location="Kitchen",
        type="sensor",
        senses=["temperature"],
        idempotency_key="pysdk-kitchen",
    )
    again = sp.sources.create(
        name="Kitchen sensor",
        location="Kitchen",
        type="sensor",
        senses=["temperature"],
        idempotency_key="pysdk-kitchen",
    )
    assert again.id == kitchen.id
    kitchen = sp.sources.update(kitchen.id, sensor_thresholds={"temperature": {"above": 25}})
    assert kitchen.sensor_thresholds and "temperature" in kitchen.sensor_thresholds
    door = sp.sources.create(name="Front door", type="browser")
    assert {s.id for s in sp.sources.list(limit=1)} >= {kitchen.id, door.id}  # one per page
    assert sp.sources.update(door.id, location="Hall").location == "Hall"

    # A watch on the sensor, by name. It comes compiled: compiling plain language is the brain's
    # job (over Valkey), and this suite runs the API alone.
    compiled = {
        "trigger": {"type": "sensor", "sense": "temperature", "above": 28},
        "cooldown_s": 0,
        "active_hours": None,
    }
    watch = sp.watches.create(
        instruction="Tell me if the kitchen is above 28 degrees", sources=["Kitchen sensor"], compiled=compiled
    )
    assert watch.sources == [kitchen.id]
    assert watch.id in {w.id for w in sp.watches.list()}
    assert sp.watches.update(watch.id, status="paused").status == "paused"
    sp.watches.update(watch.id, status="active")

    # A webhook to a local receiver, then readings that cross the threshold.
    receiver = Receiver()
    hook = sp.webhooks.create(url=receiver.url, events=["sensor.threshold", "reading.threshold"])
    assert hook.secret
    token = sp.sources.rotate_ingest_token(kitchen.id).token
    with Senseplane(token, base_url=api["url"]) as sensor:
        assert sensor.integration.get().source.id == kitchen.id
        now = datetime.now(timezone.utc)
        readings = [
            {"sense": "temperature", "value": 21.0, "unit": "celsius", "at": now - timedelta(seconds=30)},
            {"sense": "temperature", "value": 30.0, "unit": "celsius", "at": now},
        ]
        pushed = sensor.sources.push_readings(kitchen.id, readings=readings)
        assert pushed.accepted == 2 and len(pushed.events) >= 1
        with pytest.raises(SenseplaneError):
            sensor.sources.create(name="Not allowed", type="browser")

    assert [e.watch_id for e in sp.events.list(source=kitchen.id, type="reading.threshold")] == [watch.id]
    events = list(sp.events.list(source=kitchen.id, type="sensor.threshold"))
    assert [e.type for e in events] == ["sensor.threshold"]
    assert "above 25" in events[0].summary
    assert sp.events.get(events[0].id).id == events[0].id
    streamed = next(sp.events.stream(source=kitchen.id, type="sensor.threshold", since=started, poll_interval=0.5))
    assert streamed.id == events[0].id
    history = sp.sources.history(kitchen.id, from_=now - timedelta(minutes=5))
    assert [r.value for r in history.data] == [21.0, 30.0]

    # The delivery verifies with the webhook's secret, from the raw body.
    receiver.wait(2)
    assert receiver.deliveries, "no webhook delivery arrived"
    body, headers = receiver.deliveries[0]
    delivered = verify_webhook(body, headers, hook.secret)
    assert delivered.id in {e.id for e in sp.events.list(source=kitchen.id)}
    assert headers["senseplane-event"] == delivered.type
    assert any(d.status == "delivered" for d in sp.webhooks.deliveries(hook.id))

    # An agent that sees only the sensor's temperature.
    agent = sp.agents.create(name="Kitchen agent")
    sp.grants.create(agent_id=agent.id, source_ids=[kitchen.id], senses=["temperature"])
    with Senseplane(agent.api_key, base_url=api["url"]) as as_agent:
        assert [s.id for s in as_agent.sources.list()] == [kitchen.id]
        assert as_agent.inbox.list().agent_id == agent.id
        with pytest.raises((NotFoundError, PermissionDeniedError)):
            as_agent.sources.get(door.id)
        tools = Toolkit(as_agent)
        assert [s["id"] for s in tools.call("list_senses").value()["sources"]] == [kitchen.id]
        env = tools.call("read_environment", {"room": "Kitchen"}).value()
        assert env["sources"][0]["readings"][0]["value"] == 30.0
        assert tools.call("look", {"source": "Front door"}).is_error

    # Errors are typed.
    with pytest.raises(NotFoundError) as nf:
        sp.sources.get("src_00000000000000000000000000")
    assert nf.value.code == "not_found" and nf.value.request_id
    with Senseplane("not-a-key", base_url=api["url"]) as bad, pytest.raises(AuthenticationError):
        bad.account.get()

    # Clean up what this made.
    sp.webhooks.delete(hook.id)
    sp.watches.delete(watch.id)
    sp.agents.delete(agent.id)
    try:
        sp.sources.delete(door.id)
    except SenseplaneError as err:
        # The spec has DELETE /sources/{id}; this API answers not_implemented (501) for now.
        assert (err.status, err.code) == (501, "not_implemented")
    else:
        with pytest.raises(NotFoundError):
            sp.sources.get(door.id)


def test_devices_through_a_box_and_a_person_confirming(api: dict[str, str], sp: Senseplane) -> None:
    """Control (ADR 0067) with no hardware: this test plays the box, with the bridge's token."""
    if "session" not in api:
        pytest.skip("needs a signed-in person (the bundled API harness provides one)")
    bridge = sp.bridges.create("Hall box")
    assert bridge.token and bridge.id in {b.id for b in sp.bridges.list()}
    entities = [
        {"entity_id": "light.hall", "name": "Hall light", "area": "Hall", "sense": "switch", "kind": "state",
         "controls": ["turn_on", "turn_off", "set_brightness"]},
        {"entity_id": "lock.front_door", "name": "Front door", "area": "Hall", "sense": "lock", "kind": "state",
         "controls": ["lock", "unlock"]},
    ]  # fmt: skip
    handed: list[dict[str, Any]] = []
    stop = threading.Event()
    with Senseplane(bridge.token, base_url=api["url"]) as box:
        box.bridge.put_entities(entities=entities)
        chosen = sp.bridges.choose_entities(bridge.id, choose=["light.hall", "lock.front_door"])
        source_id = chosen.data[0].source_id
        assert source_id
        box.bridge.health(cameras=[], home_assistant={"connected": True, "entities": 2, "sending": 2})

        def run_box() -> None:
            while not stop.is_set():
                for c in box.bridge.take_commands(wait=1).data:
                    item = c.model_dump()
                    handed.append(item)
                    state = {"locked": False} if item["args"].get("action") == "unlock" else {"on": True}
                    box.bridge.finish_command(
                        item["id"], ok=True, result={"reached": True, "changed": True, "state": state, "before": {}}
                    )

        threading.Thread(target=run_box, daemon=True).start()
        try:
            devices = {d.entity_id: d for d in sp.devices.list()}
            assert set(devices) == {"light.hall", "lock.front_door"}
            for d in devices.values():
                assert sp.devices.set_controllable(d.id, True).controllable is True

            butler = sp.agents.create(name="Butler")
            sp.grants.create(agent_id=butler.id, source_ids=[source_id], senses=["sensors", "control"])
            with Senseplane(butler.api_key, base_url=api["url"]) as agent:
                tools = Toolkit(agent)
                listed = tools.call("list_devices", {"room": "Hall"}).value()["devices"]
                assert sorted(d["name"] for d in listed) == ["Front door", "Hall light"]
                assert all(d["can_control"] for d in listed)
                done = tools.call("control_device", {"device": "hall light", "action": "turn_on"}).value()
                assert done["status"] == "done" and done["state"]["on"] is True

                # A lock asked for by an agent waits for a person.
                waiting = tools.call("control_device", {"device": "Front door", "action": "unlock"}).value()
                assert waiting["status"] == "awaiting_confirmation" and waiting["confirm_by"]
                assert "person must confirm" in waiting["note"]
                with Senseplane(api["session"], base_url=api["url"]) as person:
                    assert waiting["request"] in {c.id for c in person.confirmations.list()}
                    approved = person.confirmations.decide(waiting["request"], approve=True)
                    assert approved.status == "done"
                assert tools.call("control_device", {"request": waiting["request"]}).value()["status"] == "done"
            assert [h["args"]["entity_id"] for h in handed] == ["light.hall", "lock.front_door"]
        finally:
            stop.set()
            time.sleep(1.5)  # the box's last long poll ends
    sp.bridges.remove(bridge.id)
    assert bridge.id not in {b.id for b in sp.bridges.list()}


@pytest.mark.anyio
async def test_async_client_against_the_api(api: dict[str, str]) -> None:
    async with AsyncSenseplane(api["api_key"], base_url=api["url"]) as sp:
        src = await sp.sources.create(name="Async camera", type="browser")
        assert src.id in [s.id async for s in sp.sources.list()]
        usage = await sp.usage.get()
        assert usage is not None
        assert (await sp.sources.pause(src.id)).status == "paused"
