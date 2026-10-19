# Copyright 2026 The Senseplane Authors
# SPDX-License-Identifier: Apache-2.0
"""Ask (ADR 0041): answers a question about the sources with a small
tool-using loop over the OpenAI-compatible client.

Tools: search history, list events and view an event's snapshot (served by
the API, which applies the caller's grants; the vision model answers about the
snapshot), look at a camera now (the latest masked frame to the vision model),
list sources, and propose a watch. Everything the model may cite
comes from a tool result and carries a ref (m1, m2, …); the answer cites refs
as [m1], which are rewritten to [1], [2], … in the order they are first cited,
and each cited ref becomes a moment. Refs the model made up are dropped, so
an answer can only point at things that happened.

Pure and synchronous: the Valkey worker supplies the model, tools and emit,
and tests drive it with a scripted model."""

import json
import logging
import re
from collections.abc import Callable, Iterable, Iterator
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Protocol
from zoneinfo import ZoneInfo

from . import labels

log = logging.getLogger("senseplane.brain.chat")

MAX_STEPS = 6  # model calls per answer (each is one AI check)
HOLD_CHARS = 160  # text held back until we know it isn't a preamble to a tool call

# One streamed model turn: ("delta", text) items, then ("tool_call", {id, name, arguments}) items.
Complete = Callable[[list[dict], list[dict] | None], Iterable[tuple[str, Any]]]
Emit = Callable[[dict], None]


class Tools(Protocol):
    def search_history(self, args: dict) -> dict: ...
    def list_events(self, args: dict) -> dict: ...
    def look(self, source_id: str, question: str) -> dict: ...
    def view_event(self, event_id: str, question: str) -> dict: ...


def _fn(name: str, description: str, properties: dict, required: list[str] | None = None) -> dict:
    return {"type": "function", "function": {"name": name, "description": description,
                                             "parameters": {"type": "object", "properties": properties, "required": required or []}}}


_SOURCES = {"type": "array", "items": {"type": "string"}, "description": "Source names or ids; omit for the default sources"}
_TIME = {"type": "string", "description": "RFC 3339 time"}
TOOL_SPECS = [
    _fn("search_history", "Search what the sources saw and heard (events) by meaning. Use for 'when did…', 'did anyone…', 'what happened…'.",
        {"query": {"type": "string", "description": "What to look for, in plain words"}, "sources": _SOURCES, "from": _TIME, "to": _TIME,
         "limit": {"type": "integer"}}, ["query"]),
    _fn("list_events", "List recent events newest first, optionally of one type: watch.triggered, sound.detected, or detection.<label> where label is "
        "person, vehicle, animal or an everyday object (" + ", ".join(labels.OBJECTS) + "; e.g. a mug is detection.cup, a sofa detection.couch).",
        {"sources": _SOURCES, "type": {"type": "string"}, "from": _TIME, "to": _TIME, "limit": {"type": "integer"}}),
    _fn("view_event", "Look at the snapshot saved with a past event and answer a question about it (what someone wore or held, what a vehicle "
        "looked like). Use it when the user asks for details the event's summary doesn't give.",
        {"ref": {"type": "string", "description": "The event's ref from search_history or list_events, e.g. m3"}, "question": {"type": "string"}},
        ["ref", "question"]),
    _fn("look", "Look at one camera right now and answer a question about the current view.",
        {"source": {"type": "string", "description": "Source name or id"}, "question": {"type": "string"}}, ["source", "question"]),
    _fn("list_sources", "List the sources you may use: name, id, location, status and senses.", {}),
    _fn("propose_watch", "Suggest a watch when the user wants to know about something in the future (e.g. 'tell me if…', 'is the door left open at night?'). The user decides whether to turn it on.",
        {"instruction": {"type": "string", "description": "One plain-language sentence, e.g. 'Tell me if a package is left at the front door'"}, "sources": _SOURCES},
        ["instruction"]),
]


@dataclass
class Ref:
    kind: str  # event | look
    source_id: str
    at: str
    label: str
    event_id: str | None = None
    snapshot_jpeg_b64: str | None = None


