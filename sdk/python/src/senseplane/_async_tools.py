# Copyright 2026 The Senseplane Authors
# SPDX-License-Identifier: Apache-2.0

# The MCP server's tools (spec/mcp/tools.json, mcp/src/handlers.ts) for agents
# that call the API directly. Same names, schemas and results, so a prompt
# written for the MCP server works here. scripts/codegen.py writes the sync
# version (_sync_tools.py) from this file.
from __future__ import annotations

import asyncio
import base64
import json
from collections.abc import Mapping
from datetime import datetime, timedelta, timezone
from time import monotonic
from time import time as wall_clock
from typing import Any

from ._async_client import AsyncSenseplane
from ._base import jsonable
from ._errors import SenseplaneError
from ._tool_defs import ToolResult, anthropic_tools, openai_tools, tool_names

__all__ = ["AsyncToolkit"]

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


def _brief(e: Mapping[str, Any]) -> dict[str, Any]:
    keys = ("id", "type", "source", "occurred_at", "summary", "confidence")
    return {**{k: e.get(k) for k in keys}, **(e.get("media") or {})}


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


class AsyncToolkit:
    """Senseplane's agent tools bound to a client: schemas for your model, and a dispatcher.

        toolkit = AsyncToolkit(client)
        tools = toolkit.anthropic()          # or toolkit.openai()
        result = await toolkit.call("look", {"source": "Front door"})

    `call` never raises for API errors: like the MCP server, it returns a result with
    `is_error` set and `{"error": {"code", "message"}}` as text, for the model to read.
    """

    def __init__(self, client: AsyncSenseplane, *, tools: list[str] | None = None) -> None:
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

    async def call(self, name: str, arguments: _Args | str | None = None) -> ToolResult:
        """Runs one tool. `arguments` may be a dict or the JSON string a model produced."""
        handler = getattr(self, f"_tool_{name}", None) if name in self.names else None
        if handler is None:
            return _fail("not_found", f"unknown tool {name}")
        try:
            args = json.loads(arguments) if isinstance(arguments, str) else dict(arguments or {})
            result: ToolResult = await handler(args)
            return result
        except SenseplaneError as err:
            return _fail(err.code, err.message)
        except Exception as err:  # a tool result, not a crash, so the model can recover
            return _fail("internal", str(err))

    async def call_anthropic(self, block: Any) -> dict[str, Any]:
        """Runs a `tool_use` content block (an SDK object or a dict); returns the `tool_result` block."""
        result = await self.call(str(_field(block, "name")), _field(block, "input"))
        return result.anthropic(str(_field(block, "id")))

    async def call_openai(self, tool_call: Any) -> dict[str, Any]:
        """Runs a Chat Completions tool call (object or dict); returns the `role: tool` message."""
        fn = _field(tool_call, "function")
        result = await self.call(str(_field(fn, "name")), _field(fn, "arguments"))
        return {"role": "tool", "tool_call_id": _field(tool_call, "id"), "content": result.text()}

    # Helpers ------------------------------------------------------------------

    async def _sources(self) -> list[dict[str, Any]]:
        if self._cache is None or monotonic() - self._cache[0] > 10:
            sources = [jsonable(s) async for s in self.client.sources.list()]
            self._cache = (monotonic(), sources)
        return self._cache[1]

    async def _resolve(self, ref: Any) -> dict[str, Any]:
        """An id or a (case-insensitive) name, so agents can say "front door"."""
        r = str(ref if ref is not None else "").strip()
        sources = await self._sources()
        hit = next((s for s in sources if s["id"] == r), None) or next(
            (s for s in sources if s["name"].lower() == r.lower()), None
        )
        if hit is None:
            raise SenseplaneError(404, "not_found", f'no source "{r}"; call list_senses for the ids')
        return hit

    async def _agent_id(self) -> str | None:
        """This caller's agent id (agent keys have an inbox; account keys don't)."""
        if not self._agent_known:
            try:
                self._agent = (await self.client.inbox.list(limit=1)).agent_id
                self._agent_known = True
            except SenseplaneError as err:
                if 0 < err.status < 500:  # a transient failure: ask again next time
                    self._agent, self._agent_known = None, True
        return self._agent

    async def _image(self, url: str) -> dict[str, Any] | None:
        response = await self.client._transport.http.get(url, timeout=self.client._transport.timeout)
        if response.status_code >= 400:
            return None
        mime = (response.headers.get("content-type") or "").split(";")[0] or "image/jpeg"
        return {"type": "image", "data": base64.b64encode(response.content).decode(), "mime_type": mime}

    # The tools ----------------------------------------------------------------

    async def _tool_list_senses(self, a: dict[str, Any]) -> ToolResult:
        keys = ("id", "name", "location", "type", "senses", "status")
        return _text({"sources": [{k: s.get(k) for k in keys} for s in await self._sources()]})

    async def _tool_look(self, a: dict[str, Any]) -> ToolResult:
        src = await self._resolve(a.get("source"))
        if "video" not in src["senses"]:
            return _fail("forbidden_sense", f"{src['name']} has no video")
        if a.get("question"):
            r = await self.client.sources.ask(src["id"], question=str(a["question"]))
            img = await self._image(r.snapshot_url)
            info = {"source": src["id"], "answer": r.answer, "confidence": r.confidence, "snapshot_url": r.snapshot_url}
            return ToolResult([*([img] if img else []), *_text(info).content])
        now = await self.client.sources.now(src["id"])
        if not now.snapshot_url:
            return _fail("not_found", f"{src['name']} has no picture yet")
        img = await self._image(now.snapshot_url)
        if img is None:
            return _fail("not_found", f"{src['name']} isn't streaming right now (no live frame)")
        info = {"source": src["id"], "captured_at": jsonable(now.captured_at), "snapshot_url": now.snapshot_url}
        return ToolResult([img, *_text(info).content])

    async def _tool_listen(self, a: dict[str, Any]) -> ToolResult:
        src = await self._resolve(a.get("source"))
        if "audio" not in src["senses"]:
            return _fail("forbidden_sense", f"{src['name']} has no audio (or it isn't granted)")
        seconds = min(60, max(1, int(a.get("seconds") or 10)))
        start = wall_clock() * 1000 - 5000
        await asyncio.sleep(seconds)
        # A sound is one episode (one event when it starts), so include episodes still going on.
        since = datetime.fromtimestamp((start - 600_000) / 1000, timezone.utc)
        events = [jsonable(e) async for e in self.client.events.list(source=src["id"], from_=since)]
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

    async def _tool_read_environment(self, a: dict[str, Any]) -> ToolResult:
        sources = await self._sources()
        room = str(a["room"]).lower() if a.get("room") else None
        if a.get("source"):
            picked = [await self._resolve(a["source"])]
        else:
            picked = [
                s
                for s in sources
                if ("temperature" in s["senses"] or "humidity" in s["senses"])
                and (not room or (s.get("location") or "").lower() == room or room in s["name"].lower())
            ]
        if not picked:
            return _fail("not_found", f'no climate sensor in "{a["room"]}"' if room else "no climate sensors")
        since = datetime.now(timezone.utc) - timedelta(hours=1)
        out = []
        for s in picked:
            now = jsonable(await self.client.sources.now(s["id"]))
            history = jsonable((await self.client.sources.history(s["id"], from_=since)).data)
            readings = []
            for r in now.get("readings") or []:
                series = [h for h in history if h["sense"] == r["sense"]]
                delta = r["value"] - series[0]["value"] if series else 0
                steady = abs(delta) < (2 if r["sense"] == "humidity" else 0.3)
                readings.append(
                    {
                        "sense": r["sense"],
                        "value": r["value"],
                        "unit": r.get("unit"),
                        "measured_at": r.get("measured_at"),
                        "trend_last_hour": "steady" if steady else "rising" if delta > 0 else "falling",
                        "change_last_hour": round(delta * 10) / 10,
                    }
                )
            out.append({"source": s["id"], "name": s["name"], "location": s.get("location"), "readings": readings})
        return _text({"sources": out})

    async def _tool_watch_for(self, a: dict[str, Any]) -> ToolResult:
        ids = [(await self._resolve(s))["id"] for s in a.get("sources") or []]
        # An agent's own watches report to its inbox (ADR 0043) unless it asks for the account's webhooks.
        me = None if a.get("notify_me") is False else await self._agent_id()
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
        w = jsonable(await self.client.watches.create(body))
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
                **{k: w.get(k) for k in keys},
                "expires_at": w.get("expires_at"),
                "active_hours": w.get("active_hours"),
                "notify": w.get("notify") or [],
                "note": note,
            }
        )

    async def _tool_what_happened(self, a: dict[str, Any]) -> ToolResult:
        q = str(a.get("question"))
        src = await self._resolve(a["source"]) if a.get("source") else None
        # New events from this agent's watches come first, then are marked seen.
        inbox: list[dict[str, Any]] = []
        if await self._agent_id():
            page = jsonable(await self.client.inbox.list(unseen=True, limit=50))
            items = [i for i in page["data"] if not src or i["event"]["source"]["id"] == src["id"]]
            if items:
                await self.client.inbox.mark_seen(ids=[i["id"] for i in items])
            inbox = [{**_inbox_brief(i), **(i["event"].get("media") or {})} for i in items]
        r = jsonable(await self.client.memory.search(q, limit=10, from_=a.get("from"), to=a.get("to")))
        hits = [h for h in r["data"] if not src or h["event"]["source"]["id"] == src["id"]]
        out: dict[str, Any] = {"question": q}
        if inbox:
            out["new_from_your_watches"] = inbox
        out["events"] = [{**_brief(h["event"]), "score": round(h["score"] * 1000) / 1000} for h in hits]
        return _text(out)

    async def _tool_measure(self, a: dict[str, Any]) -> ToolResult:
        # The API does the arithmetic (ADR 0057); source names are resolved there, within this caller's grants.
        return _text(jsonable(await self.client.activity.query(a)))

    async def _tool_check_history(self, a: dict[str, Any]) -> ToolResult:
        ids = [(await self._resolve(s))["id"] for s in a.get("sources") or []]
        body: dict[str, Any] = {k: str(a[k]) for k in ("instruction", "watch_id", "from", "to") if a.get(k)}
        if ids:
            body["sources"] = ids
        if a.get("max_checks") is not None:
            body["max_checks"] = int(a["max_checks"])
        r = jsonable(await self.client.activity.check(body))
        return _text({k: r.get(k) for k in ("matches", "checks_used", "candidates", "unchecked", "stored")})

    async def _tool_replay(self, a: dict[str, Any]) -> ToolResult:
        src = await self._resolve(a.get("source"))
        start, end = str(a.get("from")), str(a.get("to"))
        p = jsonable(await self.client.sources.playback(src["id"], from_=start, to=end))
        out = {"source": src["id"], "url": p["url"], "expires_at": p.get("expires_at"), "gaps": p.get("gaps") or []}
        if a.get("save"):
            clip = await self.client.clips.create({"source": src["id"], "from": start, "to": end})
            out["clip_id"] = clip.id
        return _text(out)

    async def _tool_stop_watching(self, a: dict[str, Any]) -> ToolResult:
        await self.client.watches.delete(str(a.get("watch_id")))
        return _text({"stopped": str(a.get("watch_id"))})
