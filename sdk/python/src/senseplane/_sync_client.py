# Copyright 2026 The Senseplane Authors
# SPDX-License-Identifier: Apache-2.0
# Generated from _async_client.py. Do not edit; run `uv run python scripts/codegen.py` in sdk/python.

from __future__ import annotations

import time
from collections.abc import Iterator, Mapping
from datetime import datetime, timedelta, timezone
from typing import Any, Literal, Protocol

import httpx
from pydantic import BaseModel

from ._base import (
    DEFAULT_MAX_RETRIES,
    DEFAULT_TIMEOUT,
    Prepared,
    ServerSentEvent,
    SSEDecoder,
    api_error,
    body_of,
    connection_error,
    decode,
    default_headers,
    parse,
    prepare,
    resolve_api_key,
    resolve_base_url,
    retry_delay,
    should_retry_error,
    should_retry_status,
    sse_headers,
    to_request,
)
from ._errors import APIConnectionError, InternalServerError, RateLimitError
from ._generated import models as m
from ._webhooks import verify_webhook

Body = BaseModel | Mapping[str, Any] | None
"""A request body: a model, a dict with the API's field names, or None (then keyword arguments)."""
When = datetime | str
"""A time: an aware datetime, or an ISO 8601 string as the API writes them."""
ConversationEvent = (
    m.ConversationStreamEvent1
    | m.ConversationStreamEvent2
    | m.ConversationStreamEvent3
    | m.ConversationStreamEvent4
    | m.ConversationStreamEvent5
    | m.ConversationStreamEvent6
)
"""One event of a streamed answer: status, delta, moment, suggested_watch, then done (or error)."""
_CONVERSATION_EVENTS = frozenset({"status", "delta", "moment", "suggested_watch", "done", "error"})

__all__ = ["Senseplane", "SenseplaneDemo"]


class DemoSessionRef(Protocol):
    """A demo session, or anything with its `id` and `token`."""

    @property
    def id(self) -> str: ...

    @property
    def token(self) -> str: ...


class Transport:
    """Sends requests with the key, timeouts and retries; one per client (and its copies)."""

    def __init__(
        self,
        *,
        api_key: str | None,
        base_url: str,
        timeout: float | httpx.Timeout | None,
        max_retries: int,
        http_client: httpx.Client | None,
        headers: Mapping[str, str] | None = None,
    ) -> None:
        self.base_url = base_url
        self.timeout = timeout
        self.max_retries = max_retries
        self.headers = {**default_headers(api_key), **(headers or {})}
        self.owns_http = http_client is None
        self.http = http_client or httpx.Client(follow_redirects=False)

    def copy(self, *, timeout: float | httpx.Timeout | Literal[False] | None, max_retries: int | None) -> Transport:
        t = Transport.__new__(Transport)
        t.__dict__.update(self.__dict__)
        t.owns_http = False
        if timeout is not False:
            t.timeout = timeout
        if max_retries is not None:
            t.max_retries = max_retries
        return t

    def _prepare(self, operation: str, token: str | None, extra: Mapping[str, str] | None, **kw: Any) -> Prepared:
        headers = dict(self.headers)
        if token is not None:
            headers["authorization"] = f"Bearer {token}"
        return prepare(operation, headers={**headers, **(extra or {})}, **kw)

    def send(self, p: Prepared, *, stream: bool = False) -> httpx.Response:
        attempt = 0
        while True:
            request = to_request(self.http, p, self.base_url, self.timeout)
            try:
                response = self.http.send(request, stream=stream)
            except httpx.TransportError as err:
                if attempt < self.max_retries and should_retry_error(p, err):
                    time.sleep(retry_delay(attempt))
                    attempt += 1
                    continue
                raise connection_error(err) from err
            if response.status_code < 400:
                return response
            response.read()
            response.close()
            if attempt < self.max_retries and should_retry_status(p, response.status_code):
                time.sleep(retry_delay(attempt, response.headers.get("retry-after")))
                attempt += 1
                continue
            raise api_error(response.status_code, response.headers, response.content, response.reason_phrase)

    def request(
        self,
        operation: str,
        *,
        path: Mapping[str, str] | None = None,
        query: Mapping[str, Any] | None = None,
        body: Any = None,
        idempotency_key: str | None = None,
        token: str | None = None,
    ) -> Any:
        p = self._prepare(operation, token, None, path=path, query=query, body=body, idempotency_key=idempotency_key)
        return decode(self.send(p))

    def sse(
        self,
        operation: str,
        *,
        path: Mapping[str, str] | None = None,
        body: Any = None,
        token: str | None = None,
        last_event_id: str | None = None,
    ) -> Iterator[ServerSentEvent]:
        """Opens a text/event-stream and yields its events until the server ends it."""
        p = self._prepare(operation, token, sse_headers(last_event_id), path=path, body=body)
        response = self.send(p, stream=True)
        decoder = SSEDecoder()
        try:
            for line in response.iter_lines():
                event = decoder.feed(line)
                if event is not None:
                    yield event
        except httpx.TransportError as err:
            raise connection_error(err) from err
        finally:
            response.close()

    def paginate(
        self, operation: str, page: type[BaseModel], *, path: Mapping[str, str] | None = None, query: Mapping[str, Any]
    ) -> Iterator[Any]:
        """Every item of a cursor-paginated list, fetching the next page as the last one runs out."""
        cursor: str | None = None
        while True:
            result: Any = parse(page, self.request(operation, path=path, query={**query, "cursor": cursor}))
            for item in result.data:
                yield item
            cursor = result.next_cursor
            if not cursor:
                return

    def close(self) -> None:
        if self.owns_http:
            self.http.close()


