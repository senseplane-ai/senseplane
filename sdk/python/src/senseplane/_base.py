# Copyright 2026 The Senseplane Authors
# SPDX-License-Identifier: Apache-2.0

# What the sync and async clients share and that does no I/O: building
# requests, deciding retries, mapping errors, parsing responses, reading
# Server-Sent Events line by line.
from __future__ import annotations

import json
import os
import random
import types
import typing
import uuid
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import date, datetime, timezone
from email.utils import parsedate_to_datetime
from typing import Any, Literal, TypeVar, cast
from urllib.parse import quote

import httpx
from pydantic import BaseModel, RootModel, TypeAdapter, ValidationError

from ._errors import APIConnectionError, SenseplaneError, error_class
from ._generated.api import OPERATIONS
from ._version import __version__

DEFAULT_BASE_URL = "https://api.senseplane.com/v1"
"""The hosted API. Set `base_url` (or SENSEPLANE_API_URL) for your own instance, e.g. http://localhost:8080/v1."""
DEFAULT_TIMEOUT = httpx.Timeout(60.0, connect=10.0)
"""Asking a question waits for the model, so reads get a minute."""
DEFAULT_MAX_RETRIES = 2

M = TypeVar("M", bound=BaseModel)

# Retried when the request may be repeated safely: these methods always, and
# a POST or PATCH only when it carries an Idempotency-Key.
_SAFE_METHODS = frozenset({"GET", "HEAD", "PUT", "DELETE", "OPTIONS"})
_RETRY_STATUSES = frozenset({500, 502, 503, 504})
_MAX_RETRY_AFTER_S = 30.0


def resolve_api_key(api_key: str | None) -> str:
    key = api_key if api_key is not None else os.environ.get("SENSEPLANE_API_KEY")
    if not key:
        raise ValueError("pass api_key or set SENSEPLANE_API_KEY")
    return key


def resolve_base_url(base_url: str | None) -> str:
    return (base_url or os.environ.get("SENSEPLANE_API_URL") or DEFAULT_BASE_URL).rstrip("/")


def default_headers(api_key: str | None) -> dict[str, str]:
    h = {"user-agent": f"senseplane-python/{__version__}"}
    if api_key:
        h["authorization"] = f"Bearer {api_key}"
    return h


