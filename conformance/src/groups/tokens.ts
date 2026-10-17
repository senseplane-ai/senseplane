// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Tokens over the network (spec/media/tokens.md): the same accept/refuse
// rules as the golden vectors, signed with the suite's key so the media plane
// under test can judge them, at the control API and at signalling join.
import { generateKeyPairSync } from "node:crypto";
import { type Config, Peer, Report, type Signer, control, grants, jti, now, roomName } from "../kit.ts";

export async function tokens(c: Config, s: Signer) {
  const r = new Report("tokens");
  // Control tokens.
  r.check("control: valid", (await control(c, s, "GET", "/control/usage")).status === 200);
  const once = s.control();
  await control(c, s, "GET", "/control/usage", undefined, once);
  r.check("control: a replayed token is refused", (await control(c, s, "GET", "/control/usage", undefined, once)).status === 401);
  const other = generateKeyPairSync("ed25519").privateKey;
  const badControl: [string, string][] = [
    ["no token", ""],
    ["two parts", s.control().split(".").slice(0, 2).join(".")],
    ["alg none", `${Buffer.from(JSON.stringify({ alg: "none", kid: "x" })).toString("base64url")}.${Buffer.from(JSON.stringify({ aud: "control" })).toString("base64url")}.`],
    ["unknown kid", s.jws({ v: 1, iss: s.issuer, aud: "control", jti: jti(), iat: now(), exp: now() + 60 }, { alg: "EdDSA", typ: "JWT", kid: "cf-unknown" })],
    ["signed with another key", s.jws({ v: 1, iss: s.issuer, aud: "control", jti: jti(), iat: now(), exp: now() + 60 }, undefined, other)],
    ["a join token", s.join({ room: "x", identity: "y", grants: grants.publisher() })],
    ["another issuer", s.control({ iss: "cf-someone-else" })],
    ["expired", s.control({ iat: now() - 200, exp: now() - 100 })],
    ["issued in the future", s.control({ iat: now() + 120, exp: now() + 180 })],
    ["lives longer than 900 s", s.control({ exp: now() + 1000 })],
    ["carries a room", s.control({ room: "x" })],
  ];
  for (const [name, token] of badControl) r.check(`control: ${name} is refused`, (await control(c, s, "GET", "/control/usage", undefined, token)).status === 401);

  // Join tokens: into a real room, so only the token decides.
  const room = roomName("tok");
  const created = await control(c, s, "POST", "/control/rooms", { roomId: room, options: { liveness: "any" } });
  const signal = String(created.body?.signal_url ?? "");
  r.check("a room answers its signal_url", /^wss?:\/\//.test(signal), created.body);
  const join = async (token: string) => {
    const p = new Peer(signal);
    try {
      return await p.join(token);
    } finally {
      p.close();
    }
  };
  const ok = (name: string, claims: Record<string, unknown>) => join(s.jws(claims)).then((res) => r.check(`join: ${name} is accepted`, res.ok === true, res));
  const no = (name: string, token: string) => join(token).then((res) => r.check(`join: ${name} is refused`, res.ok === false && (res.code === "unauthorized" || res.code === "replayed"), res));
  const base = (o: Partial<Parameters<Signer["joinClaims"]>[0]> = {}) => s.joinClaims({ room, identity: `cf-${jti()}`, grants: grants.publisher(), ...o });
  await ok("a publisher with every Senseplane grant", base());
  await ok("a viewer limited to video", base({ grants: grants.viewer(["video"]) }));
  await ok("an egress over a pipe transport", base({ kind: "egress", transport: "pipe", grants: grants.egress() }));
  await ok("a WHIP ingress over webrtc", base({ kind: "ingress" }));
  const used = s.jws(base());
  await join(used);
  r.check("join: a token works once", (await join(used)).code === "replayed");
  await no("expired", s.jws({ ...base(), iat: now() - 700, exp: now() - 60 }));
  await no("not before ahead", s.jws({ ...base(), nbf: now() + 120 }));
  await no("lives longer than 900 s", s.jws({ ...base(), exp: now() + 1000 }));
  await no("for another audience", s.jws({ ...base(), aud: "control" }));
  await no("from another issuer", s.jws({ ...base(), iss: "cf-someone-else" }));
  await no("with an extra claim", s.jws({ ...base(), sub: "x" }));
  await no("with an unknown grant", s.jws(base({ grants: { ...grants.publisher(), recordEverything: true } })));
  await no("with subscribeKinds naming screen", s.jws(base({ grants: { ...grants.viewer(), subscribeKinds: ["video", "screen"] } })));
  await no("with maxResolution 2160p", s.jws(base({ grants: { ...grants.publisher(), maxResolution: "2160p" } })));
  await no("with subscribeKinds but no canSubscribe", s.jws(base({ grants: { ...grants.publisher(), subscribeKinds: ["video"] } })));
  await no("a human with subscribeExempt", s.jws(base({ grants: { ...grants.viewer(), subscribeExempt: true, maxSubscriptions: 4 } })));
  await no("a human on a plain transport", s.jws(base({ transport: "plain" })));
  await no("with an unknown kid", s.jws(base(), { alg: "EdDSA", typ: "JWT", kid: "cf-unknown" }));
  await no("signed with another key", s.jws(base(), undefined, other));
  const p = new Peer(signal);
  const v2 = await p.request("join", { protocolVersion: 2, token: s.jws(base()) });
  r.check("join: protocolVersion 2 is refused", v2.ok === false && v2.code === "protocol_version", v2);
  p.close();
  await control(c, s, "DELETE", `/control/rooms/${encodeURIComponent(room)}`);
  return r.results;
}