class _Resource:
    def __init__(self, transport: Transport) -> None:
        self._t = transport


def _ask_body(body: Body | str, fields: dict[str, Any], key: str) -> Body:
    if isinstance(body, str):
        fields[key] = body
        return None
    return body


class Sources(_Resource):
    """Cameras, microphones and sensors."""

    def create(self, body: Body = None, /, *, idempotency_key: str | None = None, **fields: Any) -> m.Source:
        """Adds a source (`name`, `type`: browser, sensor, whip or rtsp). Safe to retry: see `idempotency_key`."""
        data = self._t.request(
            "createSource", body=body_of(m.SourceCreate, body, fields), idempotency_key=idempotency_key
        )
        return parse(m.Source, data)

    def get(self, id: str) -> m.Source:
        return parse(m.Source, self._t.request("getSource", path={"id": id}))

    def update(self, id: str, body: Body = None, /, **fields: Any) -> m.Source:
        data = self._t.request("updateSource", path={"id": id}, body=body_of(m.SourceUpdate, body, fields))
        return parse(m.Source, data)

    def delete(self, id: str) -> None:
        self._t.request("deleteSource", path={"id": id})

    def list(self, *, limit: int | None = None) -> Iterator[m.Source]:
        """Every source; `limit` is the page size."""
        return self._t.paginate("listSources", m.SourcesGetResponse, query={"limit": limit})

    def now(self, id: str) -> m.SourceNow:
        """The latest snapshot and readings."""
        return parse(m.SourceNow, self._t.request("getSourceNow", path={"id": id}))

    def ask(self, id: str, body: Body | str = None, /, **fields: Any) -> m.AskResponse:
        """Asks about what the camera shows now: `ask(id, "Is the door open?")`."""
        body = _ask_body(body, fields, "question")
        data = self._t.request("askSource", path={"id": id}, body=body_of(m.AskRequest, body, fields))
        return parse(m.AskResponse, data)

    def playback(self, id: str, *, from_: When, to: When) -> m.PlaybackResponse:
        """A signed playback URL for a recorded range (with any gaps)."""
        data = self._t.request("getPlayback", path={"id": id}, query={"from": from_, "to": to})
        return parse(m.PlaybackResponse, data)

    def timeline(self, id: str, *, from_: When | None = None, to: When | None = None) -> m.TimelineResponse:
        data = self._t.request("getTimeline", path={"id": id}, query={"from": from_, "to": to})
        return parse(m.TimelineResponse, data)

    def history(
        self, id: str, *, from_: When | None = None, to: When | None = None, sense: str | None = None
    ) -> m.HistoryResponse:
        """Sensor readings over a range."""
        query = {"from": from_, "to": to, "sense": sense}
        return parse(m.HistoryResponse, self._t.request("getHistory", path={"id": id}, query=query))

    def push_readings(self, id: str, body: Body = None, /, **fields: Any) -> m.SourcesIdReadingsPostResponse:
        """Sends sensor readings (`readings=[{"sense": "temperature", "value": 21, "unit": "celsius", "at": ...}]`).

        Works with an account key or the source's sensor integration token as the client's key.
        """
        data = self._t.request("postReadings", path={"id": id}, body=body_of(m.ReadingsRequest, body, fields))
        return parse(m.SourcesIdReadingsPostResponse, data)

    def rotate_capture_link(self, id: str) -> m.Source:
        """A new capture link; every earlier link for this source stops working."""
        return parse(m.Source, self._t.request("rotateCaptureLink", path={"id": id}))

    def live(self, id: str, body: Body = None, /, **fields: Any) -> m.LiveViewSession:
        """Starts a live view: a single-use media token and signalling URL (ADR 0042)."""
        data = self._t.request("startLiveView", path={"id": id}, body=body_of(m.LiveViewRequest, body, fields))
        return parse(m.LiveViewSession, data)

    def rotate_ingest_token(self, id: str) -> m.SourcesIdIngestTokenPostResponse:
        """A new WHIP, bridge or sensor integration token (shown once); the old one stops working."""
        data = self._t.request("rotateIngestToken", path={"id": id})
        return parse(m.SourcesIdIngestTokenPostResponse, data)

    def revoke_ingest_token(self, id: str) -> None:
        self._t.request("revokeIngestToken", path={"id": id})

    def pause(self, id: str) -> m.Source:
        """Stops recording and analysis until `resume`; pushes are refused while paused."""
        return parse(m.Source, self._t.request("pauseSource", path={"id": id}))

    def resume(self, id: str) -> m.Source:
        return parse(m.Source, self._t.request("resumeSource", path={"id": id}))


