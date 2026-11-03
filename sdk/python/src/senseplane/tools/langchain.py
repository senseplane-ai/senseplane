# Copyright 2026 The Senseplane Authors
# SPDX-License-Identifier: Apache-2.0
"""LangChain tools for Senseplane (`pip install "senseplane[langchain]"`).

    from senseplane import Senseplane
    from senseplane.tools.langchain import langchain_tools

    agent = create_react_agent(model, langchain_tools(Senseplane()))

Each tool returns the same JSON text as the MCP server's; a failed call returns
`{"error": {...}}` for the model to read rather than raising.
"""

from __future__ import annotations

from collections.abc import Iterable
from typing import Any

from .._async_client import AsyncSenseplane
from .._async_tools import AsyncToolkit
from .._sync_client import Senseplane
from .._sync_tools import Toolkit
from .._tool_defs import tool_definitions, tool_names

try:
    from langchain_core.tools import BaseTool, StructuredTool
except ImportError as err:  # pragma: no cover - depends on the extra
    raise ImportError('senseplane.tools.langchain needs langchain-core: pip install "senseplane[langchain]"') from err

__all__ = ["langchain_tools"]


def langchain_tools(
    client: Senseplane | AsyncSenseplane | Toolkit | AsyncToolkit, *, tools: Iterable[str] | None = None
) -> list[BaseTool]:
    """The Senseplane tools as LangChain StructuredTools (sync with a Senseplane, async with an AsyncSenseplane)."""
    names = tool_names(tools)
    if isinstance(client, Senseplane):
        client = Toolkit(client, tools=names)
    elif isinstance(client, AsyncSenseplane):
        client = AsyncToolkit(client, tools=names)
    toolkit = client
    out: list[BaseTool] = []
    for d in tool_definitions():
        if d["name"] not in names:
            continue
        out.append(_tool(toolkit, d))
    return out


def _tool(toolkit: Toolkit | AsyncToolkit, d: dict[str, Any]) -> BaseTool:
    name = d["name"]
    if isinstance(toolkit, AsyncToolkit):
        atk = toolkit

        async def coroutine(**kwargs: Any) -> str:
            return (await atk.call(name, kwargs)).text()

        return StructuredTool.from_function(
            coroutine=coroutine, name=name, description=d["description"], args_schema=d["inputSchema"]
        )
    tk = toolkit

    def func(**kwargs: Any) -> str:
        return tk.call(name, kwargs).text()

    return StructuredTool.from_function(
        func=func, name=name, description=d["description"], args_schema=d["inputSchema"]
    )
