# Copyright 2026 The Senseplane Authors
# SPDX-License-Identifier: Apache-2.0

# The async client, one resource per API area, mirroring sdk/typescript's
# client.ts. This file is the source of truth: scripts/codegen.py writes the
# sync client (_sync_client.py) from it by dropping async and await, so change
# this one and regenerate.
from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator, Mapping
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
from ._webhooks import sign_webhook, verify_webhook

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

__all__ = ["AsyncSenseplane", "AsyncSenseplaneDemo"]


class DemoSessionRef(Protocol):
    """A demo session, or anything with its `id` and `token`."""

    @property
    def id(self) -> str: ...

    @property
    def token(self) -> str: ...


class AsyncTransport:
    """Sends requests with the key, timeouts and retries; one per client (and its copies)."""

    def __init__(
        self,
        *,
        api_key: str | None,
        base_url: str,
        timeout: float | httpx.Timeout | None,
        max_retries: int,
        http_client: httpx.AsyncClient | None,
        headers: Mapping[str, str] | None = None,
    ) -> None:
        self.base_url = base_url
        self.timeout = timeout
        self.max_retries = max_retries
        self.headers = {**default_headers(api_key), **(headers or {})}
        self.owns_http = http_client is None
        self.http = http_client or httpx.AsyncClient(follow_redirects=False)

    def copy(
        self, *, timeout: float | httpx.Timeout | Literal[False] | None, max_retries: int | None
    ) -> AsyncTransport:
        t = AsyncTransport.__new__(AsyncTransport)
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

    async def send(self, p: Prepared, *, stream: bool = False) -> httpx.Response:
        attempt = 0
        while True:
            request = to_request(self.http, p, self.base_url, self.timeout)
            try:
                response = await self.http.send(request, stream=stream)
            except httpx.TransportError as err:
                if attempt < self.max_retries and should_retry_error(p, err):
                    await asyncio.sleep(retry_delay(attempt))
                    attempt += 1
                    continue
                raise connection_error(err) from err
            if response.status_code < 400:
                return response
            await response.aread()
            await response.aclose()
            if attempt < self.max_retries and should_retry_status(p, response.status_code):
                await asyncio.sleep(retry_delay(attempt, response.headers.get("retry-after")))
                attempt += 1
                continue
            raise api_error(response.status_code, response.headers, response.content, response.reason_phrase)

    async def request(
        self,
        operation: str,
        *,
        path: Mapping[str, str] | None = None,
        query: Mapping[str, Any] | None = None,
        body: Any = None,
        idempotency_key: str | None = None,
        token: str | None = None,
        headers: Mapping[str, str] | None = None,
    ) -> Any:
        p = self._prepare(operation, token, headers, path=path, query=query, body=body, idempotency_key=idempotency_key)
        return decode(await self.send(p))

    async def sse(
        self,
        operation: str,
        *,
        path: Mapping[str, str] | None = None,
        body: Any = None,
        token: str | None = None,
        last_event_id: str | None = None,
    ) -> AsyncIterator[ServerSentEvent]:
        """Opens a text/event-stream and yields its events until the server ends it."""
        p = self._prepare(operation, token, sse_headers(last_event_id), path=path, body=body)
        response = await self.send(p, stream=True)
        decoder = SSEDecoder()
        try:
            async for line in response.aiter_lines():
                event = decoder.feed(line)
                if event is not None:
                    yield event
        except httpx.TransportError as err:
            raise connection_error(err) from err
        finally:
            await response.aclose()

    async def paginate(
        self, operation: str, page: type[BaseModel], *, path: Mapping[str, str] | None = None, query: Mapping[str, Any]
    ) -> AsyncIterator[Any]:
        """Every item of a cursor-paginated list, fetching the next page as the last one runs out."""
        cursor: str | None = None
        while True:
            result: Any = parse(page, await self.request(operation, path=path, query={**query, "cursor": cursor}))
            for item in result.data:
                yield item
            cursor = getattr(result, "next_cursor", None)  # some lists are one page, with no cursor
            if not cursor:
                return

    async def close(self) -> None:
        if self.owns_http:
            await self.http.aclose()


class _Resource:
    def __init__(self, transport: AsyncTransport) -> None:
        self._t = transport


def _ask_body(body: Body | str, fields: dict[str, Any], key: str) -> Body:
    if isinstance(body, str):
        fields[key] = body
        return None
    return body