class Live(_Resource):
    """Live view sessions started with `sources.live`."""

    def keepalive(self, session_id: str) -> m.LiveSessionIdKeepalivePostResponse:
        data = self._t.request("keepLiveViewAlive", path={"session_id": session_id})
        return parse(m.LiveSessionIdKeepalivePostResponse, data)


class Bridge(_Resource):
    """For a bridge, with its bridge token as the client's key."""

    def config(self) -> m.BridgeConfig:
        return parse(m.BridgeConfig, self._t.request("getBridgeConfig"))

    def claim_camera(self, body: Body = None, /, **fields: Any) -> m.BridgeCamera:
        """Registers (or finds) the camera at `rtsp_url` on this bridge."""
        data = self._t.request("claimBridgeCamera", body=body_of(m.BridgeCamerasPostRequest, body, fields))
        return parse(m.BridgeCamera, data)

    def health(self, body: Body = None, /, **fields: Any) -> None:
        self._t.request("postBridgeHealth", body=body_of(m.BridgeHealth, body, fields))


class Integration(_Resource):
    """For a sensor integration, with its token as the client's key."""

    def get(self) -> m.IntegrationGetResponse:
        """The source this token feeds (then `sources.push_readings`)."""
        return parse(m.IntegrationGetResponse, self._t.request("getIntegration"))


class Capture(_Resource):
    def join(self, ticket: str, *, device: str | None = None) -> m.CaptureJoinPostResponse:
        """Exchanges a capture link's ticket for a publishing token (no API key needed)."""
        body: dict[str, Any] = {"ticket": ticket, **({"device": device} if device else {})}
        return parse(m.CaptureJoinPostResponse, self._t.request("captureJoin", body=body))


