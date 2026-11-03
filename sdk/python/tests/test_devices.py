# Copyright 2026 The Senseplane Authors
# SPDX-License-Identifier: Apache-2.0
"""Devices, confirmations, bridges and account keys; and the device tools, with the cases of
mcp/src/mcp.test.ts so both answer alike."""

from __future__ import annotations

import json
from typing import Any

import httpx
import pytest

from senseplane import InternalServerError, Senseplane
from senseplane.tools import Toolkit

from .conftest import Recorder, make_client, respond


def cmd(**over: Any) -> dict[str, Any]:
    base = {
        "id": "dcm_1",
        "device_id": "dev_hall",
        "device_name": "Hall light",
        "entity_id": "light.hall",
        "action": "turn_on",
        "value": None,
        "status": "done",
        "message": "Hall light is on.",
        "state": {"on": True},
        "requested_by": {"kind": "agent", "id": "agt_1", "name": "Claude"},
        "via": "agent",
        "expires_at": None,
        "decided_by": None,
        "created_at": "2026-10-16T01:00:00Z",
        "finished_at": "2026-10-16T01:00:01Z",
    }
    return {**base, **over}


DEVICES = [
    {"id": "dev_hall", "name": "Hall light", "room": "Hall", "type": "light", "tier": "switch",
     "actions": ["turn_on", "turn_off"], "state": {"on": False}, "online": True, "can_control": True, "controllable": True},
    {"id": "dev_lock", "name": "Front door", "room": "Hall", "type": "lock", "tier": "secure",
     "actions": ["lock", "unlock"], "state": {"locked": True}, "online": True, "can_control": True, "controllable": True},
    {"id": "dev_porch", "name": "Porch light", "room": "Porch", "type": "light", "tier": "switch",
     "actions": ["turn_on", "turn_off"], "state": None, "online": False, "can_control": True, "controllable": True},
]  # fmt: skip
SENSOR = {
    "id": "src_th",
    "name": "Kitchen",
    "location": "Kitchen",
    "type": "sensor",
    "senses": ["temperature", "contact", "doorbell"],
    "status": "online",
}


def api(r: httpx.Request) -> httpx.Response:
    p = r.url.path.removeprefix("/v1")
    if p == "/sources":
        return respond({"data": [SENSOR], "next_cursor": None})
    if p == "/sources/src_th/now":
        readings = [
            {"sense": "temperature", "kind": "number", "value": 22.4, "unit": "celsius", "measured_at": "2026-10-16T01:00:00Z"},
            {"sense": "contact", "kind": "state", "value": True, "state": "open", "since": "2026-10-16T00:50:00Z",
             "device": {"id": "binary_sensor.fridge", "name": "Fridge door"}, "measured_at": "2026-10-16T00:50:00Z"},
            {"sense": "doorbell", "kind": "event", "measured_at": "2026-10-16T00:40:00Z"},
        ]  # fmt: skip
        return respond({"source_id": "src_th", "captured_at": "2026-10-16T01:00:00Z", "readings": readings})
    if p == "/sources/src_th/history":
        return respond(
            {
                "data": [
                    {
                        "sense": "temperature",
                        "kind": "number",
                        "value": 21.0,
                        "unit": "celsius",
                        "measured_at": "2026-10-16T00:05:00Z",
                    }
                ]
            }
        )
    if p == "/devices":
        return respond({"data": DEVICES, "next_cursor": None})
    if p == "/devices/dev_hall/commands":
        return respond(cmd())
    if p == "/devices/dev_lock/commands":
        return respond(
            cmd(id="dcm_2", device_id="dev_lock", device_name="Front door", action="unlock", status="awaiting_confirmation",
                state=None, finished_at=None, message="Waiting for a person to confirm: unlock Front door.",
                expires_at="2026-10-16T01:02:00Z"),
            202,
        )  # fmt: skip
    if p == "/devices/dev_porch/commands":
        offline = cmd(
            id="dcm_3",
            device_name="Porch light",
            status="offline",
            state=None,
            message="Porch light's box didn't take the command",
        )
        error = {
            "code": "device_offline",
            "message": "Porch light's box didn't take the command",
            "request_id": "r",
            "details": {"command": offline},
        }
        return respond({"error": error}, 503)
    if p == "/device-commands/dcm_2":
        return respond(cmd(id="dcm_2", device_name="Front door", action="unlock", status="expired", state=None,
                           message="Nobody confirmed in time, so this wasn't done."))  # fmt: skip
    return respond({"error": {"code": "not_found", "message": p, "request_id": "r"}}, 404)


