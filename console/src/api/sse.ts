// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// A small Server-Sent Events parser for fetch() streams (EventSource can't POST
// or send an Authorization header). Follows the WHATWG event-stream rules that
// matter here: `event:`, multi-line `data:`, comments, CRLF, blank-line dispatch.

export interface SseEvent {
  event: string;
  data: string;
  id?: string;
}

/** Feed it text chunks in order; it calls `onEvent` for every complete event. */
export function createSseParser(onEvent: (e: SseEvent) => void) {
  let buffer = "";
  let event = "";
  let data: string[] = [];
  let id: string | undefined;

  const dispatch = () => {
    if (data.length) onEvent({ event: event || "message", data: data.join("\n"), ...(id !== undefined ? { id } : {}) });
    event = "";
    data = [];
  };

  const line = (l: string) => {
    if (l === "") return dispatch();
    if (l.startsWith(":")) return;
    const colon = l.indexOf(":");
    const field = colon < 0 ? l : l.slice(0, colon);
    let value = colon < 0 ? "" : l.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
    else if (field === "id") id = value;
  };

  return {
    push(chunk: string) {
      buffer += chunk;
      let nl: number;
      // Split on \n, \r\n or a lone \r (only when the next char is known).
      while ((nl = buffer.search(/\r\n|\n|\r(?=[^\n])/)) >= 0) {
        const len = buffer[nl] === "\r" && buffer[nl + 1] === "\n" ? 2 : 1;
        line(buffer.slice(0, nl));
        buffer = buffer.slice(nl + len);
      }
    },
    /** Flushes a final event that wasn't followed by a blank line. */
    end() {
      if (buffer) line(buffer.replace(/\r$/, ""));
      buffer = "";
      dispatch();
    },
  };
}

/** Reads a fetch Response body as SSE until it ends or the signal aborts. */
export async function readSse(res: Response, onEvent: (e: SseEvent) => void): Promise<void> {
  if (!res.body) return;
  const parser = createSseParser(onEvent);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parser.push(decoder.decode(value, { stream: true }));
  }
  parser.push(decoder.decode());
  parser.end();
}