class Watches(_Resource):
    """Plain-language watches over one or more sources."""

    def create(self, body: Body = None, /, *, idempotency_key: str | None = None, **fields: Any) -> m.Watch:
        """Starts a watch: `create(instruction="Tell me if a package is left", sources=["Front door"])`."""
        data = self._t.request(
            "createWatch", body=body_of(m.WatchCreate, body, fields), idempotency_key=idempotency_key
        )
        return parse(m.Watch, data)

    def get(self, id: str) -> m.Watch:
        return parse(m.Watch, self._t.request("getWatch", path={"id": id}))

    def update(self, id: str, body: Body = None, /, **fields: Any) -> m.Watch:
        data = self._t.request("updateWatch", path={"id": id}, body=body_of(m.WatchUpdate, body, fields))
        return parse(m.Watch, data)

    def delete(self, id: str) -> None:
        self._t.request("deleteWatch", path={"id": id})

    def list(self, *, limit: int | None = None) -> Iterator[m.Watch]:
        return self._t.paginate("listWatches", m.WatchesGetResponse, query={"limit": limit})

    def test(self, body: Body = None, /, **fields: Any) -> m.WatchTestResult:
        """Backtests a watch over recorded history; at most `max_checks` model checks (AI checks)."""
        data = self._t.request("testWatch", body=body_of(m.WatchTestRequest, body, fields))
        return parse(m.WatchTestResult, data)

    def packs(self) -> m.WatchPackList:
        """Ready-made sets of watches (eldercare, home, shop, site; ADR 0057)."""
        return parse(m.WatchPackList, self._t.request("listWatchPacks"))

    def apply_pack(self, id: str, body: Body = None, /, **fields: Any) -> m.WatchPackApplied:
        data = self._t.request("applyWatchPack", path={"id": id}, body=body_of(m.WatchPackApply, body, fields))
        return parse(m.WatchPackApplied, data)


class Inbox(_Resource):
    """Events routed to an agent by its watches' `notify` (ADR 0043). Agent keys read their own inbox."""

    def list(
        self,
        *,
        agent: str | None = None,
        unseen: bool | None = None,
        limit: int | None = None,
        cursor: str | None = None,
    ) -> m.InboxGetResponse:
        """One page of the inbox (`agent_id`, `data`, `next_cursor`); account keys pass `agent`."""
        query = {"agent": agent, "unseen": unseen, "limit": limit, "cursor": cursor}
        return parse(m.InboxGetResponse, self._t.request("listInbox", query=query))

    def mark_seen(self, body: Body = None, /, **fields: Any) -> m.InboxSeenPostResponse:
        """`mark_seen(ids=[...])` or `mark_seen(all=True)`."""
        data = self._t.request("markInboxSeen", body=body_of(m.InboxSeenRequest, body, fields))
        return parse(m.InboxSeenPostResponse, data)


def _when(value: Any) -> datetime:
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    return datetime.fromisoformat(str(value).replace("Z", "+00:00"))


class Events(_Resource):
    """What the sources saw and heard, newest first."""

    def list(
        self,
        *,
        source: str | None = None,
        type: str | None = None,
        from_: When | None = None,
        to: When | None = None,
        limit: int | None = None,
    ) -> Iterator[m.Event]:
        """Every matching event, newest first. `type` takes patterns such as `detection.*`."""
        query = {"source": source, "type": type, "from": from_, "to": to, "limit": limit}
        return self._t.paginate("listEvents", m.EventsGetResponse, query=query)

    def get(self, id: str) -> m.Event:
        return parse(m.Event, self._t.request("getEvent", path={"id": id}))

    def feedback(self, id: str, feedback: Literal["relevant", "not_relevant"]) -> None:
        self._t.request("postFeedback", path={"id": id}, body={"feedback": feedback})

    def stream(
        self,
        *,
        source: str | None = None,
        type: str | None = None,
        since: When | None = None,
        poll_interval: float = 2.0,
        lookback: float = 120.0,
        max_failures: int | None = None,
    ) -> Iterator[m.Event]:
        """New events as they arrive, oldest first, until you stop iterating.

        The API has no push stream for events (webhooks and agent inboxes are the push
        paths), so this polls `GET /events` every `poll_interval` seconds. Each poll looks
        back `lookback` seconds and drops events already yielded, so an event recorded a
        little after it happened isn't missed. From `since` when given, else from now.
        Network failures, 5xx and 429 are retried with backoff (`max_failures` in a row,
        unlimited by default); other errors are raised.
        """
        start = _when(since) if since is not None else datetime.now(timezone.utc)
        watermark = start
        seen: dict[str, datetime] = {}
        primed = since is not None  # without `since`, events from before now are skipped
        failures = 0
        while True:
            fresh: list[m.Event] = []
            try:
                for ev in self.list(source=source, type=type, from_=watermark - timedelta(seconds=lookback)):
                    if ev.id not in seen:
                        fresh.append(ev)
            except (APIConnectionError, InternalServerError, RateLimitError):
                failures += 1
                if max_failures is not None and failures > max_failures:
                    raise
                time.sleep(retry_delay(min(failures, 5)))
                continue
            failures = 0
            fresh.sort(key=lambda e: (_when(e.occurred_at), e.id))
            for ev in fresh:
                at = _when(ev.occurred_at)
                seen[ev.id] = at
                watermark = max(watermark, at)
                if primed and at >= start:
                    yield ev
            primed = True
            horizon = watermark - timedelta(seconds=lookback * 2)
            for key in [k for k, at in seen.items() if at < horizon]:
                del seen[key]
            time.sleep(poll_interval)


