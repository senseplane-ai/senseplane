# Copyright 2026 The Senseplane Authors
# SPDX-License-Identifier: Apache-2.0
"""Ask (ADR 0041): the tool loop, driven by a scripted model."""

import json
from types import SimpleNamespace as NS

from senseplane_brain.chat import Citations, answer, mentioned, stream_turn

SOURCES = [
    {"id": "src_door", "name": "Front door", "location": "Porch", "type": "browser", "status": "online", "senses": ["video"], "can_look": True},
    {"id": "src_rec", "name": "Reception", "location": None, "type": "whip", "status": "offline", "senses": ["video"], "can_look": False},
]
REQ = {"account_id": "acc", "inbox": "_INBOX.x", "question": "When did someone come to the door?", "sources": SOURCES,
       "history": [], "from": "2026-10-09T00:00:00Z", "to": "2026-10-16T12:00:00Z", "now": "2026-10-16T12:00:00Z", "time_zone": "Europe/London"}
HIT = {"event_id": "evt_1", "source_id": "src_door", "source_name": "Front door", "at": "2026-10-16T10:02:00Z",
       "type": "detection.person", "summary": "A person walked up to the front door.", "confidence": 0.82, "match": 0.71}


class FakeTools:
    def __init__(self, results=None):
        self.calls: list[tuple[str, dict]] = []
        self.results = [HIT] if results is None else results

    def search_history(self, args):
        self.calls.append(("search_history", args))
        return {"results": self.results}

    def list_events(self, args):
        self.calls.append(("list_events", args))
        return {"results": self.results}

    def look(self, source_id, question):
        self.calls.append(("look", {"source_id": source_id, "question": question}))
        return {"answer": "A parcel is on the doormat.", "at": "2026-10-16T11:59:58Z", "jpeg_b64": "AAAA"}

    def view_event(self, event_id, question):
        self.calls.append(("view_event", {"event_id": event_id, "question": question}))
        return {"answer": "A person in a red coat holding a black phone."}


def scripted(*turns):
    """A model that plays one turn per call: a list of ("delta", text) / ("tool", name, args)."""
    seen: list[dict] = []
    it = iter(turns)

    def complete(messages, tools):
        seen.append({"messages": json.loads(json.dumps(messages)), "tools": tools})
        for i, step in enumerate(next(it)):
            if step[0] == "delta":
                yield "delta", step[1]
            else:
                yield "tool_call", {"id": f"c{len(seen)}_{i}", "name": step[1], "arguments": json.dumps(step[2])}

    complete.seen = seen
    return complete


def run(req, model, tools):
    events: list[dict] = []
    content = answer(req, model, tools, events.append)
    return content, events


def test_searches_then_cites_a_moment_with_refs_rewritten():
    model = scripted(
        [("delta", "Let me check."), ("tool", "search_history", {"query": "person at the door"})],
        [("delta", "Someone came to the front door at 11:02 [m"), ("delta", "1]. Nothing else [m7] turned up.")],
    )
    tools = FakeTools()
    content, events = run(REQ, model, tools)
    assert content == "Someone came to the front door at 11:02 [1]. Nothing else turned up."
    types = [e["type"] for e in events]
    assert types[0] == "status" and events[0]["text"] == "Searching Front door, Reception…"  # no source named: all of them
    assert tools.calls[0] == ("search_history", {"query": "person at the door", "sources": ["src_door", "src_rec"]})
    moments = [e["moment"] for e in events if e["type"] == "moment"]
    assert moments == [{"kind": "event", "source_id": "src_door", "at": HIT["at"], "label": HIT["summary"], "event_id": "evt_1"}]
    assert types.index("moment") < max(i for i, t in enumerate(types) if t == "delta")  # the moment arrives before its [1]
    assert types[-1] == "done" and events[-1]["content"] == content
    assert "Let me check." not in "".join(e["text"] for e in events if e["type"] == "delta")  # a preamble is not the answer
    # The tool result went back to the model with a ref and local time (BST, UTC+1).
    tool_msg = model.seen[1]["messages"][-1]
    assert tool_msg["role"] == "tool" and json.loads(tool_msg["content"])["results"][0]["ref"] == "m1"
    assert "11:02:00" in tool_msg["content"]


def test_nothing_found_says_so_and_cites_nothing():
    model = scripted([("tool", "search_history", {"query": "fox"})], [("delta", "I couldn't find a fox in the last week.")])
    content, events = run({**REQ, "question": "Did a fox come by?"}, model, FakeTools(results=[]))
    assert content == "I couldn't find a fox in the last week."
    assert not [e for e in events if e["type"] == "moment"]


def test_look_now_uses_only_cameras_the_caller_may_see():
    model = scripted(
        [("tool", "look", {"source": "Reception", "question": "Anyone there?"}), ("tool", "look", {"source": "front door", "question": "Is there a parcel?"})],
        [("delta", "Yes, there's a parcel on the doormat [m1].")],
    )
    tools = FakeTools()
    content, events = run({**REQ, "question": "Is there a parcel at the door right now?"}, model, tools)
    assert tools.calls == [("look", {"source_id": "src_door", "question": "Is there a parcel?"})]
    replies = [m for m in model.seen[1]["messages"] if m["role"] == "tool"]
    assert "can't be viewed" in replies[0]["content"]
    assert [e["text"] for e in events if e["type"] == "status"] == ["Looking at Front door…"]
    (m,) = [e["moment"] for e in events if e["type"] == "moment"]
    assert m == {"kind": "look", "source_id": "src_door", "at": "2026-10-16T11:59:58Z", "label": "A parcel is on the doormat.", "snapshot_jpeg_b64": "AAAA"}
    assert content.endswith("[1].")


