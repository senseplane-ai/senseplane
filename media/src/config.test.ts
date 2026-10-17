// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

import type { NetworkInterfaceInfo } from "node:os";
import { describe, expect, it } from "vitest";
import { loadConfig, resolveInternalAddress } from "./config.js";
import { PUBLIC_PEM } from "./testkit.js";

const nets = {
  lo: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
  eth0: [{ address: "fe80::1", family: "IPv6", internal: false }, { address: "172.20.0.5", family: "IPv4", internal: false }],
} as unknown as NodeJS.Dict<NetworkInterfaceInfo[]>;

describe("internal WebRTC address (bridge on the same Docker network)", () => {
  it("resolves auto to the first non-loopback IPv4", () => {
    expect(resolveInternalAddress("auto", nets)).toBe("172.20.0.5");
    expect(resolveInternalAddress("10.0.0.9", nets)).toBe("10.0.0.9");
    expect(resolveInternalAddress(undefined, nets)).toBeUndefined();
    expect(resolveInternalAddress("auto", { lo: nets.lo })).toBeUndefined();
  });

  it("listens for it on its own port block", () => {
    expect(loadConfig({ MEDIA_RTC_PORT: "38400", MEDIA_INTERNAL_ADDRESS: "172.20.0.5" })).toMatchObject({ internalAddress: "172.20.0.5", rtcInternalPort: 38500 });
    expect(loadConfig({ MEDIA_RTC_INTERNAL_PORT: "41000" }).rtcInternalPort).toBe(41000);
    expect(loadConfig({}).internalAddress).toBeUndefined();
  });
});

describe("roles and keys (ADR 0050)", () => {
  it("runs both roles in one process unless told otherwise", () => {
    expect([...loadConfig({}).roles]).toEqual(["ingress", "egress"]);
    expect([...loadConfig({ MEDIA_ROLES: "egress" }).roles]).toEqual(["egress"]);
    expect(() => loadConfig({ MEDIA_ROLES: "router" })).toThrow(/unknown role/);
  });

  it("reads the public key ring, the instance id and the signalling url", () => {
    const c = loadConfig({
      MEDIA_TOKEN_PUBLIC_KEYS: `k1:${Buffer.from(PUBLIC_PEM).toString("base64")}`, MEDIA_INSTANCE_ID: "tribe", MEDIA_URL: "wss://media.example/",
      MEDIA_EGRESS_URL: "http://egress:8090", MEDIA_EGRESS_SECRET: "s",
    });
    expect(Object.keys(c.publicKeys)).toEqual(["k1"]);
    expect(c).toMatchObject({ instanceId: "tribe", mediaUrl: "wss://media.example/", egress: { url: "http://egress:8090", secret: "s" } });
    expect(c.plain.peerCidrs).toContain("10.0.0.0/8");
  });
});