def toolkit() -> tuple[Toolkit, Recorder]:
    rec = Recorder(api)
    sp = Senseplane(
        api_key="test-key", base_url="http://api/v1", http_client=httpx.Client(transport=httpx.MockTransport(rec))
    )
    return Toolkit(sp), rec


def test_read_environment_words_numbers_states_and_events() -> None:
    tk, _ = toolkit()
    assert tk.call("read_environment", {"room": "kitchen"}).value()["sources"][0]["readings"] == [
        {"sense": "temperature", "value": 22.4, "unit": "celsius", "text": "22.4 °C", "measured_at": "2026-10-16T01:00:00Z",
         "trend_last_hour": "rising", "change_last_hour": 1.4},
        {"sense": "contact", "device": "Fridge door", "state": "open", "value": True, "since": "2026-10-16T00:50:00Z",
         "measured_at": "2026-10-16T00:50:00Z"},
        {"sense": "doorbell", "last": "rang", "at": "2026-10-16T00:40:00Z"},
    ]  # fmt: skip
    only = tk.call("read_environment", {"source": "Kitchen", "sense": "doorbell"}).value()["sources"][0]["readings"]
    assert [r["sense"] for r in only] == ["doorbell"]
    missing = tk.call("read_environment", {"room": "attic", "sense": "contact"})
    assert missing.is_error and missing.value()["error"]["message"] == 'no door or window sensor in "attic"'
    assert tk.call("read_environment", {"room": "attic"}).value()["error"]["message"] == 'no sensors in "attic"'