def jsonable(value: Any) -> Any:
    """Models (by their API names), datetimes and nested containers as plain JSON values."""
    if isinstance(value, BaseModel):
        return value.model_dump(mode="json", by_alias=True, exclude_unset=True)
    if isinstance(value, datetime):
        return iso(value)
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, Mapping):
        return {str(k): jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [jsonable(v) for v in value]
    return value


def iso(value: datetime) -> str:
    """ISO 8601 in UTC with a Z, as the API writes times; naive datetimes are taken as UTC."""
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def body_of(model: type[BaseModel], body: BaseModel | Mapping[str, Any] | None, fields: Mapping[str, Any]) -> Any:
    """A request body from a model, a dict (sent as given) or keyword arguments (checked against the model).

    Keyword arguments use Python names (`from_` for `from`) and are validated, so a typo in a
    known field fails before the request; a dict is sent exactly as written.
    """
    if not fields:
        return jsonable(body) if body is not None else {}
    base: dict[str, Any] = {}
    if isinstance(body, BaseModel):
        base = body.model_dump(by_alias=False, exclude_unset=True)
    elif body is not None:
        base = dict(body)
    return jsonable(model.model_validate({**base, **fields}))


def query_of(params: Mapping[str, Any]) -> dict[str, str]:
    """Query parameters: None dropped, booleans as true/false, datetimes as ISO 8601."""
    out: dict[str, str] = {}
    for key, value in params.items():
        if value is None:
            continue
        name = key[:-1] if key.endswith("_") else key  # from_ -> from
        if isinstance(value, bool):
            out[name] = "true" if value else "false"
        elif isinstance(value, datetime):
            out[name] = iso(value)
        else:
            out[name] = str(value)
    return out


@dataclass
class Prepared:
    """One request, ready to send (and resend: the Idempotency-Key is fixed here)."""

    method: str
    url: str
    params: dict[str, str]
    json: Any
    headers: dict[str, str]
    retryable: bool


def prepare(
    operation: str,
    *,
    path: Mapping[str, str] | None = None,
    query: Mapping[str, Any] | None = None,
    body: Any = None,
    idempotency_key: str | None = None,
    headers: Mapping[str, str] | None = None,
) -> Prepared:
    op = OPERATIONS[operation]
    url = op.path
    for name, value in (path or {}).items():
        url = url.replace("{" + name + "}", quote(str(value), safe=""))
    h = dict(headers or {})
    if op.idempotent:
        # A key per call, reused by every retry of it: a create can't happen twice (24 h, ADR 0030).
        h["idempotency-key"] = idempotency_key or f"sp-py-{uuid.uuid4()}"
    elif idempotency_key:
        raise ValueError(f"{operation} doesn't take an idempotency key")
    retryable = op.method in _SAFE_METHODS or "idempotency-key" in h
    return Prepared(op.method, url, query_of(query or {}), body, h, retryable)


def to_request(client: httpx.Client | httpx.AsyncClient, p: Prepared, base_url: str, timeout: Any) -> httpx.Request:
    kwargs: dict[str, Any] = {"params": p.params, "headers": p.headers, "timeout": timeout}
    if p.json is not None:
        kwargs["content"] = json.dumps(p.json, separators=(",", ":")).encode()
        kwargs["headers"] = {**p.headers, "content-type": "application/json"}
    return client.build_request(p.method, base_url + p.url, **kwargs)


def retry_delay(attempt: int, retry_after: str | None = None) -> float:
    """Seconds before retry `attempt` (0-based): Retry-After when the API sent one, else 0.5 s doubling, with jitter."""
    if retry_after:
        try:
            return min(max(float(retry_after), 0.0), _MAX_RETRY_AFTER_S)
        except ValueError:
            try:
                when = parsedate_to_datetime(retry_after)
                wait = float((when - datetime.now(timezone.utc)).total_seconds())
                return min(max(wait, 0.0), _MAX_RETRY_AFTER_S)
            except (TypeError, ValueError):
                pass
    base = min(0.5 * 2.0**attempt, 8.0)
    return base * (0.75 + random.random() * 0.5)


def should_retry_status(p: Prepared, status: int) -> bool:
    # 429 is refused before any work is done, so any method may try again.
    return status == 429 or (p.retryable and status in _RETRY_STATUSES)


def should_retry_error(p: Prepared, err: httpx.TransportError) -> bool:
    # A connection that never opened sent nothing, so any method may try again.
    return p.retryable or isinstance(err, (httpx.ConnectError, httpx.ConnectTimeout))


def connection_error(err: httpx.TransportError) -> APIConnectionError:
    timeout = isinstance(err, httpx.TimeoutException)
    return APIConnectionError(f"{'timed out' if timeout else 'connection failed'}: {err}", timeout=timeout)


def api_error(status: int, headers: httpx.Headers, content: bytes, reason: str = "") -> SenseplaneError:
    """The typed error for a non-2xx response; bodies that aren't the API's error shape still map."""
    e: dict[str, Any] = {}
    try:
        parsed = json.loads(content) if content else {}
        if isinstance(parsed, dict) and isinstance(parsed.get("error"), dict):
            e = parsed["error"]
    except ValueError:
        pass
    cls = error_class(status)
    return cls(
        status,
        str(e.get("code") or "unknown"),
        str(e.get("message") or reason or f"HTTP {status}"),
        e.get("request_id") or headers.get("x-request-id"),
        e.get("details") if isinstance(e.get("details"), dict) else None,
    )


def decode(response: httpx.Response) -> Any:
    if response.status_code == 204 or not response.content:
        return None
    return response.json()


# Parsing --------------------------------------------------------------------
#
# Responses are validated into the generated models. An instance newer than
# this SDK may send a value it doesn't know yet (a new event type, a new
# status); rather than fail, such a response is built field by field, keeping
# every value it can type and the raw value where it can't.


def parse(model: type[M], data: Any) -> M:
    try:
        return model.model_validate(data)
    except ValidationError:
        return _construct(model, data)


def _construct(model: type[M], data: Any) -> M:
    if issubclass(model, RootModel):
        root = model.model_fields["root"].annotation
        return cast(M, model.model_construct(root=_coerce(root, data)))
    if not isinstance(data, Mapping):
        return model.model_construct()
    values: dict[str, Any] = {}
    known: set[str] = set()
    for name, field in model.model_fields.items():
        key = field.alias or name
        known.add(key)
        if key in data:
            values[name] = _coerce(field.annotation, data[key])
    extra = {k: v for k, v in data.items() if k not in known}
    return model.model_construct(**values, **extra)


def _tags_match(model: type[BaseModel], value: Mapping[str, Any]) -> bool:
    """False when a Literal field (a union's tag, such as `event` or `type`) has another value."""
    for name, field in model.model_fields.items():
        key = field.alias or name
        if typing.get_origin(field.annotation) is Literal and key in value:
            if value[key] not in typing.get_args(field.annotation):
                return False
    return True


def _coerce(annotation: Any, value: Any) -> Any:
    if value is None or annotation is None:
        return value
    origin = typing.get_origin(annotation)
    args = typing.get_args(annotation)
    if origin is typing.Annotated:
        return _coerce(args[0], value)
    if origin in (typing.Union, types.UnionType):
        for arg in args:
            if arg is type(None):
                continue
            try:
                return TypeAdapter(arg).validate_python(value)
            except ValidationError:
                continue
        if isinstance(value, Mapping):
            models = [a for a in args if isinstance(a, type) and issubclass(a, BaseModel)]
            for arg in sorted(models, key=lambda a: not _tags_match(a, value)):
                return _construct(arg, value)
        return value
    if origin is list and isinstance(value, list) and args:
        return [_coerce(args[0], v) for v in value]
    if isinstance(annotation, type) and issubclass(annotation, BaseModel):
        try:
            return annotation.model_validate(value)
        except ValidationError:
            return _construct(annotation, value)
    try:
        return TypeAdapter(annotation).validate_python(value)
    except (ValidationError, TypeError):
        return value


# Server-Sent Events -----------------------------------------------------------


@dataclass(frozen=True)
class ServerSentEvent:
    """One Server-Sent Event: its name (`message` when unnamed) and its `data:` parsed as JSON."""

    event: str
    data: Any
    id: str | None = None


class SSEDecoder:
    """Turns the lines of a text/event-stream into events (comments and keep-alives are skipped)."""

    def __init__(self) -> None:
        self._event = ""
        self._data: list[str] = []
        self._id: str | None = None
        self.last_id: str | None = None
        self.retry_ms: int | None = None

    def feed(self, line: str) -> ServerSentEvent | None:
        line = line.rstrip("\r")
        if not line:
            return self._dispatch()
        if line.startswith(":"):
            return None
        name, _, value = line.partition(":")
        if value.startswith(" "):
            value = value[1:]
        if name == "event":
            self._event = value
        elif name == "data":
            self._data.append(value)
        elif name == "id" and "\0" not in value:
            self._id = value
        elif name == "retry" and value.isdigit():
            self.retry_ms = int(value)
        return None

    def _dispatch(self) -> ServerSentEvent | None:
        event, data, self._event, self._data = self._event or "message", self._data, "", []
        if self._id is not None:
            self.last_id, self._id = self._id, None
        if not data:
            return None
        text = "\n".join(data)
        try:
            parsed: Any = json.loads(text)
        except ValueError:
            parsed = text
        return ServerSentEvent(event, parsed, self.last_id)


def sse_headers(last_event_id: str | None = None) -> dict[str, str]:
    h = {"accept": "text/event-stream", "cache-control": "no-cache"}
    if last_event_id:
        h["last-event-id"] = last_event_id
    return h
