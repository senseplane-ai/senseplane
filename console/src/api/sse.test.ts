// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { ApiExtra } from "./extra";
import { type SseEvent, createSseParser } from "./sse";

const collect = (chunks: string[]) => {
  const out: SseEvent[] = [];
  const p = createSseParser((e) => out.push(e));
  for (const c of chunks) p.push(c);
  p.end();
  return out;
};

describe("createSseParser", () => {
  it("parses named events with JSON data", () => {
    expect(collect(['event: status\ndata: {"text":"Looking at Front door…"}\n\n'])).toEqual([
      { event: "status", data: '{"text":"Looking at Front door…"}' },
    ]);
  });

  it("joins events split across chunks, mid-line and mid-field", () => {
    const out = collect(["event: del", "ta\ndata: {\"te", "xt\":\"Hel\"}\n", "\nevent: delta\ndata: {\"text\":\"lo\"}\n\n"]);
    expect(out.map((e) => JSON.parse(e.data).text)).toEqual(["Hel", "lo"]);
  });

  it("handles CRLF, comments, multi-line data and the default event name", () => {
    const out = collect([": keep-alive\r\n\r\ndata: one\r\ndata: two\r\n\r\n"]);
    expect(out).toEqual([{ event: "message", data: "one\ntwo" }]);
  });

  it("flushes a final event with no trailing blank line", () => {
    expect(collect(["event: done\ndata: {}"])).toEqual([{ event: "done", data: "{}" }]);
  });

  it("ignores events without data and keeps the last id", () => {
    expect(collect(["event: ping\n\nid: 7\nevent: delta\ndata: x\n\n"])).toEqual([{ event: "delta", data: "x", id: "7" }]);
  });
});

describe("ApiExtra.conversations.send", () => {
  // Streams the body in 7-byte chunks so events arrive split across reads.
  const sse = (body: string) => async () => {
    const bytes = new TextEncoder().encode(body);
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        for (let i = 0; i < bytes.length; i += 7) c.enqueue(bytes.slice(i, i + 7));
        c.close();
      },
    });
    return new Response(stream, { headers: { "content-type": "text/event-stream" } });
  };

  it("routes each stream event to its handler and resolves with the final message", async () => {
    const final = { id: "msg_2", role: "assistant", content: "Hello", moments: [], created_at: "2026-10-16T10:00:00Z" };
    const body = [
      'event: status\ndata: {"text":"Looking at Front door…"}\n\n',
      'event: delta\ndata: {"text":"Hel"}\n\n',
      'event: delta\ndata: {"text":"lo"}\n\n',
      'event: moment\ndata: {"source_id":"src_1","source_name":"Front door","at":"2026-10-16T09:00:00Z","label":"Courier","snapshot_url":"http://x/s.jpg"}\n\n',
      'event: suggested_watch\ndata: {"instruction":"Tell me when a parcel arrives","sources":["src_1"]}\n\n',
      `event: done\ndata: ${JSON.stringify({ message: final })}\n\n`,
    ].join("");
    const seen: string[] = [];
    let text = "";
    const api = new ApiExtra("http://test/v1", "sk", sse(body) as unknown as typeof fetch);
    const out = await api.conversations.send("cnv_1", { content: "hi" }, {
      status: (t) => seen.push(`status:${t}`),
      delta: (t) => { text += t; },
      moment: (m) => seen.push(`moment:${m.label}`),
      suggestedWatch: (w) => seen.push(`watch:${w.instruction}`),
      done: (m) => seen.push(`done:${m.id}`),
    });
    expect(text).toBe("Hello");
    expect(seen).toEqual(["status:Looking at Front door…", "moment:Courier", "watch:Tell me when a parcel arrives", "done:msg_2"]);
    expect(out?.id).toBe("msg_2");
  });

  it("reports a stream error event", async () => {
    const api = new ApiExtra("http://test/v1", "sk", sse('event: error\ndata: {"error":{"message":"No model"}}\n\n') as unknown as typeof fetch);
    let err = "";
    await api.conversations.send("cnv_1", { content: "hi" }, { error: (m) => { err = m; } });
    expect(err).toBe("No model");
  });

  it("falls back to a JSON reply when the server doesn't stream", async () => {
    const msg = { id: "msg_3", role: "assistant", content: "Fine", moments: [], created_at: "2026-10-16T10:00:00Z" };
    const api = new ApiExtra("http://test/v1", "sk", (async () => Response.json(msg)) as unknown as typeof fetch);
    expect((await api.conversations.send("cnv_1", { content: "hi" }, {}))?.content).toBe("Fine");
  });

  it("throws a SenseplaneError for HTTP errors", async () => {
    const api = new ApiExtra("http://test/v1", "sk", (async () => Response.json({ error: { code: "not_found", message: "nope" } }, { status: 404 })) as unknown as typeof fetch);
    await expect(api.conversations.send("cnv_1", { content: "hi" }, {})).rejects.toMatchObject({ status: 404, code: "not_found" });
  });
});
