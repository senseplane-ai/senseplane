# Copyright 2026 The Senseplane Authors
# SPDX-License-Identifier: Apache-2.0
# Generated from _async_tools.py. Do not edit; run `uv run python scripts/codegen.py` in sdk/python.

from __future__ import annotations

import base64
import json
import math
import time
from collections.abc import Mapping
from datetime import datetime, timedelta, timezone
from time import monotonic
from time import time as wall_clock
from typing import Any

from ._base import jsonable
from ._errors import SenseplaneError
from ._sync_client import Senseplane
from ._tool_defs import ToolResult, anthropic_tools, openai_tools, tool_names
from .senses import is_sensor_sense, js_round, reading_text, sense_name

__all__ = ["Toolkit"]

_Args = Mapping[str, Any]


def _text(value: Any) -> ToolResult:
    return ToolResult([{"type": "text", "text": json.dumps(value, indent=2, default=str)}])


def _fail(code: str, message: str) -> ToolResult:
    return ToolResult([{"type": "text", "text": json.dumps({"error": {"code": code, "message": message}})}], True)


def _ms(value: Any) -> float:
    return datetime.fromisoformat(str(value).replace("Z", "+00:00")).timestamp() * 1000


def _field(obj: Any, key: str) -> Any:
    """A field of an SDK object (Anthropic, OpenAI) or of its dict form."""
    return obj.get(key) if isinstance(obj, Mapping) else getattr(obj, key)


def _pick(d: Mapping[str, Any], *keys: str) -> dict[str, Any]:
    """The keys `d` has (a field the API left out stays out, as JSON.stringify drops undefined)."""
    return {k: d[k] for k in keys if k in d}


