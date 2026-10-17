// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Writes spec/media/vectors/tokens.json: golden accept/refuse cases for the
// three media token kinds (spec/media/tokens.md). The key below is for these
// vectors only and must never be trusted by a real media plane. Ed25519 is
// deterministic, so the same input always gives the same file.
import { createPrivateKey, sign } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const PRIVATE_PEM = "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIK321OzTLMIDxdFaJwHS8LZos8d60BzUhb0IAYplk6zm\n-----END PRIVATE KEY-----\n";
const PUBLIC_PEM = "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAD/sOi0zgriQv52Hy+b2Is8dV1ntIJgZ8CV+I3TZwv3A=\n-----END PUBLIC KEY-----\n";
// A second key, signed with but NOT in the ring: a valid-looking token under a kid the verifier knows.
const OTHER_PEM = "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIP38WPFuG4M6a14vKy4B6/sCYblXhBt9wqIJOUnBeIFN\n-----END PRIVATE KEY-----\n";
const KID = "vectors-1";
const ISS = "vectors";
const NOW = 1790000000;

const b64u = (b) => Buffer.from(b).toString("base64url");
const seg = (v) => b64u(JSON.stringify(v));
function jws(payload, opts = {}) {
  const { kid = KID, alg = "EdDSA", key = PRIVATE_PEM } = opts;
  const h = "header" in opts ? opts.header : { alg, typ: "JWT", ...(kid === null ? {} : { kid }) };
  const input = `${seg(h)}.${typeof payload === "string" ? b64u(payload) : seg(payload)}`;
  return `${input}.${b64u(sign(null, Buffer.from(input), createPrivateKey(key)))}`;
}

const publisher = {
  v: 1, iss: ISS, aud: "media", room: "sp-src_vectors", identity: "src_vectors:capture", kind: "human", transport: "webrtc",
  grants: { canPublish: true, canSubscribe: false, canPublishData: false, publishKinds: ["video", "audio"], maxResolution: "720p", maxActiveSources: 3 },
  jti: "jti-publisher-0001", iat: NOW - 10, exp: NOW + 590,
};
const viewer = {
  v: 1, iss: ISS, aud: "media", room: "sp-src_vectors", identity: "src_vectors:viewer:lv_vectors", kind: "human", transport: "webrtc",
  grants: { canPublish: false, canSubscribe: true, canPublishData: false, subscribeKinds: ["video"], idleTimeoutSeconds: 600, maxLiveViewers: 5 },
  jti: "lv_vectors_0001", iat: NOW - 5, exp: NOW + 55,
};
const egress = {
  v: 1, iss: ISS, aud: "media", room: "sp-src_vectors", identity: "src_vectors:feed", kind: "egress", transport: "pipe",
  grants: { canPublish: false, canSubscribe: true, canPublishData: false, subscribeExempt: true, maxSubscriptions: 4, subscribeKinds: ["video", "audio"] },
  jti: "jti-egress-00001", iat: NOW, exp: NOW + 600,
};
const whipJoin = { ...publisher, identity: "src_vectors:whip", kind: "ingress", jti: "jti-whip-join-01" };
const control = { v: 1, iss: ISS, aud: "control", jti: "jti-control-0001", iat: NOW - 1, exp: NOW + 59 };
const whip = { v: 1, iss: ISS, aud: "whip", room: "sp-src_vectors", authorize_url: "https://api.example.com/internal/media/whip-authorize", jti: "itk_vectors_0001", iat: NOW - 86400 };

const ok = (claims) => ({ ok: true, claims });
const no = (reason) => ({ ok: false, reason });
const cases = [];
const add = (name, audience, token, expect) => cases.push({ name, audience, token, expect });

