// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Segments encrypted before upload when the caller answers upload_url with a key (ADR 0066).
import { createDecipheriv, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { FeedCallback } from "./egress/callback.js";
import { createUploader } from "./egress/uploader.js";

function harness(answer: (body: Record<string, unknown>) => Record<string, unknown>) {
  const asked: Record<string, unknown>[] = [];
  const put: Buffer[] = [];
  const callback = { async request(_op: string, body: Record<string, unknown>) { asked.push(body); return answer(body); } } as unknown as FeedCallback;
  const fetch = (async (_url: string, init: { body: Uint8Array }) => {
    put.push(Buffer.from(init.body));
    return new Response(null, { status: 200 });
  }) as unknown as typeof globalThis.fetch;
  return { asked, put, uploader: createUploader({ type: "presign-callback" } as never, callback, { fetch }) };
}

describe("segment encryption before upload", () => {
  it("offers aes-128, encrypts with the key it is given, and reports it", async () => {
    const key = randomBytes(16);
    const iv = randomBytes(16);
    const h = harness((b) => b.content_type === "video/iso.segment"
      ? { url: "https://s3.test/x", encryption: { method: "aes-128", key: key.toString("base64"), iv: iv.toString("hex"), key_id: "3" } }
      : { url: "https://s3.test/x" });
    const body = Buffer.from("a segment ".repeat(100));
    const stored = await h.uploader.put("raw/a/s/1.m4s", body, "video/iso.segment");
    expect(h.asked[0]!.encryption).toEqual(["aes-128"]);
    expect(stored.encryption).toEqual({ method: "aes-128", key_id: "3", iv: iv.toString("hex") });
    expect(stored.bytes).toBe(h.put[0]!.length);
    const d = createDecipheriv("aes-128-cbc", key, iv);
    expect(Buffer.concat([d.update(h.put[0]!), d.final()]).equals(body)).toBe(true);

    // The init: no key given, stored as it is.
    const init = Buffer.from("init");
    expect(await h.uploader.put("raw/a/s/init/x.mp4", init, "video/mp4")).toEqual({ bytes: 4 });
    expect(h.put[1]!.equals(init)).toBe(true);
  });

  it("refuses to upload with an encryption it can't apply", async () => {
    const h = harness(() => ({ url: "https://s3.test/x", encryption: { method: "aes-256-xyz", key: "a", iv: "b", key_id: "1" } }));
    await expect(h.uploader.put("raw/a/s/1.m4s", Buffer.from("x"), "video/iso.segment")).rejects.toThrow(/doesn't know/);
    const bad = harness(() => ({ url: "https://s3.test/x", encryption: { method: "aes-128", key: "c2hvcnQ=", iv: "00", key_id: "1" } }));
    await expect(bad.uploader.put("raw/a/s/1.m4s", Buffer.from("x"), "video/iso.segment")).rejects.toThrow(/malformed/);
    expect(h.put.length + bad.put.length).toBe(0); // nothing went to the bucket in clear
  });
});
