# Copyright 2026 The Senseplane Authors
# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import re
from collections.abc import Iterator
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import httpx
import pytest

from senseplane import (
    DEFAULT_BASE_URL,
    APIConnectionError,
    AuthenticationError,
    InternalServerError,
    NotFoundError,
    PermissionDeniedError,
    RateLimitError,
    Senseplane,
    SenseplaneError,
)
from senseplane._generated.api import OPERATIONS
from senseplane.types import Event, Source, WatchTestRequest

from .conftest import make_async_client, make_client, pages, respond

SOURCE: dict[str, Any] = {
    "id": "src_01JABCDEFGHJKMNPQRSTVWXYZ0",
    "name": "Front door",
    "type": "browser",
    "senses": ["video"],
    "status": "online",
    "record_audio": False,
    "zones": [],
    "privacy_masks": [],
    "created_at": "2026-10-16T09:00:00.000Z",
    "retention_days": None,
}
EVENT: dict[str, Any] = {
    "id": "evt_01JABCDEFGHJKMNPQRSTVWXYZ0",
    "type": "detection.person",
    "source": {"id": SOURCE["id"], "name": "Front door", "sense": "video"},
    "occurred_at": "2026-10-16T10:02:00.000Z",
    "summary": "A person at the door",
    "labels": ["person"],
    "confidence": 0.91,
    "value": None,
    "media": {"snapshot_url": None},
}


def test_sends_the_key_and_paginates_with_cursors() -> None:
    feed = pages([{**SOURCE, "id": "src_1"}], [{**SOURCE, "id": "src_2"}])
    client, rec = make_client(lambda r: respond(next(feed)))
    assert [s.id for s in client.sources.list(limit=1)] == ["src_1", "src_2"]
    assert rec.calls == ["GET /v1/sources?limit=1", "GET /v1/sources?limit=1&cursor=c1"]
    assert all(r.headers["authorization"] == "Bearer test-key" for r in rec.requests)
    assert rec.requests[0].headers["user-agent"].startswith("senseplane-python/")


def test_parses_responses_into_models() -> None:
    client, _ = make_client(lambda r: respond(SOURCE))
    src = client.sources.get(SOURCE["id"])
    assert isinstance(src, Source)
    assert src.created_at == datetime(2026, 10, 16, 9, tzinfo=timezone.utc)
    assert src.status == "online"


def test_keeps_values_this_sdk_doesnt_know() -> None:
    # A newer API: an event type and a field the generated models don't have yet.
    ev = {**EVENT, "type": "detection.drone", "heading": 270}
    client, _ = make_client(lambda r: respond(ev))
    got = client.events.get(EVENT["id"])
    assert isinstance(got, Event)
    assert str(got.type) == "detection.drone"
    assert got.model_extra == {"heading": 270}
    assert got.occurred_at == datetime(2026, 10, 16, 10, 2, tzinfo=timezone.utc)  # still typed
    assert got.source.name == "Front door"


def test_defaults_and_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("SENSEPLANE_API_KEY", raising=False)
    monkeypatch.delenv("SENSEPLANE_API_URL", raising=False)
    with pytest.raises(ValueError, match="SENSEPLANE_API_KEY"):
        Senseplane()
    assert Senseplane(api_key="k").base_url == DEFAULT_BASE_URL == "https://api.senseplane.com/v1"
    monkeypatch.setenv("SENSEPLANE_API_KEY", "from-env")
    monkeypatch.setenv("SENSEPLANE_API_URL", "http://localhost:8080/v1/")
    assert Senseplane().base_url == "http://localhost:8080/v1"


def test_encodes_queries_and_bodies() -> None:
    client, rec = make_client(lambda r: respond({"data": [], "next_cursor": None} if r.method == "GET" else {}))
    since = datetime(2026, 10, 16, 9, tzinfo=timezone.utc)
    list(client.events.list(source="src_1", type="detection.*", from_=since))
    client.inbox.list(unseen=True)
    client.watches.test(
        instruction="Someone at the door", sources=["Front door"], from_=since, to="2026-10-16T10:00:00Z"
    )
    client.watches.test(WatchTestRequest(instruction="Someone at the door", from_=since, to=since))
    client.watches.test({"instruction": "As written", "from": "x", "to": "y"})  # a dict goes as written
    assert rec.calls == [
        "GET /v1/events?source=src_1&type=detection.%2A&from=2026-10-16T09%3A00%3A00Z",
        "GET /v1/inbox?unseen=true",
        'POST /v1/watches/test {"instruction":"Someone at the door","sources":["Front door"],'
        '"from":"2026-10-16T09:00:00Z","to":"2026-10-16T10:00:00Z"}',
        'POST /v1/watches/test {"instruction":"Someone at the door","from":"2026-10-16T09:00:00Z",'
        '"to":"2026-10-16T09:00:00Z"}',
        'POST /v1/watches/test {"instruction":"As written","from":"x","to":"y"}',
    ]