class AsyncSources(_Resource):
    """Cameras, microphones and sensors."""

    async def create(self, body: Body = None, /, *, idempotency_key: str | None = None, **fields: Any) -> m.Source:
        """Adds a source (`name`, `type`: browser, sensor, whip or rtsp). Safe to retry: see `idempotency_key`."""
        data = await self._t.request(
            "createSource", body=body_of(m.SourceCreate, body, fields), idempotency_key=idempotency_key
        )
        return parse(m.Source, data)

    async def get(self, id: str) -> m.Source:
        return parse(m.Source, await self._t.request("getSource", path={"id": id}))

    async def update(self, id: str, body: Body = None, /, **fields: Any) -> m.Source:
        data = await self._t.request("updateSource", path={"id": id}, body=body_of(m.SourceUpdate, body, fields))
        return parse(m.Source, data)

    async def delete(self, id: str) -> None:
        await self._t.request("deleteSource", path={"id": id})

    def list(self, *, limit: int | None = None) -> AsyncIterator[m.Source]:
        """Every source; `limit` is the page size."""
        return self._t.paginate("listSources", m.SourcesGetResponse, query={"limit": limit})

    async def now(self, id: str) -> m.SourceNow:
        """The latest snapshot and readings."""
        return parse(m.SourceNow, await self._t.request("getSourceNow", path={"id": id}))

    async def ask(self, id: str, body: Body | str = None, /, **fields: Any) -> m.AskResponse:
        """Asks about what the camera shows now: `ask(id, "Is the door open?")`."""
        body = _ask_body(body, fields, "question")
        data = await self._t.request("askSource", path={"id": id}, body=body_of(m.AskRequest, body, fields))
        return parse(m.AskResponse, data)

    async def playback(self, id: str, *, from_: When, to: When) -> m.PlaybackResponse:
        """A signed playback URL for a recorded range (with any gaps)."""
        data = await self._t.request("getPlayback", path={"id": id}, query={"from": from_, "to": to})
        return parse(m.PlaybackResponse, data)

    async def timeline(self, id: str, *, from_: When | None = None, to: When | None = None) -> m.TimelineResponse:
        data = await self._t.request("getTimeline", path={"id": id}, query={"from": from_, "to": to})
        return parse(m.TimelineResponse, data)

    async def history(
        self, id: str, *, from_: When | None = None, to: When | None = None, sense: str | None = None
    ) -> m.HistoryResponse:
        """Sensor readings over a range."""
        query = {"from": from_, "to": to, "sense": sense}
        return parse(m.HistoryResponse, await self._t.request("getHistory", path={"id": id}, query=query))

    async def push_readings(self, id: str, body: Body = None, /, **fields: Any) -> m.SourcesIdReadingsPostResponse:
        """Sends sensor readings (`readings=[{"sense": "temperature", "value": 21, "unit": "celsius", "at": ...}]`).

        Works with an account key or the source's sensor integration token as the client's key.
        """
        data = await self._t.request("postReadings", path={"id": id}, body=body_of(m.ReadingsRequest, body, fields))
        return parse(m.SourcesIdReadingsPostResponse, data)

    async def rotate_capture_link(self, id: str) -> m.Source:
        """A new capture link; every earlier link for this source stops working."""
        return parse(m.Source, await self._t.request("rotateCaptureLink", path={"id": id}))

    async def live(self, id: str, body: Body = None, /, **fields: Any) -> m.LiveViewSession:
        """Starts a live view: a single-use media token and signalling URL (ADR 0042)."""
        data = await self._t.request("startLiveView", path={"id": id}, body=body_of(m.LiveViewRequest, body, fields))
        return parse(m.LiveViewSession, data)

    async def speak(self, id: str, text: str) -> m.SpeakMessage:
        """Says `text` through the camera's speaker (ADR 0069), after a short chime, in the server's one synthetic voice.

        Needs a speak grant (agents) and a camera with a speaker; at most 30 s, 6 a minute per camera,
        refused while someone else is speaking. Tell people they are hearing an automated system.
        Refusals raise a SenseplaneError whose `details["message"]` is the record.
        """
        data = await self._t.request("speak", path={"id": id}, body={"text": text})
        return parse(m.SpeakMessage, data)

    async def rotate_ingest_token(self, id: str) -> m.SourcesIdIngestTokenPostResponse:
        """A new WHIP, bridge or sensor integration token (shown once); the old one stops working."""
        data = await self._t.request("rotateIngestToken", path={"id": id})
        return parse(m.SourcesIdIngestTokenPostResponse, data)

    async def revoke_ingest_token(self, id: str) -> None:
        await self._t.request("revokeIngestToken", path={"id": id})

    async def webhook(self, id: str) -> m.ReadingsWebhook:
        """A sensor's readings webhook URL, and whether its pushes must be signed (ADR 0071)."""
        return parse(m.ReadingsWebhook, await self._t.request("getReadingsWebhook", path={"id": id}))

    async def create_webhook_secret(self, id: str) -> m.ReadingsWebhookSecret:
        """Turns signing on (or replaces the secret, shown once); every push with the sensor's token must then be signed."""
        return parse(m.ReadingsWebhookSecret, await self._t.request("createReadingsWebhookSecret", path={"id": id}))

    async def delete_webhook_secret(self, id: str) -> None:
        """Turns signing off."""
        await self._t.request("deleteReadingsWebhookSecret", path={"id": id})

    async def pause(self, id: str) -> m.Source:
        """Stops recording and analysis until `resume`; pushes are refused while paused."""
        return parse(m.Source, await self._t.request("pauseSource", path={"id": id}))

    async def resume(self, id: str) -> m.Source:
        return parse(m.Source, await self._t.request("resumeSource", path={"id": id}))


class AsyncLive(_Resource):
    """Live view sessions started with `sources.live`."""

    async def keepalive(self, session_id: str) -> m.LiveSessionIdKeepalivePostResponse:
        data = await self._t.request("keepLiveViewAlive", path={"session_id": session_id})
        return parse(m.LiveSessionIdKeepalivePostResponse, data)