// --- join tokens (aud media) ---
add("join: capture publisher", "media", jws(publisher), ok(publisher));
add("join: live viewer limited to video", "media", jws(viewer), ok(viewer));
add("join: feed egress over a plain transport", "media", jws(egress), ok(egress));
add("join: WHIP ingress over webrtc", "media", jws(whipJoin), ok(whipJoin));
add("join: with name and nbf", "media", jws({ ...publisher, name: "Front door", nbf: NOW - 10 }), ok({ ...publisher, name: "Front door", nbf: NOW - 10 }));
add("join: expired 29 s ago is still inside the skew", "media", jws({ ...publisher, iat: NOW - 629, exp: NOW - 29 }), ok({ ...publisher, iat: NOW - 629, exp: NOW - 29 }));
add("join: two parts", "media", jws(publisher).split(".").slice(0, 2).join("."), no("malformed"));
add("join: header is not JSON", "media", `${b64u("not json")}.${seg(publisher)}.${b64u("x")}`, no("malformed"));
add("join: header is null", "media", jws(publisher, { header: null }), no("malformed"));
add("join: alg none", "media", `${seg({ alg: "none", typ: "JWT", kid: KID })}.${seg(publisher)}.`, no("malformed"));
add("join: alg HS256", "media", jws(publisher, { alg: "HS256" }), no("malformed"));
add("join: no kid", "media", jws(publisher, { kid: null }), no("malformed"));
add("join: unknown kid", "media", jws(publisher, { kid: "nobody" }), no("unknown_kid"));
add("join: kid is a prototype key", "media", jws(publisher, { kid: "__proto__" }), no("unknown_kid"));
add("join: signed with another key", "media", jws(publisher, { key: OTHER_PEM }), no("bad_signature"));
{
  const [h, , s] = jws(publisher).split(".");
  add("join: payload changed after signing", "media", `${h}.${seg({ ...publisher, room: "sp-src_other" })}.${s}`, no("bad_signature"));
}
add("join: control audience", "media", jws(control), no("wrong_audience"));
add("join: another issuer", "media", jws({ ...publisher, iss: "someone-else" }), no("wrong_issuer"));
add("join: expired", "media", jws({ ...publisher, iat: NOW - 700, exp: NOW - 30 }), no("expired"));
add("join: not before is ahead", "media", jws({ ...publisher, nbf: NOW + 31 }), no("not_yet_valid"));
add("join: issued in the future", "media", jws({ ...publisher, iat: NOW + 31, exp: NOW + 600 }), no("not_yet_valid"));
add("join: lives longer than 900 s", "media", jws({ ...publisher, iat: NOW, exp: NOW + 901 }), no("ttl_too_long"));
add("join: an extra claim", "media", jws({ ...publisher, sub: "src_vectors" }), no("bad_claims"));
add("join: version 2", "media", jws({ ...publisher, v: 2 }), no("bad_claims"));
add("join: no jti", "media", jws((({ jti, ...r }) => r)(publisher)), no("bad_claims"));
add("join: short jti", "media", jws({ ...publisher, jti: "short" }), no("bad_claims"));
add("join: room too long", "media", jws({ ...publisher, room: "r".repeat(201) }), no("bad_claims"));
add("join: unknown kind", "media", jws({ ...publisher, kind: "robot" }), no("bad_claims"));
add("join: an unknown grant", "media", jws({ ...publisher, grants: { ...publisher.grants, recordEverything: true } }), no("bad_claims"));
add("join: misspelt grant", "media", jws({ ...viewer, grants: { ...viewer.grants, subscribeOnly: true } }), no("bad_claims"));
add("join: subscribeKinds names a kind that does not exist", "media", jws({ ...viewer, grants: { ...viewer.grants, subscribeKinds: ["video", "screen"] } }), no("bad_claims"));
add("join: empty subscribeKinds", "media", jws({ ...viewer, grants: { ...viewer.grants, subscribeKinds: [] } }), no("bad_claims"));
add("join: maxResolution 4k", "media", jws({ ...publisher, grants: { ...publisher.grants, maxResolution: "2160p" } }), no("bad_claims"));
add("join: subscribeKinds without canSubscribe", "media", jws({ ...publisher, grants: { ...publisher.grants, subscribeKinds: ["video"] } }), no("bad_claims"));
add("join: subscribeExempt for a human", "media", jws({ ...viewer, grants: { ...viewer.grants, subscribeExempt: true, maxSubscriptions: 4 } }), no("bad_claims"));
add("join: subscribeExempt without a ceiling", "media", jws({ ...egress, grants: { ...egress.grants, maxSubscriptions: undefined } }), no("bad_claims"));
add("join: publishKinds without canPublish", "media", jws({ ...viewer, grants: { ...viewer.grants, publishKinds: ["video"] } }), no("bad_claims"));
add("join: a human on a plain transport", "media", jws({ ...publisher, transport: "plain" }), no("bad_transport"));

// --- control tokens (aud control) ---
add("control: valid", "control", jws(control), ok(control));
add("control: a join token", "control", jws(publisher), no("wrong_audience"));
add("control: another issuer", "control", jws({ ...control, iss: "someone-else" }), no("wrong_issuer"));
add("control: carries a room", "control", jws({ ...control, room: "sp-src_vectors" }), no("bad_claims"));
add("control: expired", "control", jws({ ...control, iat: NOW - 120, exp: NOW - 31 }), no("expired"));
add("control: lives longer than 900 s", "control", jws({ ...control, exp: NOW + 1000 }), no("ttl_too_long"));

// --- WHIP bearers (aud whip) ---
add("whip: without expiry", "whip", jws(whip), ok(whip));
add("whip: with an expiry ahead", "whip", jws({ ...whip, exp: NOW + 86400 }), ok({ ...whip, exp: NOW + 86400 }));
add("whip: without v", "whip", jws((({ v, ...r }) => r)(whip)), ok((({ v, ...r }) => r)(whip)));
add("whip: expired", "whip", jws({ ...whip, exp: NOW - 31 }), no("expired"));
add("whip: issued in the future", "whip", jws({ ...whip, iat: NOW + 31 }), no("not_yet_valid"));
add("whip: authorize_url is not http(s)", "whip", jws({ ...whip, authorize_url: "file:///etc/passwd" }), no("bad_claims"));
add("whip: no authorize_url", "whip", jws((({ authorize_url, ...r }) => r)(whip)), no("bad_claims"));
add("whip: carries grants", "whip", jws({ ...whip, grants: publisher.grants }), no("bad_claims"));
add("whip: a join token", "whip", jws(publisher), no("wrong_audience"));
add("whip: signed with another key", "whip", jws(whip, { key: OTHER_PEM }), no("bad_signature"));

const doc = {
  $comment: "Generated by spec/scripts/media-vectors.mjs; do not edit. Copyright 2026 The Senseplane Authors. SPDX-License-Identifier: Apache-2.0. The key is for these vectors only.",
  issuer: ISS,
  now: NOW,
  skew_seconds: 30,
  max_ttl_seconds: 900,
  keys: { [KID]: { public_pem: PUBLIC_PEM, private_pem: PRIVATE_PEM } },
  ring: `${KID}:${Buffer.from(PUBLIC_PEM).toString("base64")}`,
  cases,
};
mkdirSync(join(root, "media/vectors"), { recursive: true });
writeFileSync(join(root, "media/vectors/tokens.json"), JSON.stringify(doc, null, 2) + "\n");
if (process.argv[1] === fileURLToPath(import.meta.url)) console.log(`media vectors: ${cases.length} token cases`);