def test_checks_keyword_arguments_against_the_model() -> None:
    client, rec = make_client(lambda r: respond({}))
    with pytest.raises(ValueError):  # pydantic's ValidationError is a ValueError
        client.watches.test(instruction="x", sources=["a"])  # too short, and from/to missing
    with pytest.raises(TypeError, match="SourceCreate has no field sensor_threshold"):
        client.sources.create(name="Kitchen", type="sensor", sensor_threshold={})
    assert rec.requests == []
    client.sources.create({"name": "Kitchen", "type": "sensor", "newer_field": 1})  # a dict goes as written
    assert rec.json(0) == {"name": "Kitchen", "type": "sensor", "newer_field": 1}


def test_short_forms_for_questions() -> None:
    client, rec = make_client(lambda r: respond({"answer": "Yes", "confidence": 0.8, "snapshot_url": "http://x/s.jpg"}))
    assert client.sources.ask("src_1", "Is the door open?").answer == "Yes"
    assert rec.json(0) == {"question": "Is the door open?"}


def test_creates_carry_an_idempotency_key_that_retries_reuse(no_sleep: list[float]) -> None:
    replies = iter([respond({"error": {"code": "service_unavailable"}}, 503), respond(SOURCE, 201)])
    client, rec = make_client(lambda r: next(replies))
    client.sources.create(name="Front door", type="browser")
    keys = [r.headers["idempotency-key"] for r in rec.requests]
    assert len(keys) == 2 and keys[0] == keys[1] and keys[0].startswith("sp-py-")
    assert len(no_sleep) == 1

    client, rec = make_client(lambda r: respond(SOURCE, 201))
    client.sources.create({"name": "Front door", "type": "browser"}, idempotency_key="setup-front-door")
    client.sources.create(name="Front door", type="browser")
    assert rec.requests[0].headers["idempotency-key"] == "setup-front-door"
    assert rec.requests[1].headers["idempotency-key"] != "setup-front-door"


def test_idempotency_keys_only_where_the_api_takes_them() -> None:
    client, _ = make_client(lambda r: respond({}))
    with pytest.raises(ValueError, match="idempotency"):
        client._transport.request("askSource", path={"id": "src_1"}, body={}, idempotency_key="k")
    idempotent = sorted(op for op, o in OPERATIONS.items() if o.idempotent)
    assert idempotent == ["createClip", "createGrant", "createSource", "createWatch", "createWebhook"]


def test_retries_safe_requests_with_backoff(no_sleep: list[float]) -> None:
    replies: Iterator[httpx.Response | Exception] = iter(
        [respond(None, 502), httpx.ConnectError("refused"), respond(SOURCE)]
    )

    def handler(r: httpx.Request) -> httpx.Response:
        x = next(replies)
        if isinstance(x, Exception):
            raise x
        return x

    client, rec = make_client(handler)
    assert client.sources.get("src_1").id == SOURCE["id"]
    assert len(rec.requests) == 3
    assert len(no_sleep) == 2 and 0.3 < no_sleep[0] < 0.7 and 0.7 < no_sleep[1] < 1.3