@dataclass
class Session:
    req: dict
    complete: Complete | None
    tools: Tools
    emit: Emit
    refs: dict[str, Ref] = field(default_factory=dict)
    cited: list[str] = field(default_factory=list)
    suggested: bool = False

    def __post_init__(self):
        self.sources: list[dict] = list(self.req.get("sources") or [])
        self.by_id = {s["id"]: s for s in self.sources}
        try:
            self.tz = ZoneInfo(self.req.get("time_zone") or "UTC")
        except Exception:  # noqa: BLE001 - unknown zone: fall back to UTC
            self.tz = ZoneInfo("UTC")
        self.scope = mentioned(self.req.get("question", ""), self.sources) or [s["id"] for s in self.sources]
        self.writer = Citations(self._cite)
        self.content = ""

    # --- output -----------------------------------------------------------------------------
    def _cite(self, ref: str) -> int | None:
        r = self.refs.get(ref)
        if r is None:
            return None  # the model made it up: drop it
        if ref not in self.cited:
            self.cited.append(ref)
            m = {"kind": r.kind, "source_id": r.source_id, "at": r.at, "label": r.label}
            if r.event_id:
                m["event_id"] = r.event_id
            if r.snapshot_jpeg_b64:
                m["snapshot_jpeg_b64"] = r.snapshot_jpeg_b64
            self.emit({"type": "moment", "moment": m})
        return self.cited.index(ref) + 1

    def write(self, text: str):
        out = self.writer.feed(text)
        if out:
            self.content += out
            self.emit({"type": "delta", "text": out})

    def finish(self):
        out = self.writer.flush()
        if out:
            self.content += out
            self.emit({"type": "delta", "text": out})
        self.emit({"type": "done", "content": self.content.strip()})

    def status(self, text: str):
        self.emit({"type": "status", "text": text})

    # --- helpers ----------------------------------------------------------------------------
    def local(self, iso: str) -> str:
        try:
            t = datetime.fromisoformat(iso.replace("Z", "+00:00")).astimezone(self.tz)
            return t.strftime("%a %d %b %H:%M:%S")
        except ValueError:
            return iso

    def resolve(self, names: Iterable[str] | None) -> list[str]:
        """Source names or ids to ids the caller may use; unknown names are ignored."""
        out = []
        for n in names or []:
            n = str(n).strip()
            hit = self.by_id.get(n) or next((s for s in self.sources if s["name"].lower() == n.lower()), None) \
                or next((s for s in self.sources if n.lower() in (s["name"].lower(), (s.get("location") or "").lower())), None)
            if hit and hit["id"] not in out:
                out.append(hit["id"])
        return out

    def names(self, ids: list[str]) -> str:
        names = [self.by_id[i]["name"] for i in ids if i in self.by_id]
        return ", ".join(names[:3]) + (f" and {len(names) - 3} more" if len(names) > 3 else "")

    def add_ref(self, r: Ref) -> str:
        key = f"m{len(self.refs) + 1}"
        self.refs[key] = r
        return key

    # --- tools --------------------------------------------------------------------------------
    def run_tool(self, name: str, args: dict) -> dict:
        if name in ("search_history", "list_events"):
            ids = self.resolve(args.get("sources")) or self.scope
            self.status(f"Searching {self.names(ids)}…" if name == "search_history" else f"Checking recent events on {self.names(ids)}…")
            call = {k: v for k, v in args.items() if k in ("query", "from", "to", "type", "limit")}
            out = getattr(self.tools, name)({**call, "sources": ids})
            if out.get("error"):
                return {"error": out["error"]}
            results = []
            for e in out.get("results", []):
                ref = self.add_ref(Ref("event", e["source_id"], e["at"], e["summary"], event_id=e["event_id"]))
                results.append({"ref": ref, "time": self.local(e["at"]), "source": e.get("source_name") or e["source_id"],
                                "type": e.get("type"), "what": e["summary"],
                                **{k: e[k] for k in ("confidence", "match") if e.get(k) is not None}})
            return {"results": results} if results else {"results": [], "note": "Nothing found."}
        if name == "view_event":
            r = self.refs.get(str(args.get("ref", "")).strip())
            if r is None or r.kind != "event" or not r.event_id:
                return {"error": "unknown ref: pass the ref of an event from search_history or list_events"}
            self.status(f"Looking at the {self.local(r.at)} snapshot…")
            out = self.tools.view_event(r.event_id, str(args.get("question") or self.req.get("question", "")))
            if out.get("error"):
                return {"error": out["error"]}
            ref = self.add_ref(Ref("event", r.source_id, r.at, out.get("answer") or r.label, event_id=r.event_id))
            return {"ref": ref, "time": self.local(r.at), "saw": out.get("answer", "")}
        if name == "look":
            ids = self.resolve([args.get("source", "")])
            src = self.by_id.get(ids[0]) if ids else None
            if not src:
                return {"error": "unknown source"}
            if not src.get("can_look"):
                return {"error": f"{src['name']} can't be viewed (no camera, or no video grant)"}
            self.status(f"Looking at {src['name']}…")
            out = self.tools.look(src["id"], str(args.get("question") or self.req.get("question", "")))
            if out.get("error"):
                return {"error": out["error"]}
            ref = self.add_ref(Ref("look", src["id"], out["at"], out.get("answer") or "Live look", snapshot_jpeg_b64=out.get("jpeg_b64")))
            return {"ref": ref, "source": src["name"], "time": self.local(out["at"]), "saw": out.get("answer", "")}
        if name == "list_sources":
            return {"sources": [{"id": s["id"], "name": s["name"], "location": s.get("location"), "type": s.get("type"),
                                 "status": s.get("status"), "senses": s.get("senses", []), "can_look": bool(s.get("can_look"))} for s in self.sources]}
        if name == "propose_watch":
            instruction = str(args.get("instruction") or "").strip()
            ids = self.resolve(args.get("sources")) or self.scope
            if len(instruction) < 3 or not ids:
                return {"error": "need an instruction and at least one source"}
            if not self.suggested:
                self.suggested = True
                self.emit({"type": "suggested_watch", "instruction": instruction[:500], "sources": ids})
            return {"ok": True, "note": "Shown to the user as a suggestion; nothing is watching until they turn it on."}
        return {"error": f"unknown tool {name}"}

    # --- the loop -----------------------------------------------------------------------------
    def system(self) -> str:
        now = self.local(self.req.get("now") or datetime.now(self.tz).isoformat())
        lines = [f"- {s['name']} (id {s['id']}{', ' + s['location'] if s.get('location') else ''}; {s.get('status') or 'unknown'}"
                 f"{'; can look now' if s.get('can_look') else ''})" for s in self.sources]
        span = (f"History you can search covers {self.local(self.req['from'])} to {self.local(self.req['to'])}. "
                if self.req.get("from") and self.req.get("to") else "")
        return (
            "You answer questions about what a person's cameras and sensors saw and heard. "
            f"It is now {now} ({self.tz.key}); give times in that zone. {span}"
            "\nSources you may use:\n" + ("\n".join(lines) or "(none)") +
            f"\nUnless the user names sources, use: {self.names(self.scope) or 'none'}.\n"
            "Rules:\n"
            "- Use the tools before answering: search_history or list_events for the past, look for right now. Call tools before writing anything.\n"
            "- Event summaries are short labels. For details they don't give (what someone wore or held, a vehicle's colour), call view_event on the event.\n"
            "- confidence is how sure the detector was (0 to 1); match is only how close an event is to your search words. Never call match a confidence.\n"
            "- Every result has a ref like m1. Cite each thing you mention as [m1] right after it. Never mention an event without its ref.\n"
            "- Only state what the tool results say. Never invent events, times or people. If nothing relevant was found, say so plainly.\n"
            "- Mention only results that answer the question; leave out unrelated ones (a vehicle when asked about people).\n"
            "- Never identify people by name or guess who someone is.\n"
            "- If the user wants to know about something in future (an ongoing need), call propose_watch once.\n"
            "- Be brief: a sentence or two, or a short list."
        )

    def run(self):
        if self.complete is None:
            return self.fallback()
        messages: list[dict] = [{"role": "system", "content": self.system()}]
        for h in (self.req.get("history") or [])[-12:]:
            messages.append({"role": h["role"], "content": str(h["content"])[:4000]})
        messages.append({"role": "user", "content": self.req["question"]})
        for step in range(MAX_STEPS):
            last = step == MAX_STEPS - 1
            held, text, released, calls = "", "", False, []
            for kind, value in self.complete(messages, None if last else TOOL_SPECS):
                if kind == "delta":
                    text += value
                    if released:
                        self.write(value)
                    else:
                        held += value
                        if len(held) >= HOLD_CHARS:
                            released = True
                            self.write(held)
                elif kind == "tool_call":
                    calls.append(value)
            if not calls:
                if not released:
                    self.write(held)
                return self.finish()
            # A short preamble before a tool call ("Let me check…") is not part of the answer.
            assistant: dict = {"role": "assistant", "content": text if released else None, "tool_calls": [
                {"id": c["id"], "type": "function", "function": {"name": c["name"], "arguments": c.get("arguments") or "{}"}} for c in calls]}
            messages.append(assistant)
            for c in calls:
                try:
                    args = json.loads(c.get("arguments") or "{}")
                    if not isinstance(args, dict):
                        args = {}
                except json.JSONDecodeError:
                    args = {}
                try:
                    result = self.run_tool(c["name"], args)
                except Exception as err:  # noqa: BLE001 - reported to the model, which can try something else
                    log.warning("chat tool %s failed: %s", c["name"], err)
                    result = {"error": "the tool failed"}
                messages.append({"role": "tool", "tool_call_id": c["id"], "content": json.dumps(result)})
        return self.finish()

    def fallback(self):
        """No model on this instance: show the closest moments from history, plainly."""
        out = self.run_tool("search_history", {"query": self.req["question"], "limit": 5})
        hits = [r for r in out.get("results", []) if r.get("match", 1) >= 0.3]
        if not hits:
            self.write("I couldn't find anything matching that in the history I can see.")
        else:
            self.write("No model is set up here, so I can't write a full answer, but these moments look related:\n")
            for r in hits:
                self.write(f"- {r['time']}, {r['source']}: {r['what']} [{r['ref']}]\n")
        return self.finish()