class AsyncBridge(_Resource):
    """For a bridge (the box itself), with its bridge token as the client's key. `bridges` manages them."""

    async def config(self) -> m.BridgeConfig:
        return parse(m.BridgeConfig, await self._t.request("getBridgeConfig"))

    async def claim_camera(self, body: Body = None, /, **fields: Any) -> m.BridgeCamera:
        """Registers (or finds) the camera at `rtsp_url` on this bridge."""
        data = await self._t.request("claimBridgeCamera", body=body_of(m.BridgeCamerasPostRequest, body, fields))
        return parse(m.BridgeCamera, data)

    async def health(self, body: Body = None, /, **fields: Any) -> None:
        await self._t.request("postBridgeHealth", body=body_of(m.BridgeHealth, body, fields))

    async def cameras_found(self, body: Body = None, /, **fields: Any) -> None:
        """Reports the cameras it found on the network (`cameras=[...]`), replacing the last list."""
        await self._t.request("putBridgeCamerasFound", body=body_of(m.BridgeCamerasFoundPutRequest, body, fields))

    async def entities(self) -> m.BridgeEntitiesGetResponse:
        """The Home Assistant entities this bridge reported, and which were chosen."""
        return parse(m.BridgeEntitiesGetResponse, await self._t.request("getOwnBridgeEntities"))

    async def put_entities(self, body: Body = None, /, **fields: Any) -> None:
        """Reports the entities it can see (`entities=[...]`), replacing the last list."""
        await self._t.request("putBridgeEntities", body=body_of(m.BridgeEntitiesPutRequest, body, fields))

    async def choose_entities(self, body: Body = None, /, **fields: Any) -> None:
        """`choose=[...]` and `drop=[...]` entity ids, from the box itself."""
        await self._t.request("chooseOwnBridgeEntities", body=body_of(m.BridgeEntitiesChoosePostRequest, body, fields))

    async def push_readings(self, body: Body = None, /, **fields: Any) -> m.BridgeReadingsPostResponse:
        """Readings of its chosen entities (`readings=[...]`); ones for entities not chosen are ignored."""
        data = await self._t.request("postBridgeReadings", body=body_of(m.ReadingsRequest, body, fields))
        return parse(m.BridgeReadingsPostResponse, data)

    async def take_outputs(self, *, after: str | None = None, wait: int | None = None) -> m.BridgeOutputs:
        """What this box may publish to its MQTT broker (ADR 0071), long-polled; pass the last `cursor` as `after`."""
        return parse(m.BridgeOutputs, await self._t.request("takeBridgeOutputs", query={"after": after, "wait": wait}))

    async def take_commands(self, *, wait: int | None = None) -> m.BridgeCommandsGetResponse:
        """Commands waiting for this bridge; `wait` seconds holds the request open until one arrives."""
        return parse(m.BridgeCommandsGetResponse, await self._t.request("takeBridgeCommands", query={"wait": wait}))

    async def finish_command(self, id: str, body: Body = None, /, **fields: Any) -> None:
        """Reports how a command went: `ok`, and `result` or `error`."""
        body = body_of(m.BridgeCommandsIdPostRequest, body, fields)
        await self._t.request("finishBridgeCommand", path={"id": id}, body=body)

    async def start_pairing(self, *, name: str | None = None) -> m.BridgePairPostResponse:
        """Starts pairing a new box (no key needed): show `user_code`, then `poll_pairing(device_code)`."""
        data = await self._t.request("startBridgePairing", body={"name": name} if name else {})
        return parse(m.BridgePairPostResponse, data)

    async def poll_pairing(self, device_code: str) -> m.BridgePairTokenPostResponse:
        """Whether a person approved the pairing yet; once approved, the bridge token (shown once)."""
        data = await self._t.request("pollBridgePairing", body={"device_code": device_code})
        return parse(m.BridgePairTokenPostResponse, data)


class AsyncBridges(_Resource):
    """Boxes on your network that relay cameras, Home Assistant entities and Matter devices (ADR 0045)."""

    def list(self) -> AsyncIterator[m.Bridge]:
        return self._t.paginate("listBridges", m.BridgesGetResponse, query={})

    async def create(self, name: str) -> m.Bridge:
        """A new box; its token is in the response, shown once."""
        return parse(m.Bridge, await self._t.request("createBridge", body={"name": name}))

    async def update(self, id: str, body: Body = None, /, **fields: Any) -> m.Bridge:
        """Renames a box (`name`), or turns publishing to its MQTT broker on or off (`mqtt_publish`, ADR 0071)."""
        return parse(m.Bridge, await self._t.request("updateBridge", path={"id": id}, body=body_of(m.BridgesIdPatchRequest, body, fields)))

    async def remove(self, id: str) -> None:
        """Removes a box; its cameras and sensors keep their history."""
        await self._t.request("removeBridge", path={"id": id})

    async def find_pairing(self, code: str) -> m.BridgesPairGetResponse:
        """The box waiting to pair with the code it shows."""
        return parse(m.BridgesPairGetResponse, await self._t.request("findBridgePairing", query={"code": code}))

    async def approve_pairing(self, code: str, *, name: str | None = None) -> m.Bridge:
        body = {"code": code, **({"name": name} if name else {})}
        return parse(m.Bridge, await self._t.request("approveBridgePairing", body=body))

    async def entities(self, id: str) -> m.BridgesIdEntitiesGetResponse:
        """The Home Assistant entities the box reported, and which are chosen."""
        return parse(m.BridgesIdEntitiesGetResponse, await self._t.request("listBridgeEntities", path={"id": id}))

    async def choose_entities(self, id: str, body: Body = None, /, **fields: Any) -> m.BridgesIdEntitiesPatchResponse:
        """`choose=[...]` entity ids to read (and control), `drop=[...]` to stop."""
        body = body_of(m.BridgesIdEntitiesPatchRequest, body, fields)
        data = await self._t.request("chooseBridgeEntities", path={"id": id}, body=body)
        return parse(m.BridgesIdEntitiesPatchResponse, data)

    async def add_matter_device(self, id: str, code: str) -> m.BridgeCommand:
        """Adds a Matter device with its pairing code; follow the returned command with `command`."""
        data = await self._t.request("addMatterDevice", path={"id": id}, body={"code": code})
        return parse(m.BridgeCommand, data)

    async def cameras_found(self, id: str) -> m.BridgesIdCamerasFoundGetResponse:
        """Cameras the box found on its network."""
        data = await self._t.request("listBridgeCamerasFound", path={"id": id})
        return parse(m.BridgesIdCamerasFoundGetResponse, data)

    async def search_cameras(self, id: str) -> m.BridgeCommand:
        """Asks the box to look for cameras again."""
        return parse(m.BridgeCommand, await self._t.request("searchBridgeCameras", path={"id": id}))

    async def add_onvif_camera(self, id: str, body: Body = None, /, **fields: Any) -> m.BridgeCommand:
        """Adds a found ONVIF camera: `camera`, `username`, `password` (and `name`)."""
        body = body_of(m.BridgesIdOnvifPostRequest, body, fields)
        return parse(m.BridgeCommand, await self._t.request("addOnvifCamera", path={"id": id}, body=body))

    async def command(self, id: str, command_id: str) -> m.BridgeCommand:
        """What happened to a command sent to the box."""
        data = await self._t.request("getBridgeCommand", path={"id": id, "cid": command_id})
        return parse(m.BridgeCommand, data)


