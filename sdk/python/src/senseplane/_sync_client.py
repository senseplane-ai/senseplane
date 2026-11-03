# Copyright 2026 The Senseplane Authors
# SPDX-License-Identifier: Apache-2.0
# Generated from _async_client.py. Do not edit; run `uv run python scripts/codegen.py` in sdk/python.

from __future__ import annotations

import builtins
import json
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
    | m.ConversationStreamEvent7
)
"""One event of a streamed answer: status, delta, moment, suggested_watch, story, then done (or error)."""
_CONVERSATION_EVENTS = frozenset({"status", "delta", "moment", "suggested_watch", "story", "done", "error"})

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
        if token == "":
            headers.pop("authorization", None)  # a call that takes no API key (a workflow's hook)
        elif token is not None:
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
        headers: Mapping[str, str] | None = None,
    ) -> Any:
        p = self._prepare(operation, token, headers, path=path, query=query, body=body, idempotency_key=idempotency_key)
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
            cursor = getattr(result, "next_cursor", None)  # some lists are one page, with no cursor
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

    def speak(self, id: str, text: str) -> m.SpeakMessage:
        """Says `text` through the camera's speaker (ADR 0069), after a short chime, in the server's one synthetic voice.

        Needs a speak grant (agents) and a camera with a speaker; at most 30 s, 6 a minute per camera,
        refused while someone else is speaking. Tell people they are hearing an automated system.
        Refusals raise a SenseplaneError whose `details["message"]` is the record.
        """
        data = self._t.request("speak", path={"id": id}, body={"text": text})
        return parse(m.SpeakMessage, data)

    def rotate_ingest_token(self, id: str) -> m.SourcesIdIngestTokenPostResponse:
        """A new WHIP, bridge or sensor integration token (shown once); the old one stops working."""
        data = self._t.request("rotateIngestToken", path={"id": id})
        return parse(m.SourcesIdIngestTokenPostResponse, data)

    def revoke_ingest_token(self, id: str) -> None:
        self._t.request("revokeIngestToken", path={"id": id})

    def webhook(self, id: str) -> m.ReadingsWebhook:
        """A sensor's readings webhook URL, and whether its pushes must be signed (ADR 0071)."""
        return parse(m.ReadingsWebhook, self._t.request("getReadingsWebhook", path={"id": id}))

    def create_webhook_secret(self, id: str) -> m.ReadingsWebhookSecret:
        """Turns signing on (or replaces the secret, shown once); every push with the sensor's token must then be signed."""
        return parse(m.ReadingsWebhookSecret, self._t.request("createReadingsWebhookSecret", path={"id": id}))

    def delete_webhook_secret(self, id: str) -> None:
        """Turns signing off."""
        self._t.request("deleteReadingsWebhookSecret", path={"id": id})

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
    """For a bridge (the box itself), with its bridge token as the client's key. `bridges` manages them."""

    def config(self) -> m.BridgeConfig:
        return parse(m.BridgeConfig, self._t.request("getBridgeConfig"))

    def claim_camera(self, body: Body = None, /, **fields: Any) -> m.BridgeCamera:
        """Registers (or finds) the camera at `rtsp_url` on this bridge."""
        data = self._t.request("claimBridgeCamera", body=body_of(m.BridgeCamerasPostRequest, body, fields))
        return parse(m.BridgeCamera, data)

    def health(self, body: Body = None, /, **fields: Any) -> None:
        self._t.request("postBridgeHealth", body=body_of(m.BridgeHealth, body, fields))

    def cameras_found(self, body: Body = None, /, **fields: Any) -> None:
        """Reports the cameras it found on the network (`cameras=[...]`), replacing the last list."""
        self._t.request("putBridgeCamerasFound", body=body_of(m.BridgeCamerasFoundPutRequest, body, fields))

    def entities(self) -> m.BridgeEntitiesGetResponse:
        """The Home Assistant entities this bridge reported, and which were chosen."""
        return parse(m.BridgeEntitiesGetResponse, self._t.request("getOwnBridgeEntities"))

    def put_entities(self, body: Body = None, /, **fields: Any) -> None:
        """Reports the entities it can see (`entities=[...]`), replacing the last list."""
        self._t.request("putBridgeEntities", body=body_of(m.BridgeEntitiesPutRequest, body, fields))

    def choose_entities(self, body: Body = None, /, **fields: Any) -> None:
        """`choose=[...]` and `drop=[...]` entity ids, from the box itself."""
        self._t.request("chooseOwnBridgeEntities", body=body_of(m.BridgeEntitiesChoosePostRequest, body, fields))

    def push_readings(self, body: Body = None, /, **fields: Any) -> m.BridgeReadingsPostResponse:
        """Readings of its chosen entities (`readings=[...]`); ones for entities not chosen are ignored."""
        data = self._t.request("postBridgeReadings", body=body_of(m.ReadingsRequest, body, fields))
        return parse(m.BridgeReadingsPostResponse, data)

    def take_outputs(self, *, after: str | None = None, wait: int | None = None) -> m.BridgeOutputs:
        """What this box may publish to its MQTT broker (ADR 0071), long-polled; pass the last `cursor` as `after`."""
        return parse(m.BridgeOutputs, self._t.request("takeBridgeOutputs", query={"after": after, "wait": wait}))

    def take_commands(self, *, wait: int | None = None) -> m.BridgeCommandsGetResponse:
        """Commands waiting for this bridge; `wait` seconds holds the request open until one arrives."""
        return parse(m.BridgeCommandsGetResponse, self._t.request("takeBridgeCommands", query={"wait": wait}))

    def finish_command(self, id: str, body: Body = None, /, **fields: Any) -> None:
        """Reports how a command went: `ok`, and `result` or `error`."""
        body = body_of(m.BridgeCommandsIdPostRequest, body, fields)
        self._t.request("finishBridgeCommand", path={"id": id}, body=body)

    def start_pairing(self, *, name: str | None = None) -> m.BridgePairPostResponse:
        """Starts pairing a new box (no key needed): show `user_code`, then `poll_pairing(device_code)`."""
        data = self._t.request("startBridgePairing", body={"name": name} if name else {})
        return parse(m.BridgePairPostResponse, data)

    def poll_pairing(self, device_code: str) -> m.BridgePairTokenPostResponse:
        """Whether a person approved the pairing yet; once approved, the bridge token (shown once)."""
        data = self._t.request("pollBridgePairing", body={"device_code": device_code})
        return parse(m.BridgePairTokenPostResponse, data)