def mentioned(question: str, sources: list[dict]) -> list[str]:
    """Sources named in the question (by name or location), longest names first."""
    q = question.lower()
    out = []
    for s in sorted(sources, key=lambda s: -len(s["name"])):
        for n in (s["name"], s.get("location") or ""):
            n = n.strip().lower()
            if len(n) >= 3 and re.search(rf"(?<![\w]){re.escape(n)}(?![\w])", q) and s["id"] not in out:
                out.append(s["id"])
    return out


class Citations:
    """Rewrites [m3] refs in streamed text to [1], [2], … as they arrive; unknown refs vanish."""

    TOKEN = re.compile(r"\[\s*(m\d+(?:\s*[,;]\s*m\d+)*)\s*\]", re.I)

    def __init__(self, cite: Callable[[str], int | None]):
        self.cite = cite
        self.buf = ""

    def _replace(self, token: str) -> str:
        m = self.TOKEN.fullmatch(token)
        if not m:
            return token
        nums = [self.cite(r.strip().lower()) for r in re.split(r"[,;]", m.group(1))]
        return "".join(f"[{n}]" for n in nums if n is not None)

    def feed(self, text: str) -> str:
        self.buf += text
        out = ""
        while self.buf:
            i = self.buf.find("[")
            if i < 0:
                out, self.buf = out + self.buf, ""
                break
            out, self.buf = out + self.buf[:i], self.buf[i:]
            j = self.buf.find("]")
            if j < 0:
                if len(self.buf) > 40:  # not a ref
                    out, self.buf = out + self.buf[0], self.buf[1:]
                    continue
                break
            rep = self._replace(self.buf[:j + 1])
            if not rep and out.endswith(" ") and self.buf[j + 1:j + 2] in (" ", ""):
                out = out[:-1]  # a dropped ref leaves no double space
            out, self.buf = out + rep, self.buf[j + 1:]
        return out

    def flush(self) -> str:
        out, self.buf = self.buf, ""
        return out


def answer(req: dict, complete: Complete | None, tools: Tools, emit: Emit) -> str:
    """Runs one answer to the end; emits status/delta/moment/suggested_watch, then done. Returns the content."""
    s = Session(req, complete, tools, emit)
    s.run()
    return s.content


def stream_turn(chunks: Iterator) -> Iterator[tuple[str, Any]]:
    """OpenAI streaming chunks → ("delta", text) items, then the assembled ("tool_call", {...}) items."""
    calls: dict[int, dict] = {}
    for chunk in chunks:
        if not getattr(chunk, "choices", None):
            continue
        delta = chunk.choices[0].delta
        if getattr(delta, "content", None):
            yield "delta", delta.content
        for tc in getattr(delta, "tool_calls", None) or []:
            c = calls.setdefault(tc.index, {"id": "", "name": "", "arguments": ""})
            if tc.id:
                c["id"] = tc.id
            if tc.function is not None:
                c["name"] += tc.function.name or ""
                c["arguments"] += tc.function.arguments or ""
    for i in sorted(calls):
        c = calls[i]
        yield "tool_call", {**c, "id": c["id"] or f"call_{i}"}