class Clips(_Resource):
    """Saved recordings of a range (playback links that don't expire with retention)."""

    def create(self, body: Body = None, /, *, idempotency_key: str | None = None, **fields: Any) -> m.Clip:
        """`create(source=id, from_=..., to=...)`."""
        data = self._t.request("createClip", body=body_of(m.ClipCreate, body, fields), idempotency_key=idempotency_key)
        return parse(m.Clip, data)

    def get(self, id: str) -> m.Clip:
        return parse(m.Clip, self._t.request("getClip", path={"id": id}))

    def delete(self, id: str) -> None:
        self._t.request("deleteClip", path={"id": id})

    def list(self, *, limit: int | None = None) -> Iterator[m.Clip]:
        return self._t.paginate("listClips", m.ClipsGetResponse, query={"limit": limit})


class Conversations(_Resource):
    """Ask about what your sources saw and heard (ADR 0041). Answers cite moments as [1], [2], …"""

    def create(self, body: Body = None, /, **fields: Any) -> m.Conversation:
        data = self._t.request("createConversation", body=body_of(m.ConversationCreate, body, fields))
        return parse(m.Conversation, data)

    def list(self, *, limit: int | None = None) -> Iterator[m.Conversation]:
        return self._t.paginate("listConversations", m.ConversationsGetResponse, query={"limit": limit})

    def get(self, id: str) -> m.Conversation:
        """The conversation with every message, media links signed afresh."""
        return parse(m.Conversation, self._t.request("getConversation", path={"id": id}))

    def delete(self, id: str) -> None:
        self._t.request("deleteConversation", path={"id": id})

    def feedback(self, id: str, message_id: str, value: Literal["helpful", "not_helpful"] | None) -> m.Message:
        """Marks an answer helpful or not (None clears it)."""
        path = {"id": id, "mid": message_id}
        return parse(m.Message, self._t.request("giveAnswerFeedback", path=path, body={"value": value}))

    def send(self, id: str, body: Body | str = None, /, **fields: Any) -> m.Message:
        """Asks and waits for the whole answer: `send(id, "When did someone come?")`."""
        body = _ask_body(body, fields, "content")
        data = self._t.request("sendMessage", path={"id": id}, body=body_of(m.MessageCreate, body, fields))
        return parse(m.Message, data)

    def stream(
        self, id: str, body: Body | str = None, /, **fields: Any
    ) -> Iterator[ConversationEvent | ServerSentEvent]:
        """Asks and yields the answer as it's written; the last event is `done` (or `error`).

        Errors before the answer starts (not found, limits) are raised. A dropped stream
        isn't resumed, since that would ask again: fetch the conversation to see what was stored.
        """
        body = _ask_body(body, fields, "content")
        payload = body_of(m.MessageCreate, body, fields)
        for sse in self._t.sse("sendMessage", path={"id": id}, body=payload):
            if sse.event in _CONVERSATION_EVENTS:
                yield parse(m.ConversationStreamEvent, {"event": sse.event, "data": sse.data}).root
            else:
                yield sse
            if sse.event in ("done", "error"):
                return


class Memory(_Resource):
    def search(
        self, q: str, *, from_: When | None = None, to: When | None = None, limit: int | None = None
    ) -> m.MemorySearchResponse:
        """Searches what was seen and heard, in plain language; best matches first."""
        query = {"q": q, "from": from_, "to": to, "limit": limit}
        return parse(m.MemorySearchResponse, self._t.request("searchMemory", query=query))


