# Copyright 2026 The Senseplane Authors
# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import base64
import json
import re

import httpx
import pytest

from senseplane import AsyncSenseplane, Senseplane
from senseplane.tools import TOOL_NAMES, AsyncToolkit, Toolkit, anthropic_tools, openai_tools, tool_definitions

from .conftest import REPO, Recorder, respond

SPEC = json.loads((REPO / "spec" / "mcp" / "tools.json").read_text())["tools"]
CAMERA = {
    "id": "src_cam",
    "name": "Front door",
    "location": "Hall",
    "type": "browser",
    "senses": ["video", "audio"],
    "status": "online",
}
SENSOR = {
    "id": "src_tmp",
    "name": "Kitchen sensor",
    "location": "Kitchen",
    "type": "sensor",
    "senses": ["temperature"],
    "status": "online",
}
JPEG = b"\xff\xd8\xff fake jpeg"


def test_schemas_are_the_mcp_tools() -> None:
    assert [t["name"] for t in tool_definitions()] == [t["name"] for t in SPEC] == list(TOOL_NAMES)
    for ours, spec in zip(anthropic_tools(), SPEC, strict=True):
        assert ours == {"name": spec["name"], "description": spec["description"], "input_schema": spec["inputSchema"]}
    for ours, spec in zip(openai_tools(), SPEC, strict=True):
        fn = {"name": spec["name"], "description": spec["description"], "parameters": spec["inputSchema"]}
        assert ours == {"type": "function", "function": fn}
    assert openai_tools(["look"], api="responses") == [{"type": "function", **openai_tools(["look"])[0]["function"]}]
    with pytest.raises(ValueError, match="unknown tools"):
        anthropic_tools(["look", "teleport"])


def test_every_mcp_handler_has_a_tool() -> None:
    # The MCP server's handler names (mcp/src/handlers.ts) are the same set.
    source = (REPO / "mcp" / "src" / "handlers.ts").read_text()
    block = source[source.index("const handlers") : source.index("return async (name")]
    assert sorted(re.findall(r"^    async (\w+)\(", block, re.M)) == sorted(TOOL_NAMES)
    assert all(hasattr(Toolkit, f"_tool_{n}") and hasattr(AsyncToolkit, f"_tool_{n}") for n in TOOL_NAMES)


def api(r: httpx.Request) -> httpx.Response:
    p = r.url.path
    if r.url.host == "media.test":
        return httpx.Response(200, content=JPEG, headers={"content-type": "image/jpeg; q=1"})
    if p == "/v1/sources":
        return respond({"data": [CAMERA, SENSOR], "next_cursor": None})
    if p == "/v1/inbox":
        return respond({"agent_id": "agt_1", "data": [], "next_cursor": None})
    if p == "/v1/sources/src_cam/ask":
        return respond({"answer": "The door is closed.", "confidence": 0.9, "snapshot_url": "http://media.test/s.jpg"})
    if p == "/v1/sources/src_cam/now":
        return respond(
            {"source_id": "src_cam", "captured_at": "2026-10-16T10:00:00Z", "snapshot_url": "http://media.test/s.jpg"}
        )
    if p == "/v1/sources/src_tmp/now":
        readings = [{"sense": "temperature", "value": 22.5, "unit": "celsius", "measured_at": "2026-10-16T10:00:00Z"}]
        return respond({"source_id": "src_tmp", "captured_at": "2026-10-16T10:00:00Z", "readings": readings})
    if p == "/v1/sources/src_tmp/history":
        return respond(
            {
                "data": [
                    {"sense": "temperature", "value": 21.0, "unit": "celsius", "measured_at": "2026-10-16T09:00:00Z"}
                ]
            }
        )
    if p == "/v1/watches" and r.method == "POST":
        body = json.loads(r.content)
        return respond(
            {
                "id": "wat_1",
                "status": "active",
                "sources": body["sources"],
                "notify": body.get("notify"),
                "compiled": {},
            },
            201,
        )
    if p.startswith("/v1/watches/"):
        return respond(None, 204)
    if p == "/v1/memory/search":
        ev = {
            "id": "evt_1",
            "type": "detection.person",
            "source": {"id": "src_cam"},
            "occurred_at": "2026-10-16T10:02:00Z",
            "summary": "A person",
            "confidence": 0.9,
            "media": {"snapshot_url": "http://media.test/e.jpg"},
        }
        return respond({"data": [{"event": ev, "score": 0.87654}]})
    if p == "/v1/sources/src_cam/playback":
        return respond({"url": "http://media.test/p.m3u8", "expires_at": "2026-10-16T11:00:00Z"})
    if p == "/v1/clips":
        return respond({"id": "clp_1"}, 201)
    if p == "/v1/events":
        return respond({"data": [], "next_cursor": None})
    return respond({"error": {"code": "not_found", "message": f"no route {p}"}}, 404)


def toolkit() -> tuple[Toolkit, Recorder]:
    rec = Recorder(api)
    sp = Senseplane(
        api_key="test-key", base_url="http://api.test/v1", http_client=httpx.Client(transport=httpx.MockTransport(rec))
    )
    return Toolkit(sp), rec