class AsyncDevices(_Resource):
    """Devices a person (or an agent they granted Control) can switch (ADR 0067).

    `command` answers with the state the box read back; a lock, garage door, gate or alarm
    asked for by an agent comes back `awaiting_confirmation` until a person confirms it.
    Offline boxes and failures raise a SenseplaneError whose `details["command"]` is the request.
    """

    def list(self) -> AsyncIterator[m.Device]:
        return self._t.paginate("listDevices", m.DevicesGetResponse, query={})

    async def get(self, id: str) -> m.Device:
        return parse(m.Device, await self._t.request("getDevice", path={"id": id}))

    async def set_controllable(self, id: str, controllable: bool) -> m.Device:
        """Admins: show the device's `warning` first."""
        data = await self._t.request("updateDevice", path={"id": id}, body={"controllable": controllable})
        return parse(m.Device, data)

    async def command(
        self,
        id: str,
        action: str,
        *,
        value: float | str | None = None,
        confirm: bool | None = None,
        via: str | None = None,
    ) -> m.DeviceCommand:
        """Switches a device: `command(id, "turn_on")`, `command(id, "set_brightness", value=40)`.

        `confirm=True`: a person confirms their own request for a secure device. `via="app"` is
        recorded as how the person asked (the Android app sends it).
        """
        body: dict[str, Any] = {"action": action}
        if value is not None:
            body["value"] = value
        if confirm is not None:
            body["confirm"] = confirm
        headers = {"x-senseplane-via": via} if via else None
        data = await self._t.request("controlDevice", path={"id": id}, body=body, headers=headers)
        return parse(m.DeviceCommand, data)

    async def request(self, id: str) -> m.DeviceCommand:
        """What happened to a request: poll one that is `sent` or `awaiting_confirmation`."""
        return parse(m.DeviceCommand, await self._t.request("getDeviceCommand", path={"id": id}))


class AsyncSpeakMessages(_Resource):
    """What was said through cameras (agents, watches and push-to-talk), each with a link to hear the clip."""

    async def list(self, *, source: str | None = None, limit: int | None = None) -> list[m.SpeakMessage]:
        query: dict[str, Any] = {}
        if source is not None:
            query["source"] = source
        if limit is not None:
            query["limit"] = limit
        data = await self._t.request("listSpeakMessages", query=query)
        return parse(m.SpeakMessagesGetResponse, data).data

    async def get(self, id: str) -> m.SpeakMessage:
        return parse(m.SpeakMessage, await self._t.request("getSpeakMessage", path={"id": id}))


class AsyncConfirmations(_Resource):
    """Requests waiting for a person; only people signed in can answer them."""

    def list(self) -> AsyncIterator[m.DeviceCommand]:
        return self._t.paginate("listConfirmations", m.ConfirmationsGetResponse, query={})

    async def decide(self, id: str, approve: bool) -> m.DeviceCommand:
        data = await self._t.request("decideConfirmation", path={"id": id}, body={"approve": approve})
        return parse(m.DeviceCommand, data)


class AsyncIntegration(_Resource):
    """For a sensor integration, with its token as the client's key."""

    async def get(self) -> m.IntegrationGetResponse:
        """The source this token feeds (then `sources.push_readings`)."""
        return parse(m.IntegrationGetResponse, await self._t.request("getIntegration"))

    async def push(
        self, body: Mapping[str, Any] | None = None, /, *, signing_secret: str | None = None, **fields: Any
    ) -> m.IntegrationReadingsPostResponse:
        """The readings webhook (ADR 0071): one reading's fields (`sense="temperature", value=21.5`) or `readings=[...]`.

        Values may be text and a known number sense's unit may be left out. With `signing_secret`, the
        push is signed (`Senseplane-Signature`), as a token with signing on needs.
        """
        data = dict(body) if body is not None else dict(fields)
        headers = None
        if signing_secret:
            headers = {"senseplane-signature": sign_webhook(json.dumps(data, separators=(",", ":")), signing_secret)}
        res = await self._t.request("pushWebhookReadings", body=data, headers=headers)
        return parse(m.IntegrationReadingsPostResponse, res)


class AsyncCapture(_Resource):
    async def join(self, ticket: str, *, device: str | None = None) -> m.CaptureJoinPostResponse:
        """Exchanges a capture link's ticket for a publishing token (no API key needed)."""
        body: dict[str, Any] = {"ticket": ticket, **({"device": device} if device else {})}
        return parse(m.CaptureJoinPostResponse, await self._t.request("captureJoin", body=body))