class Bridges(_Resource):
    """Boxes on your network that relay cameras, Home Assistant entities and Matter devices (ADR 0045)."""

    def list(self) -> Iterator[m.Bridge]:
        return self._t.paginate("listBridges", m.BridgesGetResponse, query={})

    def create(self, name: str) -> m.Bridge:
        """A new box; its token is in the response, shown once."""
        return parse(m.Bridge, self._t.request("createBridge", body={"name": name}))

    def update(self, id: str, body: Body = None, /, **fields: Any) -> m.Bridge:
        """Renames a box (`name`), or turns publishing to its MQTT broker on or off (`mqtt_publish`, ADR 0071)."""
        return parse(
            m.Bridge,
            self._t.request("updateBridge", path={"id": id}, body=body_of(m.BridgesIdPatchRequest, body, fields)),
        )

    def remove(self, id: str) -> None:
        """Removes a box; its cameras and sensors keep their history."""
        self._t.request("removeBridge", path={"id": id})

    def find_pairing(self, code: str) -> m.BridgesPairGetResponse:
        """The box waiting to pair with the code it shows."""
        return parse(m.BridgesPairGetResponse, self._t.request("findBridgePairing", query={"code": code}))

    def approve_pairing(self, code: str, *, name: str | None = None) -> m.Bridge:
        body = {"code": code, **({"name": name} if name else {})}
        return parse(m.Bridge, self._t.request("approveBridgePairing", body=body))

    def entities(self, id: str) -> m.BridgesIdEntitiesGetResponse:
        """The Home Assistant entities the box reported, and which are chosen."""
        return parse(m.BridgesIdEntitiesGetResponse, self._t.request("listBridgeEntities", path={"id": id}))

    def choose_entities(self, id: str, body: Body = None, /, **fields: Any) -> m.BridgesIdEntitiesPatchResponse:
        """`choose=[...]` entity ids to read (and control), `drop=[...]` to stop."""
        body = body_of(m.BridgesIdEntitiesPatchRequest, body, fields)
        data = self._t.request("chooseBridgeEntities", path={"id": id}, body=body)
        return parse(m.BridgesIdEntitiesPatchResponse, data)

    def add_matter_device(self, id: str, code: str) -> m.BridgeCommand:
        """Adds a Matter device with its pairing code; follow the returned command with `command`."""
        data = self._t.request("addMatterDevice", path={"id": id}, body={"code": code})
        return parse(m.BridgeCommand, data)

    def cameras_found(self, id: str) -> m.BridgesIdCamerasFoundGetResponse:
        """Cameras the box found on its network."""
        data = self._t.request("listBridgeCamerasFound", path={"id": id})
        return parse(m.BridgesIdCamerasFoundGetResponse, data)

    def search_cameras(self, id: str) -> m.BridgeCommand:
        """Asks the box to look for cameras again."""
        return parse(m.BridgeCommand, self._t.request("searchBridgeCameras", path={"id": id}))

    def add_onvif_camera(self, id: str, body: Body = None, /, **fields: Any) -> m.BridgeCommand:
        """Adds a found ONVIF camera: `camera`, `username`, `password` (and `name`)."""
        body = body_of(m.BridgesIdOnvifPostRequest, body, fields)
        return parse(m.BridgeCommand, self._t.request("addOnvifCamera", path={"id": id}, body=body))

    def command(self, id: str, command_id: str) -> m.BridgeCommand:
        """What happened to a command sent to the box."""
        data = self._t.request("getBridgeCommand", path={"id": id, "cid": command_id})
        return parse(m.BridgeCommand, data)


