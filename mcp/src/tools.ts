// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

import spec from "./generated/tools.json" with { type: "json" };

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  output: string;
}

/** The 8 MCP tools, generated from spec/mcp/tools.json. Handlers are in handlers.ts. */
export const tools: ToolDefinition[] = spec.tools as ToolDefinition[];