class AsyncWatches(_Resource):
    """Plain-language watches over one or more sources."""

    async def create(self, body: Body = None, /, *, idempotency_key: str | None = None, **fields: Any) -> m.Watch:
        """Starts a watch: `create(instruction="Tell me if a package is left", sources=["Front door"])`."""
        data = await self._t.request(
            "createWatch", body=body_of(m.WatchCreate, body, fields), idempotency_key=idempotency_key
        )
        return parse(m.Watch, data)

    async def get(self, id: str) -> m.Watch:
        return parse(m.Watch, await self._t.request("getWatch", path={"id": id}))

    async def update(self, id: str, body: Body = None, /, **fields: Any) -> m.Watch:
        data = await self._t.request("updateWatch", path={"id": id}, body=body_of(m.WatchUpdate, body, fields))
        return parse(m.Watch, data)

    async def delete(self, id: str) -> None:
        await self._t.request("deleteWatch", path={"id": id})

    def list(self, *, limit: int | None = None) -> AsyncIterator[m.Watch]:
        return self._t.paginate("listWatches", m.WatchesGetResponse, query={"limit": limit})

    async def test(self, body: Body = None, /, **fields: Any) -> m.WatchTestResult:
        """Backtests a watch over recorded history; at most `max_checks` model checks (AI checks)."""
        data = await self._t.request("testWatch", body=body_of(m.WatchTestRequest, body, fields))
        return parse(m.WatchTestResult, data)

    async def packs(self) -> m.WatchPackList:
        """Ready-made sets of watches (eldercare, home, shop, site; ADR 0057)."""
        return parse(m.WatchPackList, await self._t.request("listWatchPacks"))

    async def apply_pack(self, id: str, body: Body = None, /, **fields: Any) -> m.WatchPackApplied:
        data = await self._t.request("applyWatchPack", path={"id": id}, body=body_of(m.WatchPackApply, body, fields))
        return parse(m.WatchPackApplied, data)


class AsyncInbox(_Resource):
    """Events routed to an agent by its watches' `notify` (ADR 0043). Agent keys read their own inbox."""

    async def list(
        self,
        *,
        agent: str | None = None,
        unseen: bool | None = None,
        limit: int | None = None,
        cursor: str | None = None,
    ) -> m.InboxGetResponse:
        """One page of the inbox (`agent_id`, `data`, `next_cursor`); account keys pass `agent`."""
        query = {"agent": agent, "unseen": unseen, "limit": limit, "cursor": cursor}
        return parse(m.InboxGetResponse, await self._t.request("listInbox", query=query))

    async def mark_seen(self, body: Body = None, /, **fields: Any) -> m.InboxSeenPostResponse:
        """`mark_seen(ids=[...])` or `mark_seen(all=True)`."""
        data = await self._t.request("markInboxSeen", body=body_of(m.InboxSeenRequest, body, fields))
        return parse(m.InboxSeenPostResponse, data)


def _when(value: Any) -> datetime:
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    return datetime.fromisoformat(str(value).replace("Z", "+00:00"))


class AsyncEvents(_Resource):
    """What the sources saw and heard, newest first."""

    def list(
        self,
        *,
        source: str | None = None,
        type: str | None = None,
        from_: When | None = None,
        to: When | None = None,
        limit: int | None = None,
    ) -> AsyncIterator[m.Event]:
        """Every matching event, newest first. `type` takes patterns such as `detection.*`."""
        query = {"source": source, "type": type, "from": from_, "to": to, "limit": limit}
        return self._t.paginate("listEvents", m.EventsGetResponse, query=query)

    async def get(self, id: str) -> m.Event:
        return parse(m.Event, await self._t.request("getEvent", path={"id": id}))

    async def feedback(self, id: str, feedback: Literal["relevant", "not_relevant"]) -> None:
        await self._t.request("postFeedback", path={"id": id}, body={"feedback": feedback})

    async def stream(
        self,
        *,
        source: str | None = None,
        type: str | None = None,
        since: When | None = None,
        poll_interval: float = 2.0,
        lookback: float = 120.0,
        max_failures: int | None = None,
    ) -> AsyncIterator[m.Event]:
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
                async for ev in self.list(source=source, type=type, from_=watermark - timedelta(seconds=lookback)):
                    if ev.id not in seen:
                        fresh.append(ev)
            except (APIConnectionError, InternalServerError, RateLimitError):
                failures += 1
                if max_failures is not None and failures > max_failures:
                    raise
                await asyncio.sleep(retry_delay(min(failures, 5)))
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
            await asyncio.sleep(poll_interval)


class AsyncClips(_Resource):
    """Saved recordings of a range (playback links that don't expire with retention)."""

    async def create(self, body: Body = None, /, *, idempotency_key: str | None = None, **fields: Any) -> m.Clip:
        """`create(source=id, from_=..., to=...)`."""
        data = await self._t.request(
            "createClip", body=body_of(m.ClipCreate, body, fields), idempotency_key=idempotency_key
        )
        return parse(m.Clip, data)

    async def get(self, id: str) -> m.Clip:
        return parse(m.Clip, await self._t.request("getClip", path={"id": id}))

    async def delete(self, id: str) -> None:
        await self._t.request("deleteClip", path={"id": id})

    def list(self, *, limit: int | None = None) -> AsyncIterator[m.Clip]:
        return self._t.paginate("listClips", m.ClipsGetResponse, query={"limit": limit})


class AsyncStories(_Resource):
    """One video from many moments across cameras (ADR 0070), rendered in the background: poll `get` until `ready`."""

    async def create(self, body: Body = None, /, *, idempotency_key: str | None = None, **fields: Any) -> m.Story:
        """`create(moments=[{"event": id}, {"source": id, "from": ..., "to": ...}])` or `create(search={"q": "the courier"})`."""
        data = await self._t.request(
            "createStory", body=body_of(m.StoryCreate, body, fields), idempotency_key=idempotency_key
        )
        return parse(m.Story, data)

    async def get(self, id: str) -> m.Story:
        return parse(m.Story, await self._t.request("getStory", path={"id": id}))

    async def delete(self, id: str) -> None:
        await self._t.request("deleteStory", path={"id": id})

    async def list(self, *, limit: int | None = None) -> list[m.Story]:
        return parse(m.StoriesGetResponse, await self._t.request("listStories", query={"limit": limit})).data

    async def link(self, id: str, *, expires_in_s: int | None = None) -> m.StoriesIdLinkPostResponse:
        """A longer-lived signed link to share a ready story (at most 7 days)."""
        body = {"expires_in_s": expires_in_s} if expires_in_s else {}
        return parse(m.StoriesIdLinkPostResponse, await self._t.request("createStoryLink", path={"id": id}, body=body))


