// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Team check (ADR 0044), against a running development stack (sign-up open):
//  1. sign up like a real user through /auth and land as the owner;
//  2. invite a second person, preview and accept the link (they sign up);
//  3. the invite is single use;
//  4. roles hold: a viewer reads but can't write; promoted to member they can
//     create watches but still not invite; the owner can't be demoted alone;
//  5. removing the member ends their session; it's all in the audit log.
//
//   E2E_API_URL=http://localhost:34080 node team-check.ts
const API = process.env.E2E_API_URL ?? "http://localhost:58080";
const log = (msg: string, extra: object = {}) => console.log(JSON.stringify({ t: new Date().toISOString(), msg, ...extra }));
const run = Date.now().toString(36);
const PW = "correct horse battery staple";
let failures = 0;
const check = (name: string, ok: boolean, extra: object = {}) => {
  if (!ok) failures++;
  log(ok ? "pass" : "FAIL", { check: name, ...extra });
};

const req = async (method: string, path: string, opts: { key?: string; body?: unknown } = {}) => {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { ...(opts.key ? { authorization: `Bearer ${opts.key}` } : {}), ...(opts.body !== undefined ? { "content-type": "application/json" } : {}) },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const json = res.status === 204 ? {} : await res.json().catch(() => ({}));
  return { status: res.status, json: json as any };
};

// 1. Sign up.
const providers = (await req("GET", "/auth/providers")).json;
check("sign-up is open on the development stack", providers.signup === true, { providers });
const ownerEmail = `owner-${run}@example.test`;
const signup = await req("POST", "/auth/signup", { body: { email: ownerEmail, password: PW, name: `Team e2e ${run}` } });
check("owner signs up", signup.status === 201, { status: signup.status });
const owner = signup.json.session as string;
const me = (await req("GET", "/v1/me", { key: owner })).json;
check("owner is the owner", me.role === "owner" && me.user?.email === ownerEmail && me.memberships.length === 1, { me });
await req("PATCH", "/v1/account", { key: owner, body: { time_zone: "Europe/Berlin" } });

// 2. Invite and accept.
const guestEmail = `guest-${run}@example.test`;
const invite = await req("POST", "/v1/invites", { key: owner, body: { email: guestEmail, role: "viewer" } });
check("owner creates an invite", invite.status === 201 && /#invite=inv_/.test(invite.json.invite_url ?? ""), { status: invite.status, expires_at: invite.json.expires_at });
const token = new URLSearchParams(new URL(invite.json.invite_url).hash.slice(1)).get("invite")!;
const preview = (await req("GET", `/auth/invites/${token}`)).json;
check("invite preview names the workspace and asks for a new password", preview.workspace?.name === `Team e2e ${run}` && preview.existing_user === false, { preview });
const wrong = await req("POST", `/auth/invites/${token}/accept`, { body: { email: `eve-${run}@example.test`, password: PW } });
check("another email is refused", wrong.status === 403, { status: wrong.status });
const accept = await req("POST", `/auth/invites/${token}/accept`, { body: { password: PW, name: "Guest" } });
check("guest accepts and signs up", accept.status === 200 && accept.json.account_id === signup.json.account_id, { status: accept.status });
const guest = accept.json.session as string;

// 3. Single use.
const reuse = await req("POST", `/auth/invites/${token}/accept`, { body: { password: PW } });
check("the link works once", reuse.status === 410 && reuse.json.error?.details?.reason === "accepted", { status: reuse.status });

// 4. Roles.
const gme = (await req("GET", "/v1/me", { key: guest })).json;
check("guest is a viewer in the owner's workspace", gme.role === "viewer" && gme.account?.time_zone === "Europe/Berlin", { role: gme.role });
const gid = gme.user.id as string;
check("viewer reads cameras", (await req("GET", "/v1/sources", { key: guest })).status === 200);
const vw = await req("POST", "/v1/watches", { key: guest, body: {} });
check("viewer can't create a watch", vw.status === 403 && vw.json.error?.code === "forbidden_role", { status: vw.status });
const vk = await req("POST", "/v1/agents", { key: guest, body: { name: "bot" } });
check("viewer can't create keys", vk.status === 403, { status: vk.status });
const promote = await req("PATCH", `/v1/members/${gid}`, { key: owner, body: { role: "member" } });
check("owner promotes the guest to member", promote.status === 200 && promote.json.role === "member");
const mw = await req("POST", "/v1/watches", { key: guest, body: {} });
check("member reaches watch creation (validation, not role)", mw.status === 400, { status: mw.status });
const mi = await req("POST", "/v1/invites", { key: guest, body: { email: `x-${run}@example.test`, role: "viewer" } });
check("member can't invite", mi.status === 403 && mi.json.error?.code === "forbidden_role", { status: mi.status });
const lastOwner = await req("PATCH", `/v1/members/${me.user.id}`, { key: owner, body: { role: "admin" } });
check("the last owner can't step down", lastOwner.status === 409 && lastOwner.json.error?.details?.reason === "last_owner", { status: lastOwner.status });

// 5. Removal and audit.
const members = (await req("GET", "/v1/members", { key: owner })).json.data.map((m: any) => `${m.email}:${m.role}`);
check("members list both people", members.includes(`${ownerEmail}:owner`) && members.includes(`${guestEmail}:member`), { members });
check("owner removes the guest", (await req("DELETE", `/v1/members/${gid}`, { key: owner })).status === 204);
const gone = await req("GET", "/v1/sources", { key: guest });
check("the removed guest's session stops working", gone.status === 401, { status: gone.status });
const actions = new Set((await req("GET", "/v1/audit?limit=100", { key: owner })).json.data.map((e: any) => e.action));
check("audit has the invite and member changes", ["invite.created", "invite.accepted", "member.role_changed", "member.removed"].every((a) => actions.has(a)));

log("done", { failures });
process.exitCode = failures ? 1 : 0;