def test_list_senses_and_look_with_a_question() -> None:
    tk, rec = toolkit()
    assert [s["id"] for s in tk.call("list_senses").value()["sources"]] == ["src_cam", "src_tmp"]
    r = tk.call("look", {"source": "front door", "question": "Is the door open?"})  # names, any case
    assert not r.is_error
    assert r.content[0] == {"type": "image", "data": base64.b64encode(JPEG).decode(), "mime_type": "image/jpeg"}
    assert r.value() == {
        "source": "src_cam",
        "answer": "The door is closed.",
        "confidence": 0.9,
        "snapshot_url": "http://media.test/s.jpg",
    }
    assert "authorization" not in next(x for x in rec.requests if x.url.host == "media.test").headers
    block = tk.call_anthropic({"type": "tool_use", "id": "toolu_1", "name": "look", "input": {"source": "src_cam"}})
    assert block["type"] == "tool_result" and block["tool_use_id"] == "toolu_1" and block["is_error"] is False
    assert block["content"][0] == {
        "type": "image",
        "source": {"type": "base64", "media_type": "image/jpeg", "data": base64.b64encode(JPEG).decode()},
    }
    assert json.loads(block["content"][1]["text"])["captured_at"] == "2026-10-16T10:00:00Z"


def test_watch_for_reports_to_the_agents_inbox() -> None:
    tk, rec = toolkit()
    r = tk.call(
        "watch_for",
        {
            "condition": "Someone at the door",
            "sources": ["Front door"],
            "active_hours": {"from": "18:00", "to": "06:00"},
        },
    )
    assert r.value()["watch_id"] == "wat_1" and "inbox" in r.value()["note"]
    created = json.loads(next(x for x in rec.requests if x.method == "POST" and x.url.path == "/v1/watches").content)
    assert created == {
        "instruction": "Someone at the door",
        "sources": ["src_cam"],
        "mode": "alert",
        "notify": [{"type": "agent", "id": "agt_1"}],
        "active_hours": {"from": "18:00", "to": "06:00"},
    }
    assert tk.call("stop_watching", {"watch_id": "wat_1"}).value() == {"stopped": "wat_1"}


def test_what_happened_read_environment_replay() -> None:
    tk, rec = toolkit()
    r = tk.call("what_happened", {"question": "Who came by?", "source": "Front door"}).value()
    assert r["events"] == [
        {
            "id": "evt_1",
            "type": "detection.person",
            "source": {"id": "src_cam"},
            "occurred_at": "2026-10-16T10:02:00Z",
            "summary": "A person",
            "confidence": 0.9,
            "snapshot_url": "http://media.test/e.jpg",
            "score": 0.877,
        }
    ]
    env = tk.call("read_environment", {"room": "kitchen"}).value()["sources"][0]
    assert env["readings"][0]["trend_last_hour"] == "rising" and env["readings"][0]["change_last_hour"] == 1.5
    out = tk.call(
        "replay", {"source": "src_cam", "from": "2026-10-16T10:00:00Z", "to": "2026-10-16T10:05:00Z", "save": True}
    ).value()
    assert out == {
        "source": "src_cam",
        "url": "http://media.test/p.m3u8",
        "expires_at": "2026-10-16T11:00:00Z",
        "gaps": [],
        "clip_id": "clp_1",
    }
    clip = next(x for x in rec.requests if x.url.path == "/v1/clips")
    assert json.loads(clip.content) == {
        "source": "src_cam",
        "from": "2026-10-16T10:00:00Z",
        "to": "2026-10-16T10:05:00Z",
    }
    assert "idempotency-key" in clip.headers


def test_errors_come_back_as_results(monkeypatch: pytest.MonkeyPatch) -> None:
    tk, _ = toolkit()
    r = tk.call("look", {"source": "Garage"})
    assert r.is_error and r.value() == {
        "error": {"code": "not_found", "message": 'no source "Garage"; call list_senses for the ids'}
    }
    assert tk.call("look", {"source": "src_tmp"}).value()["error"]["code"] == "forbidden_sense"
    assert tk.call("teleport").value()["error"]["code"] == "not_found"
    assert (
        tk.call("check_history", '{"instruction": "pills taken"}').value()["error"]["message"]
        == "no route /v1/activity/check"
    )
    slept: list[float] = []
    monkeypatch.setattr("senseplane._sync_tools.time.sleep", slept.append)
    r = tk.call("listen", {"source": "Front door", "seconds": 99})
    assert slept == [60] and r.value()["sounds"] == [] and "never transcribed" in r.value()["note"]


def test_openai_tool_calls_and_a_subset() -> None:
    tk, _ = toolkit()
    call = {"id": "call_1", "type": "function", "function": {"name": "list_senses", "arguments": "{}"}}
    msg = tk.call_openai(call)
    assert msg["role"] == "tool" and msg["tool_call_id"] == "call_1" and json.loads(msg["content"])["sources"]
    small = Toolkit(tk.client, tools=["look", "replay"])
    assert [t["name"] for t in small.anthropic()] == ["look", "replay"]
    assert small.call("list_senses").is_error


@pytest.mark.anyio
async def test_async_toolkit() -> None:
    sp = AsyncSenseplane(
        api_key="test-key",
        base_url="http://api.test/v1",
        http_client=httpx.AsyncClient(transport=httpx.MockTransport(api)),
    )
    tk = AsyncToolkit(sp)
    r = await tk.call("look", {"source": "Front door"})
    assert r.content[0]["type"] == "image" and r.value()["source"] == "src_cam"
    assert (await tk.call_anthropic({"id": "t1", "name": "list_senses", "input": {}}))["is_error"] is False


def test_langchain_adapter() -> None:
    pytest.importorskip("langchain_core")
    from senseplane.tools.langchain import langchain_tools

    tk, _ = toolkit()
    tools = langchain_tools(tk.client, tools=["list_senses", "look"])
    assert [t.name for t in tools] == ["list_senses", "look"]
    assert json.loads(tools[0].invoke({}))["sources"][0]["id"] == "src_cam"
    assert tools[1].args["source"]["description"] == "Source id or name"