class AsyncFollows(_Resource):
    """Following an object or a pet across cameras, never a person (ADR 0070): poll `get` until `done`."""

    async def create(self, body: Body = None, /, *, idempotency_key: str | None = None, **fields: Any) -> m.Follow:
        """`create(reference={"event": id, "box": [x1, y1, x2, y2]}, from_=..., to=...)`."""
        data = await self._t.request(
            "createFollow", body=body_of(m.FollowCreate, body, fields), idempotency_key=idempotency_key
        )
        return parse(m.Follow, data)

    async def get(self, id: str) -> m.Follow:
        return parse(m.Follow, await self._t.request("getFollow", path={"id": id}))

    async def delete(self, id: str) -> None:
        await self._t.request("deleteFollow", path={"id": id})

    async def list(self, *, limit: int | None = None) -> list[m.Follow]:
        return parse(m.FollowsGetResponse, await self._t.request("listFollows", query={"limit": limit})).data


class AsyncConversations(_Resource):
    """Ask about what your sources saw and heard (ADR 0041). Answers cite moments as [1], [2], …"""

    async def create(self, body: Body = None, /, **fields: Any) -> m.Conversation:
        data = await self._t.request("createConversation", body=body_of(m.ConversationCreate, body, fields))
        return parse(m.Conversation, data)

    def list(self, *, limit: int | None = None) -> AsyncIterator[m.Conversation]:
        return self._t.paginate("listConversations", m.ConversationsGetResponse, query={"limit": limit})

    async def get(self, id: str) -> m.Conversation:
        """The conversation with every message, media links signed afresh."""
        return parse(m.Conversation, await self._t.request("getConversation", path={"id": id}))

    async def delete(self, id: str) -> None:
        await self._t.request("deleteConversation", path={"id": id})

    async def feedback(self, id: str, message_id: str, value: Literal["helpful", "not_helpful"] | None) -> m.Message:
        """Marks an answer helpful or not (None clears it)."""
        path = {"id": id, "mid": message_id}
        return parse(m.Message, await self._t.request("giveAnswerFeedback", path=path, body={"value": value}))

    async def send(self, id: str, body: Body | str = None, /, **fields: Any) -> m.Message:
        """Asks and waits for the whole answer: `send(id, "When did someone come?")`."""
        body = _ask_body(body, fields, "content")
        data = await self._t.request("sendMessage", path={"id": id}, body=body_of(m.MessageCreate, body, fields))
        return parse(m.Message, data)

    async def stream(
        self, id: str, body: Body | str = None, /, **fields: Any
    ) -> AsyncIterator[ConversationEvent | ServerSentEvent]:
        """Asks and yields the answer as it's written; the last event is `done` (or `error`).

        Errors before the answer starts (not found, limits) are raised. A dropped stream
        isn't resumed, since that would ask again: fetch the conversation to see what was stored.
        """
        body = _ask_body(body, fields, "content")
        payload = body_of(m.MessageCreate, body, fields)
        async for sse in self._t.sse("sendMessage", path={"id": id}, body=payload):
            if sse.event in _CONVERSATION_EVENTS:
                yield parse(m.ConversationStreamEvent, {"event": sse.event, "data": sse.data}).root
            else:
                yield sse
            if sse.event in ("done", "error"):
                return


class AsyncMemory(_Resource):
    async def search(
        self, q: str, *, from_: When | None = None, to: When | None = None, limit: int | None = None
    ) -> m.MemorySearchResponse:
        """Searches what was seen and heard, in plain language; best matches first."""
        query = {"q": q, "from": from_, "to": to, "limit": limit}
        return parse(m.MemorySearchResponse, await self._t.request("searchMemory", query=query))