class Activity(_Resource):
    """Activities and questions about them (ADR 0057): "how many meals today?", "how long did she sleep?"."""

    def query(self, body: Body = None, /, **fields: Any) -> m.ActivityAnswer:
        data = self._t.request("queryActivity", body=body_of(m.ActivityQuery, body, fields))
        return parse(m.ActivityAnswer, data)

    def check(self, body: Body = None, /, **fields: Any) -> m.ActivityCheckResult:
        """Looks through recorded footage for something no watch tracked; each model check is an AI check."""
        data = self._t.request("checkActivityHistory", body=body_of(m.ActivityCheckRequest, body, fields))
        return parse(m.ActivityCheckResult, data)

    def list(
        self,
        *,
        source: str | None = None,
        kind: Literal["presence", "sound", "watch"] | None = None,
        label: str | None = None,
        zone: str | None = None,
        from_: When | None = None,
        to: When | None = None,
        limit: int | None = None,
    ) -> m.ActivityList:
        query = {"source": source, "kind": kind, "label": label, "zone": zone, "from": from_, "to": to, "limit": limit}
        return parse(m.ActivityList, self._t.request("listActivities", query=query))


class Webhooks(_Resource):
    """Signed HTTP deliveries of events. `verify` checks one in your handler."""

    verify = staticmethod(verify_webhook)

    def create(self, body: Body = None, /, *, idempotency_key: str | None = None, **fields: Any) -> m.Webhook:
        """The returned `secret` (whsec_…) is shown only once; store it to verify deliveries."""
        data = self._t.request(
            "createWebhook", body=body_of(m.WebhookCreate, body, fields), idempotency_key=idempotency_key
        )
        return parse(m.Webhook, data)

    def delete(self, id: str) -> None:
        self._t.request("deleteWebhook", path={"id": id})

    def list(self, *, limit: int | None = None) -> Iterator[m.Webhook]:
        return self._t.paginate("listWebhooks", m.WebhooksGetResponse, query={"limit": limit})

    def deliveries(self, id: str, *, limit: int | None = None) -> Iterator[m.Delivery]:
        return self._t.paginate(
            "listDeliveries", m.WebhooksIdDeliveriesGetResponse, path={"id": id}, query={"limit": limit}
        )

    def redeliver(self, id: str, delivery_id: str) -> m.Delivery:
        data = self._t.request("redeliver", path={"id": id, "deliveryId": delivery_id})
        return parse(m.Delivery, data)


class Channels(_Resource):
    """Telegram chats that watches send to and that can ask (ADR 0059)."""

    def list(self) -> Iterator[m.Channel]:
        return self._t.paginate("listChannels", m.ChannelsGetResponse, query={})

    def telegram(self) -> m.ChannelsTelegramGetResponse:
        return parse(m.ChannelsTelegramGetResponse, self._t.request("getTelegram"))

    def link_telegram(self) -> m.ChannelsTelegramLinkPostResponse:
        """A one-time link (10 minutes): `url` for a private chat, `group_url` to add the bot to a group."""
        return parse(m.ChannelsTelegramLinkPostResponse, self._t.request("createTelegramLink"))

    def update(self, id: str, body: Body = None, /, **fields: Any) -> m.Channel:
        data = self._t.request("updateChannel", path={"id": id}, body=body_of(m.ChannelsIdPatchRequest, body, fields))
        return parse(m.Channel, data)

    def delete(self, id: str) -> None:
        self._t.request("deleteChannel", path={"id": id})

    def test(self, id: str) -> m.ChannelsIdTestPostResponse:
        return parse(m.ChannelsIdTestPostResponse, self._t.request("testChannel", path={"id": id}))


class Keys(_Resource):
    """Workspace keys: full access, for your own scripts and apps; owners make and revoke them."""

    def list(self) -> Iterator[m.WorkspaceKey]:
        return self._t.paginate("listKeys", m.KeysGetResponse, query={})

    def create(self, name: str) -> m.KeysPostResponse:
        """The key is in `api_key`, shown only this once."""
        return parse(m.KeysPostResponse, self._t.request("createKey", body={"name": name}))

    def delete(self, id: str) -> None:
        self._t.request("deleteKey", path={"id": id})


class Agents(_Resource):
    """Agent keys: an agent sees only what its grants allow (ADR 0024)."""

    def create(self, body: Body = None, /, **fields: Any) -> m.AgentCreated:
        """The returned `api_key` is shown once."""
        return parse(m.AgentCreated, self._t.request("createAgent", body=body_of(m.AgentCreate, body, fields)))

    def delete(self, id: str) -> None:
        self._t.request("deleteAgent", path={"id": id})

    def list(self) -> Iterator[m.Agent]:
        return self._t.paginate("listAgents", m.AgentsGetResponse, query={})

    def connect(self, body: Body = None, /, **fields: Any) -> m.AgentsConnectPostResponse:
        """Consent page only (ADR 0048): approves an MCP client and returns a connect code."""
        data = self._t.request("connectAgent", body=body_of(m.AgentConnect, body, fields))
        return parse(m.AgentsConnectPostResponse, data)