def test_views_a_past_events_snapshot_by_ref_and_keeps_confidence_apart_from_match():
    model = scripted(
        [("tool", "search_history", {"query": "person at the door"})],
        [("tool", "view_event", {"ref": "m9", "question": "What were they holding?"}), ("tool", "view_event", {"ref": "m1", "question": "What were they holding?"})],
        [("delta", "They were holding a black phone [m2].")],
    )
    tools = FakeTools()
    content, events = run({**REQ, "question": "What was the person at the door holding?"}, model, tools)
    first = json.loads(model.seen[1]["messages"][-1]["content"])["results"][0]
    assert first["confidence"] == 0.82 and first["match"] == 0.71 and "score" not in first
    assert "Never call match a confidence" in model.seen[0]["messages"][0]["content"]
    assert [c for c in tools.calls if c[0] == "view_event"] == [("view_event", {"event_id": "evt_1", "question": "What were they holding?"})]
    replies = [json.loads(m["content"]) for m in model.seen[2]["messages"] if m["role"] == "tool"][-2:]
    assert "unknown ref" in replies[0]["error"] and replies[1]["saw"].startswith("A person in a red coat")
    (m,) = [e["moment"] for e in events if e["type"] == "moment"]
    assert m == {"kind": "event", "source_id": "src_door", "at": HIT["at"], "label": "A person in a red coat holding a black phone.", "event_id": "evt_1"}
    assert content == "They were holding a black phone [1]."


def test_suggests_a_watch_once_with_resolved_sources():
    model = scripted(
        [("tool", "list_events", {"type": "detection.person", "limit": 5}),
         ("tool", "propose_watch", {"instruction": "Tell me when someone comes to the front door", "sources": ["Front door"]}),
         ("tool", "propose_watch", {"instruction": "again", "sources": ["Front door"]})],
        [("delta", "Someone came by at 11:02 [m1]. I can tell you next time.")],
    )
    content, events = run({**REQ, "question": "Let me know when people come by"}, model, FakeTools())
    watches = [e for e in events if e["type"] == "suggested_watch"]
    assert watches == [{"type": "suggested_watch", "instruction": "Tell me when someone comes to the front door", "sources": ["src_door"]}]
    assert "Checking recent events on Front door, Reception…" in [e["text"] for e in events if e["type"] == "status"]  # nothing named: all sources


def test_keeps_context_and_stops_after_max_steps():
    loop = [[("tool", "list_sources", {})]] * 5 + [[("delta", "Both cameras are set up.")]]
    model = scripted(*loop)
    req = {**REQ, "question": "And the other one?", "history": [{"role": "user", "content": "How is the front door?"}, {"role": "assistant", "content": "Quiet."}]}
    content, _ = run(req, model, FakeTools())
    assert content == "Both cameras are set up."
    assert len(model.seen) == 6 and model.seen[-1]["tools"] is None  # the last call must answer
    first = model.seen[0]["messages"]
    assert [m["role"] for m in first] == ["system", "user", "assistant", "user"] and first[-1]["content"] == "And the other one?"
    assert "Front door (id src_door, Porch; online; can look now)" in first[0]["content"]


def test_without_a_model_lists_related_moments():
    content, events = run(REQ, None, FakeTools())
    assert "[1]" in content and "A person walked up" in content
    assert [e["moment"]["event_id"] for e in events if e["type"] == "moment"] == ["evt_1"]
    content, _ = run(REQ, None, FakeTools(results=[]))
    assert content == "I couldn't find anything matching that in the history I can see."


def test_citations_rewriter_handles_split_lists_and_plain_brackets():
    known = {"m1": 1, "m2": 2}
    c = Citations(lambda r: known.get(r))
    out = c.feed("a [m2, m1") + c.feed("] b [m3] c [note] d [") + c.feed("x" * 50) + c.flush()
    assert out == "a [2][1] b c [note] d [" + "x" * 50


def test_mentioned_matches_names_and_locations():
    assert mentioned("anything on the porch?", SOURCES) == ["src_door"]
    assert mentioned("what about RECEPTION today", SOURCES) == ["src_rec"]
    assert mentioned("doorway", SOURCES) == []


def test_stream_turn_assembles_tool_calls():
    def chunk(content=None, calls=None):
        return NS(choices=[NS(delta=NS(content=content, tool_calls=calls))])

    def tc(i, id=None, name=None, args=None):
        return NS(index=i, id=id, function=NS(name=name, arguments=args))

    chunks = [chunk("Hi"), chunk(calls=[tc(0, "call_a", "search_history", '{"que')]), chunk(calls=[tc(0, args='ry": "x"}')]),
              chunk(calls=[tc(1, "call_b", "look", "{}")]), NS(choices=[], usage=NS(prompt_tokens=1, completion_tokens=1))]
    assert list(stream_turn(iter(chunks))) == [
        ("delta", "Hi"),
        ("tool_call", {"id": "call_a", "name": "search_history", "arguments": '{"query": "x"}'}),
        ("tool_call", {"id": "call_b", "name": "look", "arguments": "{}"}),
    ]