class AsyncActivity(_Resource):
    """Activities and questions about them (ADR 0057): "how many meals today?", "how long did she sleep?"."""

    async def query(self, body: Body = None, /, **fields: Any) -> m.ActivityAnswer:
        data = await self._t.request("queryActivity", body=body_of(m.ActivityQuery, body, fields))
        return parse(m.ActivityAnswer, data)

    async def check(self, body: Body = None, /, **fields: Any) -> m.ActivityCheckResult:
        """Looks through recorded footage for something no watch tracked; each model check is an AI check."""
        data = await self._t.request("checkActivityHistory", body=body_of(m.ActivityCheckRequest, body, fields))
        return parse(m.ActivityCheckResult, data)

    async def list(
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
        return parse(m.ActivityList, await self._t.request("listActivities", query=query))


class AsyncWebhooks(_Resource):
    """Signed HTTP deliveries of events. `verify` checks one in your handler."""

    verify = staticmethod(verify_webhook)

    async def create(self, body: Body = None, /, *, idempotency_key: str | None = None, **fields: Any) -> m.Webhook:
        """The returned `secret` (whsec_…) is shown only once; store it to verify deliveries."""
        data = await self._t.request(
            "createWebhook", body=body_of(m.WebhookCreate, body, fields), idempotency_key=idempotency_key
        )
        return parse(m.Webhook, data)

    async def delete(self, id: str) -> None:
        await self._t.request("deleteWebhook", path={"id": id})

    def list(self, *, limit: int | None = None) -> AsyncIterator[m.Webhook]:
        return self._t.paginate("listWebhooks", m.WebhooksGetResponse, query={"limit": limit})

    def deliveries(self, id: str, *, limit: int | None = None) -> AsyncIterator[m.Delivery]:
        return self._t.paginate(
            "listDeliveries", m.WebhooksIdDeliveriesGetResponse, path={"id": id}, query={"limit": limit}
        )

    async def redeliver(self, id: str, delivery_id: str) -> m.Delivery:
        data = await self._t.request("redeliver", path={"id": id, "deliveryId": delivery_id})
        return parse(m.Delivery, data)


class AsyncChannels(_Resource):
    """Telegram chats that watches send to and that can ask (ADR 0059)."""

    def list(self) -> AsyncIterator[m.Channel]:
        return self._t.paginate("listChannels", m.ChannelsGetResponse, query={})

    async def telegram(self) -> m.ChannelsTelegramGetResponse:
        return parse(m.ChannelsTelegramGetResponse, await self._t.request("getTelegram"))

    async def link_telegram(self) -> m.ChannelsTelegramLinkPostResponse:
        """A one-time link (10 minutes): `url` for a private chat, `group_url` to add the bot to a group."""
        return parse(m.ChannelsTelegramLinkPostResponse, await self._t.request("createTelegramLink"))

    async def update(self, id: str, body: Body = None, /, **fields: Any) -> m.Channel:
        data = await self._t.request(
            "updateChannel", path={"id": id}, body=body_of(m.ChannelsIdPatchRequest, body, fields)
        )
        return parse(m.Channel, data)

    async def delete(self, id: str) -> None:
        await self._t.request("deleteChannel", path={"id": id})

    async def test(self, id: str) -> m.ChannelsIdTestPostResponse:
        return parse(m.ChannelsIdTestPostResponse, await self._t.request("testChannel", path={"id": id}))


class AsyncKeys(_Resource):
    """Workspace keys: full access, for your own scripts and apps; owners make and revoke them."""

    def list(self) -> AsyncIterator[m.WorkspaceKey]:
        return self._t.paginate("listKeys", m.KeysGetResponse, query={})

    async def create(self, name: str) -> m.KeysPostResponse:
        """The key is in `api_key`, shown only this once."""
        return parse(m.KeysPostResponse, await self._t.request("createKey", body={"name": name}))

    async def delete(self, id: str) -> None:
        await self._t.request("deleteKey", path={"id": id})


class AsyncAgents(_Resource):
    """Agent keys: an agent sees only what its grants allow (ADR 0024)."""

    async def create(self, body: Body = None, /, **fields: Any) -> m.AgentCreated:
        """The returned `api_key` is shown once."""
        return parse(m.AgentCreated, await self._t.request("createAgent", body=body_of(m.AgentCreate, body, fields)))

    async def delete(self, id: str) -> None:
        await self._t.request("deleteAgent", path={"id": id})

    def list(self) -> AsyncIterator[m.Agent]:
        return self._t.paginate("listAgents", m.AgentsGetResponse, query={})

    async def connect(self, body: Body = None, /, **fields: Any) -> m.AgentsConnectPostResponse:
        """Consent page only (ADR 0048): approves an MCP client and returns a connect code."""
        data = await self._t.request("connectAgent", body=body_of(m.AgentConnect, body, fields))
        return parse(m.AgentsConnectPostResponse, data)


class AsyncGrants(_Resource):
    """What an agent may see: sources, senses, abilities and an optional time window."""

    async def create(self, body: Body = None, /, *, idempotency_key: str | None = None, **fields: Any) -> m.Grant:
        data = await self._t.request(
            "createGrant", body=body_of(m.GrantCreate, body, fields), idempotency_key=idempotency_key
        )
        return parse(m.Grant, data)

    async def delete(self, id: str) -> None:
        await self._t.request("deleteGrant", path={"id": id})

    def list(self, *, limit: int | None = None) -> AsyncIterator[m.Grant]:
        return self._t.paginate("listGrants", m.GrantsGetResponse, query={"limit": limit})


class AsyncAudit(_Resource):
    def list(
        self, *, from_: When | None = None, to: When | None = None, limit: int | None = None
    ) -> AsyncIterator[m.AuditEntry]:
        query = {"from": from_, "to": to, "limit": limit}
        return self._t.paginate("listAudit", m.AuditGetResponse, query=query)


class AsyncUsage(_Resource):
    async def get(self, *, from_: When | None = None, to: When | None = None) -> m.Usage:
        return parse(m.Usage, await self._t.request("getUsage", query={"from": from_, "to": to}))


class AsyncAccount(_Resource):
    async def get(self) -> m.Account:
        return parse(m.Account, await self._t.request("getAccount"))

    async def update(self, body: Body = None, /, **fields: Any) -> m.Account:
        """Raw retention may be capped by the instance; exceeding it raises quota_exceeded."""
        return parse(m.Account, await self._t.request("updateAccount", body=body_of(m.AccountUpdate, body, fields)))

    async def export(self) -> m.ExportResponse:
        return parse(m.ExportResponse, await self._t.request("exportAccount"))

    async def keys(self) -> m.AccountKeys:
        """The account's encryption key version, and whether a rotation is under way."""
        return parse(m.AccountKeys, await self._t.request("getAccountKeys"))

    async def rotate_keys(self) -> m.AccountKeys:
        """Starts re-encrypting stored footage under a new account key (owners)."""
        return parse(m.AccountKeys, await self._t.request("rotateAccountKeys"))

    async def export_status(self, id: str) -> m.ExportResponse:
        return parse(m.ExportResponse, await self._t.request("getAccountExport", path={"id": id}))

    async def delete(self) -> None:
        """Deletes the account and all its data (keys stop working at once)."""
        await self._t.request("deleteAccount")


class AsyncMe(_Resource):
    """The signed-in console user and their workspaces (ADR 0044)."""

    async def get(self) -> m.Me:
        return parse(m.Me, await self._t.request("getMe"))

    async def update(self, body: Body = None, /, **fields: Any) -> m.User:
        return parse(m.User, await self._t.request("updateMe", body=body_of(m.MeUpdate, body, fields)))

    async def switch_workspace(self, account_id: str) -> m.ConsoleSession:
        """Returns a session in the other workspace; the current one stops working."""
        data = await self._t.request("switchWorkspace", body={"account_id": account_id})
        return parse(m.ConsoleSession, data)


class AsyncMembers(_Resource):
    def list(self) -> AsyncIterator[m.Member]:
        return self._t.paginate("listMembers", m.MembersGetResponse, query={})

    async def update(self, id: str, role: str) -> m.Member:
        return parse(m.Member, await self._t.request("updateMember", path={"id": id}, body={"role": role}))

    async def remove(self, id: str) -> None:
        """Removes someone (admin), or leaves the workspace when id is yours."""
        await self._t.request("removeMember", path={"id": id})


class AsyncInvites(_Resource):
    async def create(self, body: Body = None, /, **fields: Any) -> m.InviteCreated:
        """The returned `invite_url` is shown once; send it to the person."""
        data = await self._t.request("createInvite", body=body_of(m.InviteCreate, body, fields))
        return parse(m.InviteCreated, data)

    def list(self) -> AsyncIterator[m.Invite]:
        return self._t.paginate("listInvites", m.InvitesGetResponse, query={})

    async def revoke(self, id: str) -> None:
        await self._t.request("revokeInvite", path={"id": id})


class AsyncSenseplane:
    """The Senseplane API.

    `AsyncSenseplane(api_key=...)` (or SENSEPLANE_API_KEY). `base_url` defaults to the hosted
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
        http_client: httpx.AsyncClient | None = None,
        default_headers: Mapping[str, str] | None = None,
    ) -> None:
        self._setup(
            AsyncTransport(
                api_key=resolve_api_key(api_key),
                base_url=resolve_base_url(base_url),
                timeout=timeout,
                max_retries=max_retries,
                http_client=http_client,
                headers=default_headers,
            )
        )

    def _setup(self, transport: AsyncTransport) -> None:
        self._transport = transport
        self.sources = AsyncSources(transport)
        self.live = AsyncLive(transport)
        self.bridge = AsyncBridge(transport)
        self.bridges = AsyncBridges(transport)
        self.devices = AsyncDevices(transport)
        self.confirmations = AsyncConfirmations(transport)
        self.speak_messages = AsyncSpeakMessages(transport)
        self.integration = AsyncIntegration(transport)
        self.capture = AsyncCapture(transport)
        self.watches = AsyncWatches(transport)
        self.inbox = AsyncInbox(transport)
        self.events = AsyncEvents(transport)
        self.clips = AsyncClips(transport)
        self.stories = AsyncStories(transport)
        self.follows = AsyncFollows(transport)
        self.conversations = AsyncConversations(transport)
        self.memory = AsyncMemory(transport)
        self.activity = AsyncActivity(transport)
        self.webhooks = AsyncWebhooks(transport)
        self.channels = AsyncChannels(transport)
        self.keys = AsyncKeys(transport)
        self.agents = AsyncAgents(transport)
        self.grants = AsyncGrants(transport)
        self.audit = AsyncAudit(transport)
        self.usage = AsyncUsage(transport)
        self.account = AsyncAccount(transport)
        self.me = AsyncMe(transport)
        self.members = AsyncMembers(transport)
        self.invites = AsyncInvites(transport)

    @property
    def base_url(self) -> str:
        return self._transport.base_url

    def with_options(
        self, *, timeout: float | httpx.Timeout | Literal[False] | None = False, max_retries: int | None = None
    ) -> AsyncSenseplane:
        """A copy with another timeout or retry count, sharing this client's connections."""
        copy = AsyncSenseplane.__new__(AsyncSenseplane)
        copy._setup(self._transport.copy(timeout=timeout, max_retries=max_retries))
        return copy

    async def close(self) -> None:
        """Closes the connection pool (unless you passed your own http_client)."""
        await self._transport.close()

    async def __aenter__(self) -> AsyncSenseplane:
        return self

    async def __aexit__(self, *exc: object) -> None:
        await self.close()


class AsyncSenseplaneDemo:
    """The live demo (the website's /try page): no API key, a short session with its own token."""

    def __init__(
        self,
        base_url: str | None = None,
        *,
        timeout: float | httpx.Timeout | None = DEFAULT_TIMEOUT,
        http_client: httpx.AsyncClient | None = None,
    ) -> None:
        self._t = AsyncTransport(
            api_key=None,
            base_url=resolve_base_url(base_url),
            timeout=timeout,
            max_retries=DEFAULT_MAX_RETRIES,
            http_client=http_client,
        )

    async def start(self) -> m.DemoSession:
        return parse(m.DemoSession, await self._t.request("createDemoSession"))

    async def ask(self, session: DemoSessionRef, question: str) -> m.DemoSessionsIdAskPostResponse:
        data = await self._t.request(
            "askDemo", path={"id": session.id}, body={"question": question}, token=session.token
        )
        return parse(m.DemoSessionsIdAskPostResponse, data)

    async def end(self, session: DemoSessionRef) -> None:
        await self._t.request("endDemoSession", path={"id": session.id}, token=session.token)

    async def stream(
        self, session: DemoSessionRef, *, reconnect: bool = True, max_reconnects: int = 5
    ) -> AsyncIterator[ServerSentEvent]:
        """The session's live events (`status`, `event`, `snapshot`, then `ended`).

        A dropped connection is reopened with backoff (up to `max_reconnects` times in a row,
        sending Last-Event-ID when the server gave ids) until the server sends `ended`.
        """
        failures = 0
        last_id: str | None = None
        while True:
            try:
                async for ev in self._t.sse(
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
            await asyncio.sleep(retry_delay(failures))
            failures += 1

    async def close(self) -> None:
        await self._t.close()

    async def __aenter__(self) -> AsyncSenseplaneDemo:
        return self

    async def __aexit__(self, *exc: object) -> None:
        await self.close()