def _is_number(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def _number(v: Any) -> float | None:
    """JavaScript's Number(): true is 1; what isn't a number is null in the JSON."""
    try:
        n = float(v)
    except (TypeError, ValueError):
        return None
    return None if math.isnan(n) else n


def _said(m: Mapping[str, Any]) -> dict[str, Any]:
    """What an agent needs to know about a message it said through a camera (ADR 0069), as the MCP server words it."""
    out: dict[str, Any] = {"message_id": m.get("id"), "source": m.get("source_id"), "status": m.get("status")}
    if m.get("message"):
        out["message"] = m["message"]
    if m.get("duration_ms"):
        out["duration_ms"] = m["duration_ms"]
    if m.get("clip_url"):
        out["clip_url"] = m["clip_url"]
    if m.get("status") == "playing":
        out["note"] = "It is playing on the camera now, after a short chime."
    if m.get("status") == "sent":
        out["note"] = "The camera's box has it; it hasn't said it has played it yet."
    return out


def _request(c: Mapping[str, Any]) -> dict[str, Any]:
    """A device request as the MCP server words it."""
    out = {
        "request": c.get("id"),
        "device": c.get("device_name"),
        **{k: c.get(k) for k in ("action", "status", "message", "state")},
    }
    if c.get("expires_at") and c.get("status") == "awaiting_confirmation":
        out["confirm_by"] = c["expires_at"]
    return out


def _brief(e: Mapping[str, Any]) -> dict[str, Any]:
    return {**_pick(e, "id", "type", "source", "occurred_at", "summary", "confidence"), **(e.get("media") or {})}


def _inbox_brief(i: Mapping[str, Any]) -> dict[str, Any]:
    ev = i["event"]
    return {
        "inbox_id": i["id"],
        **({"watch_id": i["watch_id"]} if i.get("watch_id") else {}),
        "event_id": ev["id"],
        "source": ev["source"].get("name") or ev["source"]["id"],
        "occurred_at": ev["occurred_at"],
        "summary": ev["summary"],
    }


class Toolkit:
    """Senseplane's agent tools bound to a client: schemas for your model, and a dispatcher.

        toolkit = Toolkit(client)
        tools = toolkit.anthropic()          # or toolkit.openai()
        result = toolkit.call("look", {"source": "Front door"})

    `call` never raises for API errors: like the MCP server, it returns a result with
    `is_error` set and `{"error": {"code", "message"}}` as text, for the model to read.
    """

    def __init__(self, client: Senseplane, *, tools: list[str] | None = None) -> None:
        self.client = client
        self.names = tool_names(tools)
        self._cache: tuple[float, list[dict[str, Any]]] | None = None
        self._agent: str | None = None
        self._agent_known = False

    def anthropic(self) -> list[dict[str, Any]]:
        """Tool definitions for the Anthropic Messages API (`tools=`)."""
        return anthropic_tools(self.names)

    def openai(self, *, api: str = "chat") -> list[dict[str, Any]]:
        """Tool definitions for OpenAI: `api="chat"` (Chat Completions) or `"responses"`."""
        return openai_tools(self.names, api=api)

    def call(self, name: str, arguments: _Args | str | None = None) -> ToolResult:
        """Runs one tool. `arguments` may be a dict or the JSON string a model produced."""
        handler = getattr(self, f"_tool_{name}", None) if name in self.names else None
        if handler is None:
            return _fail("not_found", f"unknown tool {name}")
        try:
            args = json.loads(arguments) if isinstance(arguments, str) else dict(arguments or {})
            result: ToolResult = handler(args)
            return result
        except SenseplaneError as err:
            return _fail(err.code, err.message)
        except Exception as err:  # a tool result, not a crash, so the model can recover
            return _fail("internal", str(err))

    def call_anthropic(self, block: Any) -> dict[str, Any]:
        """Runs a `tool_use` content block (an SDK object or a dict); returns the `tool_result` block."""
        result = self.call(str(_field(block, "name")), _field(block, "input"))
        return result.anthropic(str(_field(block, "id")))

    def call_openai(self, tool_call: Any) -> dict[str, Any]:
        """Runs a Chat Completions tool call (object or dict); returns the `role: tool` message."""
        fn = _field(tool_call, "function")
        result = self.call(str(_field(fn, "name")), _field(fn, "arguments"))
        return {"role": "tool", "tool_call_id": _field(tool_call, "id"), "content": result.text()}

    # Helpers ------------------------------------------------------------------

    def _sources(self) -> list[dict[str, Any]]:
        if self._cache is None or monotonic() - self._cache[0] > 10:
            sources = [jsonable(s) for s in self.client.sources.list()]
            self._cache = (monotonic(), sources)
        return self._cache[1]

    def _resolve(self, ref: Any) -> dict[str, Any]:
        """An id or a (case-insensitive) name, so agents can say "front door"."""
        r = str(ref if ref is not None else "").strip()
        sources = self._sources()
        hit = next((s for s in sources if s["id"] == r), None) or next(
            (s for s in sources if s["name"].lower() == r.lower()), None
        )
        if hit is None:
            raise SenseplaneError(404, "not_found", f'no source "{r}"; call list_senses for the ids')
        return hit

    def _agent_id(self) -> str | None:
        """This caller's agent id (agent keys have an inbox; account keys don't)."""
        if not self._agent_known:
            try:
                self._agent = (self.client.inbox.list(limit=1)).agent_id
                self._agent_known = True
            except SenseplaneError as err:
                if 0 < err.status < 500:  # a transient failure: ask again next time
                    self._agent, self._agent_known = None, True
        return self._agent

    def _image(self, url: str) -> dict[str, Any] | None:
        response = self.client._transport.http.get(url, timeout=self.client._transport.timeout)
        if response.status_code >= 400:
            return None
        mime = (response.headers.get("content-type") or "").split(";")[0] or "image/jpeg"
        return {"type": "image", "data": base64.b64encode(response.content).decode(), "mime_type": mime}

    # The tools ----------------------------------------------------------------

    def _tool_list_senses(self, a: dict[str, Any]) -> ToolResult:
        keys = ("id", "name", "location", "type", "senses", "status")
        out = []
        for s in self._sources():
            row = _pick(s, *keys)
            if s.get("speaker"):
                row["speaker"] = True
            out.append(row)
        return _text({"sources": out})

    def _tool_speak(self, a: dict[str, Any]) -> ToolResult:
        src = self._resolve(a.get("source"))
        words = str(a.get("text") or "").strip()
        if not words:
            return _fail("validation_failed", "give the text to say")
        try:
            m = jsonable(self.client.sources.speak(src["id"], words))
        except SenseplaneError as err:
            # Refused, offline and too long carry the recorded message.
            msg = (err.details or {}).get("message")
            if isinstance(msg, Mapping):
                body = {"error": {"code": err.code, "message": err.message}, **_said(msg)}
                return ToolResult([{"type": "text", "text": json.dumps(body, indent=2, default=str)}], True)
            raise
        return _text(_said(m))

    def _tool_look(self, a: dict[str, Any]) -> ToolResult:
        src = self._resolve(a.get("source"))
        if "video" not in src["senses"]:
            return _fail("forbidden_sense", f"{src['name']} has no video")
        if a.get("question"):
            r = self.client.sources.ask(src["id"], question=str(a["question"]))
            img = self._image(r.snapshot_url)
            info = {"source": src["id"], "answer": r.answer, "confidence": r.confidence, "snapshot_url": r.snapshot_url}
            return ToolResult([*([img] if img else []), *_text(info).content])
        now = self.client.sources.now(src["id"])
        if not now.snapshot_url:
            return _fail("not_found", f"{src['name']} has no picture yet")
        img = self._image(now.snapshot_url)
        if img is None:
            return _fail("not_found", f"{src['name']} isn't streaming right now (no live frame)")
        info = {"source": src["id"], "captured_at": jsonable(now.captured_at), "snapshot_url": now.snapshot_url}
        return ToolResult([img, *_text(info).content])

    def _tool_listen(self, a: dict[str, Any]) -> ToolResult:
        src = self._resolve(a.get("source"))
        if "audio" not in src["senses"]:
            return _fail("forbidden_sense", f"{src['name']} has no audio (or it isn't granted)")
        seconds = min(60, max(1, int(a.get("seconds") or 10)))
        start = wall_clock() * 1000 - 5000
        time.sleep(seconds)
        # A sound is one episode (one event when it starts), so include episodes still going on.
        since = datetime.fromtimestamp((start - 600_000) / 1000, timezone.utc)
        events = [jsonable(e) for e in self.client.events.list(source=src["id"], from_=since)]
        sounds = [
            {
                "sounds": e.get("labels"),
                "confidence": e.get("confidence"),
                "started_at": e["occurred_at"],
                "ongoing": not e.get("ended_at"),
                "summary": e.get("summary"),
            }
            for e in events
            if e["type"].startswith("sound.")
            and (_ms(e["occurred_at"]) >= start or not e.get("ended_at") or _ms(e["ended_at"]) >= start)
        ]
        out: dict[str, Any] = {"source": src["id"], "listened_seconds": seconds, "sounds": sounds}
        if not sounds:
            out["note"] = "No sounds detected (speech is never transcribed)."
        return _text(out)

    def _tool_read_environment(self, a: dict[str, Any]) -> ToolResult:
        sources = self._sources()
        room = str(a["room"]).lower() if a.get("room") else None
        only = str(a["sense"]) if a.get("sense") else None

        def sensing(src: Mapping[str, Any]) -> bool:
            return any(is_sensor_sense(x) and (not only or x == only) for x in src["senses"])

        if a.get("source"):
            picked = [self._resolve(a["source"])]
        else:
            picked = [
                x
                for x in sources
                if sensing(x) and (not room or (x.get("location") or "").lower() == room or room in x["name"].lower())
            ]
        if not picked:
            where = f' in "{a["room"]}"' if room else ""
            what = f"no {sense_name(only) if only else ''} sensor{'' if only else 's'}{where}"
            return _fail("not_found", what.replace("no  ", "no "))
        since = datetime.now(timezone.utc) - timedelta(hours=1)
        out = []
        for src in picked:
            now = jsonable(self.client.sources.now(src["id"]))
            latest = [r for r in now.get("readings") or [] if not only or r["sense"] == only]
            numbers = any(r.get("kind") in ("number", None) for r in latest)
            history = jsonable((self.client.sources.history(src["id"], from_=since)).data) if numbers else []
            readings = []
            for r in latest:
                dev = r.get("device")
                device = {"device": dev.get("name") or dev["id"]} if dev else {}
                if r.get("kind") == "state":
                    readings.append(
                        {"sense": r["sense"], **device, **_pick(r, "state", "value", "since", "measured_at")}
                    )
                    continue
                if r.get("kind") == "event":
                    at = _pick(r, "measured_at")
                    detail = {"detail": r["detail"]} if r.get("detail") else {}
                    readings.append(
                        {
                            "sense": r["sense"],
                            **device,
                            "last": reading_text(r),
                            **detail,
                            **({"at": at["measured_at"]} if at else {}),
                        }
                    )
                    continue
                value = _number(r.get("value"))
                dev_id = dev["id"] if dev else None
                series = [
                    h for h in history if h["sense"] == r["sense"] and (h.get("device") or {}).get("id") == dev_id
                ]
                first: Any = series[0].get("value") if series else None
                delta = value - float(first) if _is_number(first) and value is not None else 0
                # "Steady" is a small change for the unit: 0.3 °C, 2 points of a percentage, else 5 %.
                unit = r.get("unit")
                still = 0.3 if unit == "celsius" else 2 if unit == "percent" else max(abs(value or 0) * 0.05, 0.01)
                trend = "steady" if abs(delta) < still else "rising" if delta > 0 else "falling"
                readings.append(
                    {
                        "sense": r["sense"],
                        **device,
                        "value": value,
                        **_pick(r, "unit"),
                        "text": reading_text(r),
                        **_pick(r, "measured_at"),
                        "trend_last_hour": trend,
                        "change_last_hour": js_round(delta * 10) / 10,
                    }
                )
            # A box that is off (or can't reach Home Assistant) left these values behind: say so, never pass them off as now.
            offline = src.get("status") in ("offline", "reconnecting")
            note = {
                "status": "offline",
                "note": f"Offline since {src.get('status_since') or 'a while'}: these are the last readings, not what is true now.",
            }
            out.append(
                {
                    "source": src["id"],
                    "name": src["name"],
                    **_pick(src, "location"),
                    **(note if offline else {}),
                    "readings": readings,
                }
            )
        return _text({"sources": out})

    def _devices(self) -> list[dict[str, Any]]:
        return [jsonable(d) for d in self.client.devices.list()]

    def _device(self, ref: Any) -> dict[str, Any]:
        """A device by id or (case-insensitive) name, with or without its room."""
        r = str(ref if ref is not None else "").strip().lower()
        devices = self._devices()
        hit = (
            next((d for d in devices if d["id"].lower() == r), None)
            or next((d for d in devices if d["name"].lower() == r), None)
            or next((d for d in devices if f"{d.get('room') or ''} {d['name']}".strip().lower() == r), None)
        )
        if hit is None:
            raise SenseplaneError(404, "not_found", f'no device "{ref}"; call list_devices for the ids')
        return hit

    def _tool_list_devices(self, a: dict[str, Any]) -> ToolResult:
        room = str(a["room"]).lower() if a.get("room") else None
        devices = [d for d in self._devices() if not room or (d.get("room") or "").lower() == room]
        keys = ("id", "name", "room", "type", "tier", "actions", "state", "online", "can_control")
        return _text({"devices": [_pick(d, *keys) for d in devices]})

    def _tool_control_device(self, a: dict[str, Any]) -> ToolResult:
        if a.get("request"):
            return _text(_request(jsonable(self.client.devices.request(str(a["request"])))))
        if not a.get("device") or not a.get("action"):
            return _fail("validation_failed", "give a device and an action, or a request id to check")
        d = self._device(a["device"])
        try:
            c = jsonable(self.client.devices.command(d["id"], str(a["action"]), value=a.get("value")))
        except SenseplaneError as err:
            # Offline boxes, failures and refusals carry the recorded request.
            cmd = (err.details or {}).get("command")
            if isinstance(cmd, Mapping):
                body = {"error": {"code": err.code, "message": err.message}, **_request(cmd)}
                return ToolResult([{"type": "text", "text": json.dumps(body, indent=2, default=str)}], True)
            raise
        note = (
            {
                "note": "A person must confirm this in Senseplane (console, app or Telegram) within 2 minutes; it hasn't happened yet."
            }
            if c.get("status") == "awaiting_confirmation"
            else {}
        )
        return _text({**_request(c), **note})

    def _tool_watch_for(self, a: dict[str, Any]) -> ToolResult:
        ids = [(self._resolve(s))["id"] for s in a.get("sources") or []]
        # An agent's own watches report to its inbox (ADR 0043) unless it asks for the account's webhooks.
        me = None if a.get("notify_me") is False else self._agent_id()
        body: dict[str, Any] = {
            "instruction": str(a.get("condition")),
            "sources": ids,
            "mode": "track" if a.get("mode") == "track" else "alert",
        }
        if a.get("duration_minutes"):
            body["duration_minutes"] = int(a["duration_minutes"])
        if me:
            body["notify"] = [{"type": "agent", "id": me}]
        if a.get("active_hours"):
            body["active_hours"] = a["active_hours"]
        w = jsonable(self.client.watches.create(body))
        note = (
            "Events come to your inbox: what_happened returns new ones first, and clients that accept "
            "notifications are told when they arrive."
            if me
            else "Events go to the account's webhooks; call what_happened to check."
        )
        keys = ("sources", "status", "compiled", "warnings", "estimate")
        return _text(
            {
                "watch_id": w["id"],
                **_pick(w, *keys),
                "expires_at": w.get("expires_at"),
                "active_hours": w.get("active_hours"),
                "notify": w.get("notify") or [],
                "note": note,
            }
        )

    def _tool_what_happened(self, a: dict[str, Any]) -> ToolResult:
        q = str(a.get("question"))
        src = self._resolve(a["source"]) if a.get("source") else None
        # New events from this agent's watches come first, then are marked seen.
        inbox: list[dict[str, Any]] = []
        if self._agent_id():
            page = jsonable(self.client.inbox.list(unseen=True, limit=50))
            items = [i for i in page["data"] if not src or i["event"]["source"]["id"] == src["id"]]
            if items:
                self.client.inbox.mark_seen(ids=[i["id"] for i in items])
            inbox = [{**_inbox_brief(i), **(i["event"].get("media") or {})} for i in items]
        r = jsonable(self.client.memory.search(q, limit=10, from_=a.get("from"), to=a.get("to")))
        hits = [h for h in r["data"] if not src or h["event"]["source"]["id"] == src["id"]]
        out: dict[str, Any] = {"question": q}
        if inbox:
            out["new_from_your_watches"] = inbox
        out["events"] = [{**_brief(h["event"]), "score": js_round(h["score"] * 1000) / 1000} for h in hits]
        return _text(out)

    def _tool_measure(self, a: dict[str, Any]) -> ToolResult:
        # The API does the arithmetic (ADR 0057); source names are resolved there, within this caller's grants.
        return _text(jsonable(self.client.activity.query(a)))

    def _tool_check_history(self, a: dict[str, Any]) -> ToolResult:
        ids = [(self._resolve(s))["id"] for s in a.get("sources") or []]
        body: dict[str, Any] = {k: str(a[k]) for k in ("instruction", "watch_id", "from", "to") if a.get(k)}
        if ids:
            body["sources"] = ids
        if a.get("max_checks") is not None:
            body["max_checks"] = int(a["max_checks"])
        r = jsonable(self.client.activity.check(body))
        return _text(_pick(r, "matches", "checks_used", "candidates", "unchecked", "stored"))

    def _tool_replay(self, a: dict[str, Any]) -> ToolResult:
        src = self._resolve(a.get("source"))
        start, end = str(a.get("from")), str(a.get("to"))
        p = jsonable(self.client.sources.playback(src["id"], from_=start, to=end))
        out = {"source": src["id"], "url": p["url"], **_pick(p, "expires_at"), "gaps": p.get("gaps") or []}
        if a.get("save"):
            clip = self.client.clips.create({"source": src["id"], "from": start, "to": end})
            out["clip_id"] = clip.id
        return _text(out)

    def _until(self, get: Any, done: Any, seconds: float) -> dict[str, Any]:
        """Polls `get` until `done` holds or `seconds` pass (0.5 s at first, then up to every 3 s)."""
        end = monotonic() + seconds
        wait = 0.5
        while True:
            v = jsonable(get())
            if done(v) or monotonic() + wait > end:
                return dict(v)
            time.sleep(wait)
            wait = min(3.0, wait * 2)

    def _tool_make_story(self, a: dict[str, Any]) -> ToolResult:
        moments: list[dict[str, Any]] = []
        for m in a.get("moments") or []:
            if m.get("event"):
                moments.append({"event": str(m["event"])})
            else:
                src = self._resolve(m.get("source"))
                moments.append({"source": src["id"], "from": str(m.get("from")), "to": str(m.get("to"))})
        body: dict[str, Any] = {}
        if moments:
            body["moments"] = moments
        if a.get("search"):
            search: dict[str, Any] = {"q": str(a["search"]), **{k: str(a[k]) for k in ("from", "to") if a.get(k)}}
            ids = [(self._resolve(s))["id"] for s in a.get("sources") or []]
            if ids:
                search["sources"] = ids
            body["search"] = search
        if a.get("title"):
            body["title"] = str(a["title"])
        if a.get("fast"):
            body["mode"] = "fast"
        created = self.client.stories.create(body)
        s = self._until(lambda: self.client.stories.get(created.id), lambda v: v["status"] in ("ready", "failed"), 120)
        out: dict[str, Any] = {"story_id": s["id"], "status": s["status"], **_pick(s, "error")}
        out["pieces"] = [
            {
                "source": p["source_name"],
                "from": p["from"],
                "to": p["to"],
                **({"note": "nothing recorded"} if p.get("recorded_ms") == 0 else {}),
            }
            for p in s["pieces"]
        ]
        if s.get("playback_url"):
            out.update(
                {
                    "url": s["playback_url"],
                    "expires_at": s.get("playback_expires_at"),
                    **_pick(s, "duration_ms", "captions_url"),
                }
            )
            if s.get("parts"):
                out["downloads"] = [x["download_url"] for x in s["parts"] if x.get("download_url")]
            if s.get("note"):
                out["note"] = s["note"]
        elif s["status"] not in ("ready", "failed"):
            out["note"] = "still rendering: get it later by its story id (GET /v1/stories/{id})"
        return _text(out)

    def _tool_follow_object(self, a: dict[str, Any]) -> ToolResult:
        ids = [(self._resolve(s))["id"] for s in a.get("sources") or []]
        reference: dict[str, Any] = {}
        if a.get("event"):
            reference["event"] = str(a["event"])
        if a.get("box"):
            reference["box"] = [float(v) for v in a["box"]]
        if a.get("description"):
            reference["description"] = str(a["description"])
        body: dict[str, Any] = {
            "reference": reference,
            "from": str(a.get("from")),
            "to": str(a.get("to")),
            "make_story": a.get("make_story") is not False,
        }
        if ids:
            body["sources"] = ids
        created = self.client.follows.create(body)
        f = self._until(
            lambda: self.client.follows.get(created.id), lambda v: v["status"] in ("done", "failed", "refused"), 150
        )
        out: dict[str, Any] = {"follow_id": f["id"], "status": f["status"], **_pick(f, "error")}
        r = f.get("result")
        if r:
            out["route"] = [
                {
                    "source": v["source_name"],
                    "from": v["from"],
                    "to": v["to"],
                    "confidence": v["confidence"],
                    **({"url": v["playback_url"]} if v.get("playback_url") else {}),
                }
                for v in r.get("route") or []
            ]
            out.update(
                {
                    "handovers": r.get("handovers") or [],
                    "gaps": r.get("gaps") or [],
                    "frames_examined": f["frames_examined"],
                    "model_calls": f["model_calls"],
                }
            )
        if f.get("story_id"):
            out["story_id"] = f["story_id"]
        return _text(out)

    def _tool_stop_watching(self, a: dict[str, Any]) -> ToolResult:
        self.client.watches.delete(str(a.get("watch_id")))
        return _text({"stopped": str(a.get("watch_id"))})