class Grants(_Resource):
    """What an agent may see: sources, senses, abilities and an optional time window."""

    def create(self, body: Body = None, /, *, idempotency_key: str | None = None, **fields: Any) -> m.Grant:
        data = self._t.request(
            "createGrant", body=body_of(m.GrantCreate, body, fields), idempotency_key=idempotency_key
        )
        return parse(m.Grant, data)

    def delete(self, id: str) -> None:
        self._t.request("deleteGrant", path={"id": id})

    def list(self, *, limit: int | None = None) -> Iterator[m.Grant]:
        return self._t.paginate("listGrants", m.GrantsGetResponse, query={"limit": limit})


class Audit(_Resource):
    def list(
        self, *, from_: When | None = None, to: When | None = None, limit: int | None = None
    ) -> Iterator[m.AuditEntry]:
        query = {"from": from_, "to": to, "limit": limit}
        return self._t.paginate("listAudit", m.AuditGetResponse, query=query)


class Usage(_Resource):
    def get(self, *, from_: When | None = None, to: When | None = None) -> m.Usage:
        return parse(m.Usage, self._t.request("getUsage", query={"from": from_, "to": to}))


class Account(_Resource):
    def get(self) -> m.Account:
        return parse(m.Account, self._t.request("getAccount"))

    def update(self, body: Body = None, /, **fields: Any) -> m.Account:
        """Raw retention may be capped by the instance; exceeding it raises quota_exceeded."""
        return parse(m.Account, self._t.request("updateAccount", body=body_of(m.AccountUpdate, body, fields)))

    def export(self) -> m.ExportResponse:
        return parse(m.ExportResponse, self._t.request("exportAccount"))

    def export_status(self, id: str) -> m.ExportResponse:
        return parse(m.ExportResponse, self._t.request("getAccountExport", path={"id": id}))

    def delete(self) -> None:
        """Deletes the account and all its data (keys stop working at once)."""
        self._t.request("deleteAccount")


class Me(_Resource):
    """The signed-in console user and their workspaces (ADR 0044)."""

    def get(self) -> m.Me:
        return parse(m.Me, self._t.request("getMe"))

    def update(self, body: Body = None, /, **fields: Any) -> m.User:
        return parse(m.User, self._t.request("updateMe", body=body_of(m.MeUpdate, body, fields)))

    def switch_workspace(self, account_id: str) -> m.ConsoleSession:
        """Returns a session in the other workspace; the current one stops working."""
        data = self._t.request("switchWorkspace", body={"account_id": account_id})
        return parse(m.ConsoleSession, data)


class Members(_Resource):
    def list(self) -> Iterator[m.Member]:
        return self._t.paginate("listMembers", m.MembersGetResponse, query={})

    def update(self, id: str, role: str) -> m.Member:
        return parse(m.Member, self._t.request("updateMember", path={"id": id}, body={"role": role}))

    def remove(self, id: str) -> None:
        """Removes someone (admin), or leaves the workspace when id is yours."""
        self._t.request("removeMember", path={"id": id})


class Invites(_Resource):
    def create(self, body: Body = None, /, **fields: Any) -> m.InviteCreated:
        """The returned `invite_url` is shown once; send it to the person."""
        data = self._t.request("createInvite", body=body_of(m.InviteCreate, body, fields))
        return parse(m.InviteCreated, data)

    def list(self) -> Iterator[m.Invite]:
        return self._t.paginate("listInvites", m.InvitesGetResponse, query={})

    def revoke(self, id: str) -> None:
        self._t.request("revokeInvite", path={"id": id})


