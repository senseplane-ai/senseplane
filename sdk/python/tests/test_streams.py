# Copyright 2026 The Senseplane Authors
# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import json
from collections.abc import Iterator
from dataclasses import dataclass
from typing import Any

import httpx
import pytest

from senseplane import APIConnectionError, AsyncSenseplaneDemo, NotFoundError, SenseplaneDemo, ServerSentEvent
from senseplane._base import SSEDecoder
from senseplane.types import ConversationStreamEvent2, ConversationStreamEvent5

from .conftest import Recorder, make_async_client, make_client, respond, sse

ANSWER = [
    'event: status\ndata: {"text":"Searching Front door…"}\n\nevent: mo',
    'ment\ndata: {"source_id":"src_1","source_name":"Front door","at":"2026-10-16T10:02:00Z","label":"A person",'
    '"snapshot_url":null}\n\n: keep-alive\n\n',
    'event: delta\ndata: {"text":"At 10:02 [1]."}\n\nevent: done\ndata: {"message":{"id":"msg_1","role":"assistant",'
    '"content":"At 10:02 [1].","moments":[],"created_at":"2026-10-16T10:03:00Z"}}\n\n',
    'event: delta\ndata: {"text":"never read"}\n\n',
]


@dataclass
class Session:
    id: str
    token: str


SESSION = Session("dem_1", "demo-token")


def test_decoder_follows_the_event_stream_format() -> None:
    d = SSEDecoder()
    lines = ["retry: 3000", "id: 7", "event: status", "data: {", 'data: "a": 1}', "", ": comment", "data: plain\r", ""]
    out = [e for e in (d.feed(x) for x in lines) if e is not None]
    assert out == [ServerSentEvent("status", {"a": 1}, "7"), ServerSentEvent("message", "plain", "7")]
    assert d.retry_ms == 3000


def test_streams_an_answer_as_typed_events() -> None:
    client, rec = make_client(lambda r: sse(*ANSWER))
    events = list(client.conversations.stream("cnv_1", "When did someone come?"))
    assert [e.event for e in events] == ["status", "moment", "delta", "done"]
    text = "".join(e.data.text for e in events if isinstance(e, ConversationStreamEvent2))
    assert text == "At 10:02 [1]."
    done = events[-1]
    assert isinstance(done, ConversationStreamEvent5) and done.data.message.id == "msg_1"
    r = rec.requests[0]
    assert (r.method, str(r.url)) == ("POST", "http://api.test/v1/conversations/cnv_1/messages")
    assert r.headers["accept"] == "text/event-stream" and r.headers["authorization"] == "Bearer test-key"
    assert json.loads(r.content) == {"content": "When did someone come?"}


def test_unknown_stream_events_pass_through() -> None:
    client, _ = make_client(lambda r: sse('event: thinking\ndata: {"n":1}\n\nevent: error\ndata: {"error":{}}\n\n'))
    events = list(client.conversations.stream("cnv_1", content="Hi"))
    assert events[0] == ServerSentEvent("thinking", {"n": 1})
    assert events[1].event == "error"


def test_errors_before_the_stream_are_raised() -> None:
    body = {"error": {"code": "not_found", "message": "conversation not found", "request_id": "r2"}}
    client, _ = make_client(lambda r: respond(body, 404))
    with pytest.raises(NotFoundError):
        list(client.conversations.stream("cnv_x", "Hi"))


class Broken(httpx.SyncByteStream):
    """A stream that sends some bytes, then the connection drops."""

    def __init__(self, data: str) -> None:
        self.data = data

    def __iter__(self) -> Iterator[bytes]:
        yield self.data.encode()
        raise httpx.ReadError("connection reset")


def demo(handler: Any) -> tuple[SenseplaneDemo, Recorder]:
    rec = Recorder(handler)
    return SenseplaneDemo("http://api.test/v1", http_client=httpx.Client(transport=httpx.MockTransport(rec))), rec


def test_demo_stream_reconnects_until_ended(no_sleep: list[float]) -> None:
    replies = iter(
        [
            httpx.Response(200, stream=Broken('id: 1\nevent: status\ndata: {"camera":"online"}\n\n')),
            sse('event: event\ndata: {"id":"evt_1","summary":"A person"}\n\n'),  # ends without `ended`
            sse('event: ended\ndata: {"reason":"expired"}\n\nevent: status\ndata: {}\n\n'),
        ]
    )
    client, rec = demo(lambda r: next(replies))
    got = [(e.event, e.data) for e in client.stream(SESSION)]
    assert got == [
        ("status", {"camera": "online"}),
        ("event", {"id": "evt_1", "summary": "A person"}),
        ("ended", {"reason": "expired"}),
    ]
    assert len(rec.requests) == 3 and len(no_sleep) == 2
    assert rec.requests[0].headers["authorization"] == "Bearer demo-token"
    assert "last-event-id" not in rec.requests[0].headers
    assert rec.requests[1].headers["last-event-id"] == "1"


