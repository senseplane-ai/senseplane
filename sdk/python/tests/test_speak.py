# Copyright 2026 The Senseplane Authors
# SPDX-License-Identifier: Apache-2.0
"""Talk-back (ADR 0069): the speak tool and the client's speak and speak_messages."""

from __future__ import annotations

import json

import httpx
import pytest

from senseplane import AsyncSenseplane, Senseplane, SenseplaneError
from senseplane.tools import AsyncToolkit, Toolkit

from .conftest import Recorder, respond

CAMERA = {
    "id": "src_cam",
    "name": "Front door",
    "type": "browser",
    "senses": ["video", "speak"],
    "speaker": True,
    "status": "online",
    "record_audio": False,
    "retention_days": None,
    "zones": [],
    "privacy_masks": [],
    "created_at": "2026-11-03T10:00:00Z",
}
MSG = {
    "id": "spk_1",
    "source_id": "src_cam",
    "kind": "agent",
    "text": "Hello",
    "status": "playing",
    "message": None,
    "duration_ms": 2400,
    "clip_url": "http://api.test/media/t/speak.wav",
    "created_at": "2026-11-03T10:00:00Z",
}
TOO_LONG = "That message would take 41 seconds; the most is 30. Say less."


def api(r: httpx.Request) -> httpx.Response:
    p = r.url.path
    if p == "/v1/sources":
        return respond({"data": [CAMERA], "next_cursor": None})
    if p == "/v1/sources/src_cam/speak" and r.method == "POST":
        text = json.loads(r.content)["text"]
        if "everything" in text:
            refused = {**MSG, "id": "spk_2", "status": "refused", "message": TOO_LONG, "clip_url": None}
            return respond(
                {"error": {"code": "message_too_long", "message": TOO_LONG, "details": {"message": refused}}}, 400
            )
        return respond({**MSG, "text": text})
    if p == "/v1/speak-messages":
        return respond({"data": [MSG]})
    if p == "/v1/speak-messages/spk_1":
        return respond(MSG)
    return respond({"error": {"code": "not_found", "message": f"no route {p}"}}, 404)


def client() -> tuple[Senseplane, Recorder]:
    rec = Recorder(api)
    return Senseplane(
        api_key="k", base_url="http://api.test/v1", http_client=httpx.Client(transport=httpx.MockTransport(rec))
    ), rec


def test_speak_and_what_was_said() -> None:
    sp, rec = client()
    m = sp.sources.speak("src_cam", "Hello")
    assert m.status == "playing" and m.duration_ms == 2400
    assert json.loads(rec.requests[-1].content) == {"text": "Hello"}
    assert [x.id for x in sp.speak_messages.list(source="src_cam", limit=5)] == ["spk_1"]
    assert rec.requests[-1].url.params["source"] == "src_cam"
    assert sp.speak_messages.get("spk_1").clip_url == "http://api.test/media/t/speak.wav"
    with pytest.raises(SenseplaneError) as e:
        sp.sources.speak("src_cam", "everything that happened")
    assert e.value.code == "message_too_long"
    assert e.value.details is not None and e.value.details["message"]["status"] == "refused"


def test_speak_tool() -> None:
    sp, _ = client()
    tk = Toolkit(sp)
    assert tk.call("list_senses").value()["sources"][0]["speaker"] is True
    r = tk.call("speak", {"source": "front door", "text": "Hello, this is an automated assistant."})
    assert not r.is_error
    assert r.value() == {
        "message_id": "spk_1",
        "source": "src_cam",
        "status": "playing",
        "duration_ms": 2400,
        "clip_url": "http://api.test/media/t/speak.wav",
        "note": "It is playing on the camera now, after a short chime.",
    }
    bad = tk.call("speak", {"source": "src_cam", "text": "everything that happened today"})
    assert bad.is_error
    assert bad.value()["error"]["code"] == "message_too_long" and bad.value()["status"] == "refused"
    assert tk.call("speak", {"source": "src_cam", "text": "  "}).is_error


@pytest.mark.anyio
async def test_async_speak_tool() -> None:
    rec = Recorder(api)
    sp = AsyncSenseplane(
        api_key="k", base_url="http://api.test/v1", http_client=httpx.AsyncClient(transport=httpx.MockTransport(rec))
    )
    r = await AsyncToolkit(sp).call("speak", {"source": "src_cam", "text": "Hello"})
    assert r.value()["status"] == "playing"
    await sp.close()