class Senseplane:
    """The Senseplane API.

    `Senseplane(api_key=...)` (or SENSEPLANE_API_KEY). `base_url` defaults to the hosted
    API; set it (or SENSEPLANE_API_URL) for your own instance, e.g. http://localhost:8080/v1.
    GETs, deletes and creates (which carry an Idempotency-Key) are retried up to `max_retries`
    times on network errors, 429 and 5xx; other calls are retried only on 429.
    """

    def __init__(
        self,
        api_key: str | None = None,
        *,
        base_url: str | None = None,
        timeout: float | httpx.Timeout | None = DEFAULT_TIMEOUT,
        max_retries: int = DEFAULT_MAX_RETRIES,
        http_client: httpx.Client | None = None,
        default_headers: Mapping[str, str] | None = None,
    ) -> None:
        self._setup(
            Transport(
                api_key=resolve_api_key(api_key),
                base_url=resolve_base_url(base_url),
                timeout=timeout,
                max_retries=max_retries,
                http_client=http_client,
                headers=default_headers,
            )
        )

    def _setup(self, transport: Transport) -> None:
        self._transport = transport
        self.sources = Sources(transport)
        self.live = Live(transport)
        self.bridge = Bridge(transport)
        self.integration = Integration(transport)
        self.capture = Capture(transport)
        self.watches = Watches(transport)
        self.inbox = Inbox(transport)
        self.events = Events(transport)
        self.clips = Clips(transport)
        self.conversations = Conversations(transport)
        self.memory = Memory(transport)
        self.activity = Activity(transport)
        self.webhooks = Webhooks(transport)
        self.channels = Channels(transport)
        self.keys = Keys(transport)
        self.agents = Agents(transport)
        self.grants = Grants(transport)
        self.audit = Audit(transport)
        self.usage = Usage(transport)
        self.account = Account(transport)
        self.me = Me(transport)
        self.members = Members(transport)
        self.invites = Invites(transport)

    @property
    def base_url(self) -> str:
        return self._transport.base_url

    def with_options(
        self, *, timeout: float | httpx.Timeout | Literal[False] | None = False, max_retries: int | None = None
    ) -> Senseplane:
        """A copy with another timeout or retry count, sharing this client's connections."""
        copy = Senseplane.__new__(Senseplane)
        copy._setup(self._transport.copy(timeout=timeout, max_retries=max_retries))
        return copy

    def close(self) -> None:
        """Closes the connection pool (unless you passed your own http_client)."""
        self._transport.close()

    def __enter__(self) -> Senseplane:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()


class SenseplaneDemo:
    """The live demo (the website's /try page): no API key, a short session with its own token."""

    def __init__(
        self,
        base_url: str | None = None,
        *,
        timeout: float | httpx.Timeout | None = DEFAULT_TIMEOUT,
        http_client: httpx.Client | None = None,
    ) -> None:
        self._t = Transport(
            api_key=None,
            base_url=resolve_base_url(base_url),
            timeout=timeout,
            max_retries=DEFAULT_MAX_RETRIES,
            http_client=http_client,
        )

    def start(self) -> m.DemoSession:
        return parse(m.DemoSession, self._t.request("createDemoSession"))

    def ask(self, session: DemoSessionRef, question: str) -> m.DemoSessionsIdAskPostResponse:
        data = self._t.request("askDemo", path={"id": session.id}, body={"question": question}, token=session.token)
        return parse(m.DemoSessionsIdAskPostResponse, data)

    def end(self, session: DemoSessionRef) -> None:
        self._t.request("endDemoSession", path={"id": session.id}, token=session.token)

    def stream(
        self, session: DemoSessionRef, *, reconnect: bool = True, max_reconnects: int = 5
    ) -> Iterator[ServerSentEvent]:
        """The session's live events (`status`, `event`, `snapshot`, then `ended`).

        A dropped connection is reopened with backoff (up to `max_reconnects` times in a row,
        sending Last-Event-ID when the server gave ids) until the server sends `ended`.
        """
        failures = 0
        last_id: str | None = None
        while True:
            try:
                for ev in self._t.sse(
                    "streamDemoEvents", path={"id": session.id}, token=session.token, last_event_id=last_id
                ):
                    failures = 0
                    last_id = ev.id or last_id
                    yield ev
                    if ev.event == "ended":
                        return
            except (APIConnectionError, InternalServerError):
                if not reconnect or failures >= max_reconnects:
                    raise
            else:
                if not reconnect or failures >= max_reconnects:
                    return
            time.sleep(retry_delay(failures))
            failures += 1

    def close(self) -> None:
        self._t.close()

    def __enter__(self) -> SenseplaneDemo:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()