def test_read_environment_says_an_offline_box_left_old_values(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setitem(SENSOR, "status", "offline")
    monkeypatch.setitem(SENSOR, "status_since", "2026-10-16T00:00:00Z")
    tk, _ = toolkit()
    src = tk.call("read_environment", {"room": "kitchen"}).value()["sources"][0]
    assert src["status"] == "offline"
    assert src["note"] == "Offline since 2026-10-16T00:00:00Z: these are the last readings, not what is true now."


def test_list_and_control_devices() -> None:
    tk, rec = toolkit()
    assert [d["name"] for d in tk.call("list_devices", {"room": "hall"}).value()["devices"]] == [
        "Hall light",
        "Front door",
    ]
    assert "controllable" not in tk.call("list_devices").value()["devices"][0]
    done = tk.call("control_device", {"device": "hall light", "action": "turn_on"}).value()
    assert done == {"request": "dcm_1", "device": "Hall light", "action": "turn_on", "status": "done",
                    "message": "Hall light is on.", "state": {"on": True}}  # fmt: skip
    sent = next(x for x in rec.requests if x.url.path == "/v1/devices/dev_hall/commands")
    assert json.loads(sent.content) == {"action": "turn_on"}


def test_a_lock_waits_an_offline_box_isnt_done_and_an_earlier_request_is_checked() -> None:
    tk, rec = toolkit()
    lock = tk.call("control_device", {"device": "Front door", "action": "unlock"})
    body = lock.value()
    assert (
        not lock.is_error and body["status"] == "awaiting_confirmation" and body["confirm_by"] == "2026-10-16T01:02:00Z"
    )
    assert "person must confirm" in body["note"]
    porch = tk.call("control_device", {"device": "dev_porch", "action": "turn_on"})
    assert porch.is_error
    assert porch.value()["error"]["code"] == "device_offline" and porch.value()["status"] == "offline"
    assert (
        len([x for x in rec.requests if x.url.path == "/v1/devices/dev_porch/commands"]) == 1
    )  # a command isn't retried
    assert tk.call("control_device", {"request": "dcm_2"}).value()["status"] == "expired"
    assert tk.call("control_device", {"device": "garage", "action": "open"}).is_error
    nothing = tk.call("control_device", {"action": "open"})
    assert nothing.value() == {
        "error": {"code": "validation_failed", "message": "give a device and an action, or a request id to check"}
    }


def test_device_client() -> None:
    def handler(r: httpx.Request) -> httpx.Response:
        if r.url.path == "/v1/devices":
            return respond({"data": DEVICES})  # one page, no cursor
        if r.url.path.startswith("/v1/devices/") and r.method == "PATCH":
            return respond(DEVICES[0])
        if r.url.path == "/v1/confirmations":
            return respond({"data": [cmd(status="awaiting_confirmation")]})
        return respond(cmd(), 202 if "confirmations" in r.url.path else 200)

    client, rec = make_client(handler)
    assert [d.name for d in client.devices.list()] == ["Hall light", "Front door", "Porch light"]
    assert client.devices.set_controllable("dev_hall", True).id == "dev_hall"
    c = client.devices.command("dev_hall", "set_brightness", value=40, via="app")
    assert c.status == "done" and c.state is not None
    assert client.devices.command("dev_lock", "unlock", confirm=True).id == "dcm_1"
    assert client.devices.request("dcm_1").device_name == "Hall light"
    assert [x.status for x in client.confirmations.list()] == ["awaiting_confirmation"]
    assert client.confirmations.decide("dcm_1", approve=True).id == "dcm_1"
    assert rec.calls == [
        "GET /v1/devices",
        'PATCH /v1/devices/dev_hall {"controllable":true}',
        'POST /v1/devices/dev_hall/commands {"action":"set_brightness","value":40}',
        'POST /v1/devices/dev_lock/commands {"action":"unlock","confirm":true}',
        "GET /v1/device-commands/dcm_1",
        "GET /v1/confirmations",
        'POST /v1/confirmations/dcm_1 {"approve":true}',
    ]
    assert rec.requests[2].headers["x-senseplane-via"] == "app"
    assert "x-senseplane-via" not in rec.requests[3].headers


def test_device_errors_carry_the_request() -> None:
    client, _ = make_client(api)
    with pytest.raises(InternalServerError) as info:
        client.devices.command("dev_porch", "turn_on")
    assert info.value.code == "device_offline" and info.value.details
    assert info.value.details["command"]["status"] == "offline"


def test_bridges_and_account_keys() -> None:
    def handler(r: httpx.Request) -> httpx.Response:
        if r.method == "DELETE":
            return respond(None, 204)
        if r.url.path == "/v1/bridges" and r.method == "GET":
            return respond({"data": [{"id": "brg_1", "name": "Box"}]})
        if r.url.path.startswith("/v1/account/keys"):
            return respond({"current_version": 2, "rotating": r.method == "POST"})
        if r.url.path == "/v1/bridge/commands":
            return respond({"data": []})
        if r.url.path in ("/v1/bridge/entities", "/v1/bridge/cameras-found") and r.method == "PUT":
            return respond(None, 204)
        return respond({"id": "x", "status": "pending"})

    client, rec = make_client(handler)
    assert [b.id for b in client.bridges.list()] == ["brg_1"]
    client.bridges.create("Box")
    client.bridges.add_matter_device("brg_1", "MT:123")
    client.bridges.choose_entities("brg_1", choose=["light.hall"], drop=["switch.old"])
    client.bridges.add_onvif_camera("brg_1", camera="cam_1", username="admin", password="pw")
    client.bridges.command("brg_1", "bcm_1")
    client.bridges.approve_pairing("ABCD-1234", name="Garage box")
    client.bridges.find_pairing("ABCD-1234")
    client.bridges.remove("brg_1")
    assert client.account.keys().current_version == 2
    assert client.account.rotate_keys().rotating is True
    client.bridge.take_commands(wait=25)
    client.bridge.put_entities(entities=[])
    client.bridge.finish_command("bcm_1", ok=True, result={"on": True})
    client.bridge.poll_pairing("dev-code")
    assert rec.calls == [
        "GET /v1/bridges",
        'POST /v1/bridges {"name":"Box"}',
        'POST /v1/bridges/brg_1/matter {"code":"MT:123"}',
        'PATCH /v1/bridges/brg_1/entities {"choose":["light.hall"],"drop":["switch.old"]}',
        'POST /v1/bridges/brg_1/onvif {"camera":"cam_1","username":"admin","password":"pw"}',
        "GET /v1/bridges/brg_1/commands/bcm_1",
        'POST /v1/bridges/pair {"code":"ABCD-1234","name":"Garage box"}',
        "GET /v1/bridges/pair?code=ABCD-1234",
        "DELETE /v1/bridges/brg_1",
        "GET /v1/account/keys",
        "POST /v1/account/keys/rotate",
        "GET /v1/bridge/commands?wait=25",
        'PUT /v1/bridge/entities {"entities":[]}',
        'POST /v1/bridge/commands/bcm_1 {"ok":true,"result":{"on":true}}',
        'POST /v1/bridge/pair/token {"device_code":"dev-code"}',
    ]
