// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { deliveryErrorText, EgressError, guardedLookup, guardedRequest, isBlockedAddress, webhookUrlProblem } from "./egress.js";

const strict = { allowPrivate: false, allowedHosts: [] };

describe("webhook egress (SSRF guard)", () => {
  it("classifies addresses", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.20.0.5", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "::", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "64:ff9b::a9fe:a9fe", "224.0.0.1"]) {
      expect(isBlockedAddress(ip), ip).toBe(true);
    }
    for (const ip of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"]) expect(isBlockedAddress(ip), ip).toBe(false);
  });

  it("rejects non-public URLs at creation", () => {
    const o = { production: true, policy: strict };
    for (const u of ["https://127.0.0.1/x", "https://[::ffff:7f00:1]/x", "https://media:8091/x", "https://valkey/x", "https://foo.internal/x", "https://localhost/x", "https://user:pw@hooks.example.com/x", "http://hooks.example.com/x"]) {
      expect(webhookUrlProblem(u, o), u).toBeDefined();
    }
    expect(webhookUrlProblem("https://hooks.example.com/x", o)).toBeUndefined();
    expect(webhookUrlProblem("https://media:8091/x", { production: true, policy: { allowPrivate: false, allowedHosts: ["media"] } })).toBeUndefined();
  });

  it("refuses names that resolve to private addresses at delivery time", async () => {
    const err = await new Promise<NodeJS.ErrnoException | null>((r) => guardedLookup(strict)("localhost", {}, (e) => r(e)));
    expect(err?.code).toBe("EBLOCKED");
    await expect(guardedRequest("http://127.0.0.1:9/x", { method: "POST", headers: {}, body: "{}" }, strict)).rejects.toMatchObject({ kind: "blocked_destination" });
  });

  it("never follows redirects and stores only coarse errors", async () => {
    const server = createServer((_req, res) => {
      res.statusCode = 302;
      res.setHeader("location", "http://169.254.169.254/latest/meta-data");
      res.end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    const allow = { allowPrivate: true, allowedHosts: [] };
    const res = await guardedRequest(`http://127.0.0.1:${port}/hook`, { method: "POST", headers: {}, body: "{}" }, allow);
    expect(res.status).toBe(302);
    expect(deliveryErrorText(undefined, 302)).toBe("HTTP 3xx (redirects are not followed)");
    await new Promise<void>((r) => server.close(() => r()));
    const refused = await guardedRequest(`http://127.0.0.1:${port}/hook`, { method: "POST", headers: {}, body: "{}" }, allow).catch((e) => e);
    expect(refused).toBeInstanceOf(EgressError);
    expect(deliveryErrorText(refused)).toBe("connection failed");
  });
});