class Devices(_Resource):
    """Devices a person (or an agent they granted Control) can switch (ADR 0067).

    `command` answers with the state the box read back; a lock, garage door, gate or alarm
    asked for by an agent comes back `awaiting_confirmation` until a person confirms it.
    Offline boxes and failures raise a SenseplaneError whose `details["command"]` is the request.
    """

    def list(self) -> Iterator[m.Device]:
        return self._t.paginate("listDevices", m.DevicesGetResponse, query={})

    def get(self, id: str) -> m.Device:
        return parse(m.Device, self._t.request("getDevice", path={"id": id}))

    def set_controllable(self, id: str, controllable: bool) -> m.Device:
        """Admins: show the device's `warning` first."""
        data = self._t.request("updateDevice", path={"id": id}, body={"controllable": controllable})
        return parse(m.Device, data)

    def command(
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
        data = self._t.request("controlDevice", path={"id": id}, body=body, headers=headers)
        return parse(m.DeviceCommand, data)

    def request(self, id: str) -> m.DeviceCommand:
        """What happened to a request: poll one that is `sent` or `awaiting_confirmation`."""
        return parse(m.DeviceCommand, self._t.request("getDeviceCommand", path={"id": id}))


class SpeakMessages(_Resource):
    """What was said through cameras (agents, watches and push-to-talk), each with a link to hear the clip."""

    def list(self, *, source: str | None = None, limit: int | None = None) -> list[m.SpeakMessage]:
        query: dict[str, Any] = {}
        if source is not None:
            query["source"] = source
        if limit is not None:
            query["limit"] = limit
        data = self._t.request("listSpeakMessages", query=query)
        return parse(m.SpeakMessagesGetResponse, data).data

    def get(self, id: str) -> m.SpeakMessage:
        return parse(m.SpeakMessage, self._t.request("getSpeakMessage", path={"id": id}))


class Confirmations(_Resource):
    """Requests waiting for a person; only people signed in can answer them."""

    def list(self) -> Iterator[m.DeviceCommand]:
        return self._t.paginate("listConfirmations", m.ConfirmationsGetResponse, query={})

    def decide(self, id: str, approve: bool) -> m.DeviceCommand:
        data = self._t.request("decideConfirmation", path={"id": id}, body={"approve": approve})
        return parse(m.DeviceCommand, data)


class Integration(_Resource):
    """For a sensor integration, with its token as the client's key."""

    def get(self) -> m.IntegrationGetResponse:
        """The source this token feeds (then `sources.push_readings`)."""
        return parse(m.IntegrationGetResponse, self._t.request("getIntegration"))

    def push(
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
        res = self._t.request("pushWebhookReadings", body=data, headers=headers)
        return parse(m.IntegrationReadingsPostResponse, res)


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


class Stories(_Resource):
    """One video from many moments across cameras (ADR 0070), rendered in the background: poll `get` until `ready`."""

    def create(self, body: Body = None, /, *, idempotency_key: str | None = None, **fields: Any) -> m.Story:
        """`create(moments=[{"event": id}, {"source": id, "from": ..., "to": ...}])` or `create(search={"q": "the courier"})`."""
        data = self._t.request(
            "createStory", body=body_of(m.StoryCreate, body, fields), idempotency_key=idempotency_key
        )
        return parse(m.Story, data)

    def get(self, id: str) -> m.Story:
        return parse(m.Story, self._t.request("getStory", path={"id": id}))

    def delete(self, id: str) -> None:
        self._t.request("deleteStory", path={"id": id})

    def list(self, *, limit: int | None = None) -> list[m.Story]:
        return parse(m.StoriesGetResponse, self._t.request("listStories", query={"limit": limit})).data

    def link(self, id: str, *, expires_in_s: int | None = None) -> m.StoriesIdLinkPostResponse:
        """A longer-lived signed link to share a ready story (at most 7 days)."""
        body = {"expires_in_s": expires_in_s} if expires_in_s else {}
        return parse(m.StoriesIdLinkPostResponse, self._t.request("createStoryLink", path={"id": id}, body=body))


class Follows(_Resource):
    """Following an object or a pet across cameras, never a person (ADR 0070): poll `get` until `done`."""

    def create(self, body: Body = None, /, *, idempotency_key: str | None = None, **fields: Any) -> m.Follow:
        """`create(reference={"event": id, "box": [x1, y1, x2, y2]}, from_=..., to=...)`."""
        data = self._t.request(
            "createFollow", body=body_of(m.FollowCreate, body, fields), idempotency_key=idempotency_key
        )
        return parse(m.Follow, data)

    def get(self, id: str) -> m.Follow:
        return parse(m.Follow, self._t.request("getFollow", path={"id": id}))

    def delete(self, id: str) -> None:
        self._t.request("deleteFollow", path={"id": id})

    def list(self, *, limit: int | None = None) -> list[m.Follow]:
        return parse(m.FollowsGetResponse, self._t.request("listFollows", query={"limit": limit})).data


class Workflows(_Resource):
    """Workflows (ADR 0072): a trigger and steps that tell, ask, speak, clip, make stories and wait.

    No step ever switches a device. Admins and up make them; runs act on the workflow's own
    sources with an agent's grant and privacy rules.
    """

    def create(self, body: Body = None, /, **fields: Any) -> m.WorkflowCreated:
        """`create(name=..., sources=[...], trigger={"type": "event", ...}, steps=[...], edges=[...])`.

        A webhook trigger's `hook_secret` is in this answer only.
        """
        return parse(m.WorkflowCreated, self._t.request("createWorkflow", body=body_of(m.WorkflowCreate, body, fields)))

    def get(self, id: str) -> m.Workflow:
        return parse(m.Workflow, self._t.request("getWorkflow", path={"id": id}))

    def update(self, id: str, body: Body = None, /, **fields: Any) -> m.WorkflowCreated:
        """Checked in full as on creation; `update(id, enabled=False)` turns it off."""
        data = self._t.request("updateWorkflow", path={"id": id}, body=body_of(m.WorkflowUpdate, body, fields))
        return parse(m.WorkflowCreated, data)

    def delete(self, id: str) -> None:
        self._t.request("deleteWorkflow", path={"id": id})

    def list(self) -> list[m.Workflow]:
        return parse(m.WorkflowsGetResponse, self._t.request("listWorkflows")).data

    def run(self, id: str, input: Mapping[str, Any] | None = None) -> m.WorkflowRun:
        """Starts a run by hand (a schedule or webhook trigger), with what a webhook would have sent."""
        body = {"input": dict(input)} if input is not None else {}
        return parse(m.WorkflowRun, self._t.request("runWorkflow", path={"id": id}, body=body))

    def rotate_hook_secret(self, id: str) -> m.WorkflowCreated:
        """A new hook secret (shown once); the old one stops working."""
        return parse(m.WorkflowCreated, self._t.request("rotateWorkflowHookSecret", path={"id": id}))

    def runs(self, id: str, *, status: str | None = None, limit: int | None = None) -> builtins.list[m.WorkflowRun]:
        data = self._t.request("listWorkflowRuns", path={"id": id}, query={"status": status, "limit": limit})
        return parse(m.WorkflowsIdRunsGetResponse, data).data

    def get_run(self, id: str) -> m.WorkflowRun:
        """A run with each step's status, timing, output and error."""
        return parse(m.WorkflowRun, self._t.request("getWorkflowRun", path={"id": id}))

    def cancel_run(self, id: str) -> m.WorkflowRun:
        """Stops a run: its remaining steps are skipped (admins and up)."""
        return parse(m.WorkflowRun, self._t.request("cancelWorkflowRun", path={"id": id}))

    def trigger(
        self, id: str, hook_secret: str, input: Mapping[str, Any] | None = None
    ) -> m.WorkflowHooksIdPostResponse:
        """Starts a workflow with a webhook trigger, signed with its hook secret, as n8n or a script would.

        The `Senseplane-Signature` covers the exact body sent; no API key goes with it.
        """
        data = dict(input or {})
        signature = sign_webhook(json.dumps(data, separators=(",", ":")), hook_secret)
        res = self._t.request(
            "triggerWorkflowHook", path={"id": id}, body=data, token="", headers={"senseplane-signature": signature}
        )
        return parse(m.WorkflowHooksIdPostResponse, res)


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

    def keys(self) -> m.AccountKeys:
        """The account's encryption key version, and whether a rotation is under way."""
        return parse(m.AccountKeys, self._t.request("getAccountKeys"))

    def rotate_keys(self) -> m.AccountKeys:
        """Starts re-encrypting stored footage under a new account key (owners)."""
        return parse(m.AccountKeys, self._t.request("rotateAccountKeys"))

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
        self.bridges = Bridges(transport)
        self.devices = Devices(transport)
        self.confirmations = Confirmations(transport)
        self.speak_messages = SpeakMessages(transport)
        self.integration = Integration(transport)
        self.capture = Capture(transport)
        self.watches = Watches(transport)
        self.inbox = Inbox(transport)
        self.events = Events(transport)
        self.clips = Clips(transport)
        self.stories = Stories(transport)
        self.follows = Follows(transport)
        self.workflows = Workflows(transport)
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