def test_demo_stream_gives_up_after_max_reconnects(no_sleep: list[float]) -> None:
    client, rec = demo(lambda r: httpx.Response(200, stream=Broken("")))
    with pytest.raises(APIConnectionError):
        list(client.stream(SESSION, max_reconnects=2))
    assert len(rec.requests) == 3
    client, rec = demo(lambda r: respond({"error": {"code": "not_found", "message": "session ended"}}, 404))
    with pytest.raises(NotFoundError):
        list(client.stream(SESSION))
    assert len(rec.requests) == 1


def test_demo_start_ask_end() -> None:
    def handler(r: httpx.Request) -> httpx.Response:
        if r.method == "POST" and r.url.path.endswith("/sessions"):
            return respond({"id": "dem_1", "token": "demo-token"}, 201)
        if r.method == "DELETE":
            return respond(None, 204)
        return respond({"answer": "A cup on the desk", "from": "live"})

    client, rec = demo(handler)
    s = client.start()
    assert client.ask(s, "What's on the desk?").answer == "A cup on the desk"
    client.end(s)
    assert "authorization" not in rec.requests[0].headers
    assert [r.headers.get("authorization") for r in rec.requests[1:]] == ["Bearer demo-token"] * 2


def event(id: str, at: str) -> dict[str, Any]:
    return {
        "id": id,
        "type": "sensor.threshold",
        "source": {"id": "src_1", "sense": "temperature"},
        "occurred_at": at,
        "summary": id,
        "labels": [],
        "confidence": None,
        "value": None,
        "media": {},
    }


def test_event_stream_polls_for_new_events_oldest_first(no_sleep: list[float]) -> None:
    polls = iter(
        [
            [event("evt_0", "2026-10-16T09:59:00Z")],  # before `since`: skipped
            httpx.ConnectError("api restarting"),
            [event("evt_2", "2026-10-16T10:00:02Z"), event("evt_1", "2026-10-16T10:00:01Z")],
            [event("evt_3", "2026-10-16T10:00:03Z"), event("evt_2", "2026-10-16T10:00:02Z")],  # evt_2 again: dropped
        ]
    )

    def handler(r: httpx.Request) -> httpx.Response:
        x = next(polls)
        if isinstance(x, Exception):
            raise x
        return respond({"data": x, "next_cursor": None})

    client, rec = make_client(handler, max_retries=0)
    stream = client.events.stream(source="src_1", since="2026-10-16T10:00:00Z", poll_interval=5)
    got = [next(stream).id for _ in range(3)]
    assert got == ["evt_1", "evt_2", "evt_3"]
    assert rec.requests[0].url.params["from"] == "2026-10-16T09:58:00Z"  # since minus the lookback
    assert rec.requests[0].url.params["source"] == "src_1"
    assert 5 in no_sleep  # the poll interval


def test_event_stream_without_since_starts_now(no_sleep: list[float]) -> None:
    polls = iter(
        [
            [event("evt_old", "2026-01-01T00:00:00Z")],
            [event("evt_new", "2099-01-01T00:00:00Z"), event("evt_old", "2026-01-01T00:00:00Z")],
        ]
    )
    client, _ = make_client(lambda r: respond({"data": next(polls), "next_cursor": None}))
    assert next(client.events.stream()).id == "evt_new"


@pytest.mark.anyio
async def test_async_streams(no_sleep: list[float]) -> None:
    client, _ = make_async_client(lambda r: sse(*ANSWER))
    names = [e.event async for e in client.conversations.stream("cnv_1", "When?")]
    assert names == ["status", "moment", "delta", "done"]

    replies = iter(
        [sse('event: status\ndata: {"camera":"pending"}\n\n'), sse('event: ended\ndata: {"reason":"x"}\n\n')]
    )
    rec = Recorder(lambda r: next(replies))
    d = AsyncSenseplaneDemo("http://api.test/v1", http_client=httpx.AsyncClient(transport=httpx.MockTransport(rec)))
    assert [e.event async for e in d.stream(SESSION)] == ["status", "ended"]

    polls = iter([[event("evt_1", "2026-10-16T10:00:01Z")]])
    c2, _ = make_async_client(lambda r: respond({"data": next(polls, []), "next_cursor": None}))
    agen = c2.events.stream(since="2026-10-16T10:00:00Z")
    assert (await agen.__anext__()).id == "evt_1"
    await agen.aclose()  # type: ignore[attr-defined]