def test_doesnt_retry_a_post_that_may_have_run(no_sleep: list[float]) -> None:
    client, rec = make_client(lambda r: respond({"error": {"code": "internal", "message": "boom"}}, 503))
    with pytest.raises(InternalServerError):
        client.sources.ask("src_1", "Is anyone there?")
    assert len(rec.requests) == 1

    def timeout(r: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("slow")

    client, rec = make_client(timeout)
    with pytest.raises(APIConnectionError) as info:
        client.sources.ask("src_1", "Is anyone there?")
    assert info.value.timeout and info.value.status == 0 and len(rec.requests) == 1


def test_rate_limits_are_retried_after_retry_after(no_sleep: list[float]) -> None:
    replies = iter([respond({"error": {"code": "rate_limited"}}, 429, {"retry-after": "3"}), respond({"marked": 1})])
    client, rec = make_client(lambda r: next(replies))
    assert client.inbox.mark_seen(ids=["inb_1"]).marked == 1
    assert no_sleep == [3.0] and len(rec.requests) == 2


def test_gives_up_after_max_retries(no_sleep: list[float]) -> None:
    client, rec = make_client(lambda r: respond({"error": {"code": "rate_limited", "message": "slow down"}}, 429))
    with pytest.raises(RateLimitError):
        client.sources.get("src_1")
    assert len(rec.requests) == 3  # 1 + max_retries (2)
    client, rec = make_client(lambda r: respond(None, 503), max_retries=0)
    with pytest.raises(InternalServerError):
        client.sources.get("src_1")
    assert len(rec.requests) == 1
    with pytest.raises(InternalServerError):
        client.with_options(max_retries=1).sources.get("src_1")
    assert len(rec.requests) == 3


def test_maps_errors_to_typed_exceptions() -> None:
    body = {
        "error": {
            "code": "forbidden_sense",
            "message": "no audio grant",
            "request_id": "r1",
            "details": {"sense": "audio"},
        }
    }
    client, _ = make_client(lambda r: respond(body, 403))
    with pytest.raises(PermissionDeniedError) as info:
        client.sources.get("src_1")
    e = info.value
    assert isinstance(e, SenseplaneError)
    assert (e.status, e.code, e.message, e.request_id, e.details) == (
        403,
        "forbidden_sense",
        "no audio grant",
        "r1",
        {"sense": "audio"},
    )
    assert str(e) == "no audio grant"

    client, _ = make_client(lambda r: httpx.Response(404, text="<html>", headers={"x-request-id": "r2"}))
    with pytest.raises(NotFoundError) as nf:
        client.watches.get("wat_1")
    assert (nf.value.code, nf.value.request_id, nf.value.message) == ("unknown", "r2", "Not Found")

    client, _ = make_client(lambda r: respond({"error": {"code": "unauthorized", "message": "bad key"}}, 401))
    with pytest.raises(AuthenticationError):
        client.account.get()


def test_deletes_return_none_and_paths_are_escaped() -> None:
    client, rec = make_client(lambda r: respond(None, 204))
    client.watches.delete("wat/../1")
    assert rec.requests[0].url.raw_path == b"/v1/watches/wat%2F..%2F1"


def test_pushes_readings_with_an_integration_token() -> None:
    seen: list[str] = []

    def handler(r: httpx.Request) -> httpx.Response:
        seen.append(f"{r.method} {r.url.path} {r.headers['authorization']}")
        if r.method == "GET":
            return respond({"source": {**SOURCE, "id": "src_s", "type": "sensor"}})
        return respond({"accepted": 1, "events": []}, 202)

    sp = Senseplane(
        api_key="sit_test", base_url="http://x/v1", http_client=httpx.Client(transport=httpx.MockTransport(handler))
    )
    source = sp.integration.get().source
    reading = {"sense": "temperature", "value": 21, "unit": "celsius", "at": "2026-10-16T10:00:00Z"}
    assert sp.sources.push_readings(source.id, readings=[reading]).accepted == 1
    assert seen == ["GET /v1/integration Bearer sit_test", "POST /v1/sources/src_s/readings Bearer sit_test"]


def test_team_endpoints() -> None:
    def handler(r: httpx.Request) -> httpx.Response:
        if r.method == "DELETE":
            return respond(None, 204)
        if r.url.path == "/v1/members":
            return respond({"data": [{"id": "usr_1", "role": "owner"}], "next_cursor": None})
        return respond({})

    client, rec = make_client(handler)
    client.me.switch_workspace("acc_2")
    client.invites.create(email="a@example.test", role="viewer")
    client.members.update("usr_1", "admin")
    client.members.remove("usr_1")
    assert [m.id for m in client.members.list()] == ["usr_1"]
    assert rec.calls == [
        'POST /v1/me/switch {"account_id":"acc_2"}',
        'POST /v1/invites {"email":"a@example.test","role":"viewer"}',
        'PATCH /v1/members/usr_1 {"role":"admin"}',
        "DELETE /v1/members/usr_1",
        "GET /v1/members",
    ]


def test_patch_can_clear_a_field() -> None:
    client, rec = make_client(lambda r: respond({}))
    client.channels.update("chn_1", muted_until=None)
    client.conversations.feedback("cnv_1", "msg_1", None)
    assert rec.calls == [
        'PATCH /v1/channels/chn_1 {"muted_until":null}',
        'POST /v1/conversations/cnv_1/messages/msg_1/feedback {"value":null}',
    ]


def test_every_spec_operation_has_a_method() -> None:
    source = (Path(__file__).parents[1] / "src" / "senseplane" / "_async_client.py").read_text()
    used = set(re.findall(r'"([a-zA-Z]+)"', source))
    missing = sorted(set(OPERATIONS) - used)
    assert missing == [], f"operations without a client method: {missing}"


@pytest.mark.anyio
async def test_async_client_paginates_retries_and_raises(no_sleep: list[float]) -> None:
    feed = pages([EVENT], [{**EVENT, "id": "evt_2"}])
    replies = iter([respond(None, 503)])

    def handler(r: httpx.Request) -> httpx.Response:
        if r.url.path == "/v1/events" and "cursor" in r.url.params:
            return next(replies, None) or respond(next(feed))
        if r.url.path == "/v1/events":
            return respond(next(feed))
        return respond({"error": {"code": "not_found", "message": "watch not found"}}, 404)

    async with make_async_client(handler)[0] as client:
        assert [e.id async for e in client.events.list()] == [EVENT["id"], "evt_2"]
        assert len(no_sleep) == 1
        with pytest.raises(NotFoundError):
            await client.watches.get("wat_1")


@pytest.mark.anyio
async def test_async_creates_use_idempotency_keys() -> None:
    client, rec = make_async_client(lambda r: respond({"id": "wat_1"}, 201))
    await client.watches.create(
        instruction="Tell me if a package is left", sources=["Front door"], idempotency_key="w1"
    )
    assert rec.requests[0].headers["idempotency-key"] == "w1"
    assert rec.json(0) == {"instruction": "Tell me if a package is left", "sources": ["Front door"]}
    await client.close()
