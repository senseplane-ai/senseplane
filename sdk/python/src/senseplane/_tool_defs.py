# Copyright 2026 The Senseplane Authors
# SPDX-License-Identifier: Apache-2.0

# The MCP tool definitions (spec/mcp/tools.json, copied by codegen) in the
# shapes the Anthropic and OpenAI APIs take, and the result type both toolkits return.
from __future__ import annotations

import copy
import json
from collections.abc import Iterable
from dataclasses import dataclass, field
from functools import cache
from importlib import resources
from typing import Any


@cache
def _spec() -> dict[str, Any]:
    text = resources.files("senseplane._generated").joinpath("tools.json").read_text(encoding="utf-8")
    data: dict[str, Any] = json.loads(text)
    return data


def tool_definitions() -> list[dict[str, Any]]:
    """The tools as the MCP server lists them: name, description, inputSchema and output (a copy)."""
    return copy.deepcopy(_spec()["tools"])


TOOL_NAMES: tuple[str, ...] = tuple(t["name"] for t in _spec()["tools"])
"""The tool names, in spec order (list_senses, look, listen, …, stop_watching)."""


def tool_names(only: Iterable[str] | None = None) -> list[str]:
    if only is None:
        return list(TOOL_NAMES)
    names = list(only)
    unknown = [n for n in names if n not in TOOL_NAMES]
    if unknown:
        raise ValueError(f"unknown tools: {', '.join(unknown)} (known: {', '.join(TOOL_NAMES)})")
    return names


def _picked(names: Iterable[str] | None) -> list[dict[str, Any]]:
    wanted = tool_names(names)
    return [t for t in tool_definitions() if t["name"] in wanted]


def anthropic_tools(names: Iterable[str] | None = None) -> list[dict[str, Any]]:
    """Tool definitions for the Anthropic Messages API: `{"name", "description", "input_schema"}`."""
    return [
        {"name": t["name"], "description": t["description"], "input_schema": t["inputSchema"]} for t in _picked(names)
    ]


def openai_tools(names: Iterable[str] | None = None, *, api: str = "chat") -> list[dict[str, Any]]:
    """Tool definitions for OpenAI: Chat Completions (`api="chat"`) or the Responses API (`"responses"`).

    Not `strict`: several tools have optional arguments, which strict mode doesn't allow.
    """
    if api not in ("chat", "responses"):
        raise ValueError('api is "chat" or "responses"')
    out = []
    for t in _picked(names):
        fn = {"name": t["name"], "description": t["description"], "parameters": t["inputSchema"]}
        out.append({"type": "function", "function": fn} if api == "chat" else {"type": "function", **fn})
    return out


@dataclass
class ToolResult:
    """A tool's result: MCP-style content blocks (`text`, and `image` for look) and whether it failed."""

    content: list[dict[str, Any]] = field(default_factory=list)
    is_error: bool = False

    def text(self) -> str:
        """The text blocks joined: the JSON the model reads (images are referenced by their snapshot_url)."""
        return "\n".join(b["text"] for b in self.content if b["type"] == "text")

    def anthropic(self, tool_use_id: str) -> dict[str, Any]:
        """The Anthropic `tool_result` content block, images included so the model sees them."""
        blocks: list[dict[str, Any]] = []
        for b in self.content:
            if b["type"] == "image":
                source = {"type": "base64", "media_type": b["mime_type"], "data": b["data"]}
                blocks.append({"type": "image", "source": source})
            else:
                blocks.append({"type": "text", "text": b["text"]})
        return {"type": "tool_result", "tool_use_id": tool_use_id, "content": blocks, "is_error": self.is_error}

    def value(self) -> Any:
        """The text result parsed back into a value."""
        return json.loads(self.text())
