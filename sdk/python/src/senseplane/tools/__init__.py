# Copyright 2026 The Senseplane Authors
# SPDX-License-Identifier: Apache-2.0
"""Senseplane's agent tools (the MCP server's tool set) for agent frameworks.

    from senseplane import Senseplane
    from senseplane.tools import Toolkit

    toolkit = Toolkit(Senseplane())
    response = anthropic.messages.create(..., tools=toolkit.anthropic())
    for block in response.content:
        if block.type == "tool_use":
            results.append(toolkit.call_anthropic(block))

`Toolkit.openai()` gives OpenAI function tools; `senseplane.tools.langchain` (the
`senseplane[langchain]` extra) gives LangChain tools.
"""

from .._async_tools import AsyncToolkit
from .._sync_tools import Toolkit
from .._tool_defs import TOOL_NAMES, ToolResult, anthropic_tools, openai_tools, tool_definitions

__all__ = [
    "TOOL_NAMES",
    "AsyncToolkit",
    "ToolResult",
    "Toolkit",
    "anthropic_tools",
    "openai_tools",
    "tool_definitions",
]
