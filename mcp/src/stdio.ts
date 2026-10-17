#!/usr/bin/env node
// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Local MCP over stdio: `SENSEPLANE_API_KEY=sk_… senseplane-mcp`.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Senseplane } from "senseplane";
import { createMcpServer } from "./handlers.js";
import { watchInbox } from "./inbox.js";

const apiKey = process.env.SENSEPLANE_API_KEY;
if (!apiKey) {
  console.error("Set SENSEPLANE_API_KEY (and SENSEPLANE_API_URL for your own instance).");
  process.exit(1);
}
const client = new Senseplane({ apiKey, baseUrl: process.env.SENSEPLANE_API_URL ?? "https://api.senseplane.com/v1" });
const server = createMcpServer(client);
// The session stays open, so tell the client when its watches send it events (ADR 0043).
let stop = () => {};
server.oninitialized = () => {
  stop = watchInbox(server, client, { log: (msg, err) => console.error(msg, err instanceof Error ? err.message : err) });
};
server.onclose = () => stop();
await server.connect(new StdioServerTransport());
