// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Server-Sent Events read over fetch (so the API key goes in a header, never
// in the URL): yields each `event:` name with its parsed JSON `data:`.
export async function* readSse(res: Response): AsyncGenerator<{ event: string; data: unknown }> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      let cut: number;
      while ((cut = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 2);
        let event = "message";
        let data = "";
        for (const line of block.split("\n")) {
          if (line.startsWith("event: ")) event = line.slice(7);
          else if (line.startsWith("data: ")) data += line.slice(6);
        }
        if (data) yield { event, data: JSON.parse(data) };
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined); // the caller stopped early, or the stream ended
  }
}
