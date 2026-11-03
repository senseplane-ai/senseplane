// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Switching devices, only when a person asks (ADR 0067):
// - GET   /v1/devices, /v1/devices/{id}   what can be switched, with its state
// - PATCH /v1/devices/{id}                an admin makes a device controllable
// - POST  /v1/devices/{id}/commands       switch it: checks, audit, the box runs
//                                         it and reads the state back
// - GET   /v1/device-commands/{id}        what happened to a request
// - GET   /v1/confirmations, POST /v1/confirmations/{id}
//                                         a person confirms an agent's request
//                                         for a lock, garage door, gate or alarm
// A command needs a request principal: a signed-in person, a workspace key,
// or an agent with a Control grant on the device's source. Nothing else in
// the API calls into here, so watches, workflows and scheduled jobs can't
// switch anything.
import { randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Selectable } from "kysely";
import { CONTROL, canSense, seesSource } from "../access.js";
import type { AccountScope, DataAccess } from "../data/access.js";
import { newId } from "../data/ids.js";
import type { DeviceCommandStatus, DeviceCommandsTable } from "../data/schema.js";
import {
  ACTIONS, type Action, type DeviceState, type DeviceType, actionText, personChat, actionsOf, checkValue, classify, cleanState, stateFromReading, stateText, warningFor,
} from "../devices.js";
import { ApiError, type ErrorCode } from "../errors.js";
import type { AuditLog } from "../module.js";
import { atLeast } from "../roles.js";
import { BRIDGE_SILENT_SECONDS } from "./bridges.js";

/** A box that hasn't taken a command by then never gets it: "the box is offline", not a queue. */
export const TAKE_MS = 10_000;
/** How long a request waits for the box to report; after that it answers `sent` and can be polled. */
export const WAIT_MS = 15_000;
/** How long a person has to confirm an agent's request. */
export const CONFIRM_MS = 120_000;
/** Commands per device per minute. */
export const PER_MINUTE = 10;

/** Wakes this process's long polls when a command for a box is queued. */
export const bridgeKick = new EventTarget();

type CommandRow = Selectable<DeviceCommandsTable>;

/** Who asked, and through what. There is no internal caller: every request comes from one of these. */
export interface Principal {
  kind: "user" | "account_key" | "agent";
  actor: string;
  id: string;
  name: string | null;
  via: "console" | "app" | "telegram" | "agent" | "api";
  userId?: string;
  agentId?: string;
  /** A Telegram chat's agent: the chat, and the person it belongs to when it qualifies (see personChat). */
  channelId?: string;
  person?: { userId: string; name: string };
}

/** Commands a box took (or should have) this long ago with no report are given up as lost. */
export const LOST_S = 60;
/** The box refuses a command it gets later than its take deadline plus this (clock skew). */
export const RUN_BY_GRACE_MS = 5_000;

export interface DeviceDeps {
  data: DataAccess;
  audit?: AuditLog;
  /** Told about a request waiting for a person (Telegram buttons, ADR 0059). */
  onConfirmation?(accountId: string, command: ReturnType<typeof toCommand>, where: { sourceId: string; ownChannelId?: string }): Promise<void>;
  /** Shorter waits in tests. */
  takeMs?: number;
  waitMs?: number;
  confirmMs?: number;
}

const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export const toCommand = (c: CommandRow) => ({
  id: c.id, device_id: c.device_id, device_name: c.device_name, entity_id: c.entity_id, action: c.action, value: c.value ?? null,
  status: c.status, message: c.message ?? "", state: c.state_after ?? null,
  requested_by: { kind: c.actor_kind, id: c.actor.replace(/^(user|owner|agent):/, ""), name: c.actor_name },
  via: c.via, expires_at: iso(c.expires_at), decided_by: c.decided_by, created_at: iso(c.created_at)!, finished_at: iso(c.finished_at),
});

interface DeviceRow {
  id: string; bridge_id: string; entity_id: string; name: string; area: string | null; device_class: string | null; sense: string;
  source_id: string | null; listed: boolean; controls: string[]; controllable: boolean;
  last_seen_at: Date | null; home_connected: boolean | null; matter_connected: boolean | null;
}

const deviceQuery = (s: AccountScope) => s.db.selectFrom("bridge_entities as e").innerJoin("bridges as b", "b.id", "e.bridge_id")
  .select(["e.id", "e.bridge_id", "e.entity_id", "e.name", "e.area", "e.device_class", "e.sense", "e.source_id", "e.listed", "e.controls", "e.controllable",
    "b.last_seen_at", "b.home_connected", "b.matter_connected"])
  .where("b.revoked_at", "is", null).where("e.source_id", "is not", null).where("e.listed", "=", true);

/** A device the box can still switch: chosen, listed, offering an action, not a never-tier thing. */
const isDevice = (d: DeviceRow) => actionsOf(d).length > 0;

const online = (d: DeviceRow) => {
  const seen = !!d.last_seen_at && Date.now() - new Date(d.last_seen_at).getTime() < BRIDGE_SILENT_SECONDS * 1000;
  const link = d.entity_id.startsWith("matter.") ? d.matter_connected : d.home_connected;
  return seen && link !== false;
};

/** The device's state: its latest reading, or the state the last command read back if that is newer. */
async function stateOf(s: AccountScope, d: DeviceRow): Promise<DeviceState | null> {
  const reading = await s.db.selectFrom("sensor_readings").select(["value", "measured_at"]).where("source_id", "=", d.source_id!)
    .where("device_id", "=", d.entity_id).where("sense", "=", d.sense).orderBy("measured_at", "desc").limit(1).executeTakeFirst();
  const last = await s.db.selectFrom("device_commands").select(["state_after", "finished_at"]).where("device_id", "=", d.id)
    .where("state_after", "is not", null).orderBy("finished_at", "desc").limit(1).executeTakeFirst();
  const fromReading = reading ? stateFromReading(d.sense, reading.value, new Date(reading.measured_at)) : null;
  if (last?.state_after && last.finished_at && (!reading || new Date(last.finished_at) >= new Date(reading.measured_at))) {
    return { ...(cleanState(last.state_after) ?? {}), at: new Date(last.finished_at).toISOString() };
  }
  return fromReading;
}

/** May this caller switch devices at all (before the device's own checks)? */
function callerMay(req: FastifyRequest, d: DeviceRow): boolean {
  const a = req.access!;
  if (a.integrationSource) return false;
  if (a.grants) return canSense(req, d.source_id!, CONTROL);
  if (a.role) return atLeast(a.role, "member");
  return true; // a workspace key
}

async function toDevice(s: AccountScope, req: FastifyRequest, d: DeviceRow) {
  const { type, tier } = classify(d);
  const actions = actionsOf(d);
  return {
    id: d.id, entity_id: d.entity_id, name: d.name, room: d.area, bridge_id: d.bridge_id, source_id: d.source_id!, type, tier,
    controllable: d.controllable, actions, state: await stateOf(s, d), online: online(d),
    can_control: d.controllable && online(d) && callerMay(req, d), warning: warningFor(type),
  };
}

/** The request's principal, read from the API key it came with. */
async function principalOf(req: FastifyRequest, s: AccountScope): Promise<Principal> {
  const a = req.access;
  if (!a || a.integrationSource) throw new ApiError(403, "forbidden", "this token can't switch devices");
  if (a.agentId) {
    const agent = await s.db.selectFrom("agents").select(["name", "kind", "client_name"]).where("id", "=", a.agentId).executeTakeFirst();
    const p: Principal = { kind: "agent", actor: a.actor, id: a.agentId, agentId: a.agentId, name: agent?.client_name ?? agent?.name ?? null, via: agent?.kind === "channel" ? "telegram" : "agent" };
    if (agent?.kind === "channel") {
      const ch = await s.db.selectFrom("channels").select("id").where("agent_id", "=", a.agentId).where("status", "=", "active").executeTakeFirst();
      if (ch) p.channelId = ch.id;
    }
    return p;
  }
  if (a.userId) {
    const user = await s.db.selectFrom("users").select(["name", "email"]).where("id", "=", a.userId).executeTakeFirst();
    const via = String(req.headers["x-senseplane-via"] ?? "").toLowerCase() === "app" ? "app" : "console";
    return { kind: "user", actor: a.actor, id: a.userId, userId: a.userId, name: user?.name ?? user?.email ?? null, via };
  }
  const prefix = a.actor.replace(/^owner:/, "");
  const key = await s.db.selectFrom("api_keys").select("name").where("prefix", "like", `${prefix}%`).where("agent_id", "is", null).where("user_id", "is", null).executeTakeFirst();
  return { kind: "account_key", actor: a.actor, id: prefix, name: key?.name ?? null, via: "api" };
}

export function registerDeviceRoutes(app: FastifyInstance, deps: DeviceDeps) {
  const { data } = deps;
  const takeMs = deps.takeMs ?? TAKE_MS;
  const waitMs = deps.waitMs ?? WAIT_MS;
  const confirmMs = deps.confirmMs ?? CONFIRM_MS;

  const deviceOf = async (s: AccountScope, req: FastifyRequest, id: string) => {
    const d = await deviceQuery(s).where("e.id", "=", id).executeTakeFirst() as DeviceRow | undefined;
    // An agent learns nothing about devices on sources it can't see.
    if (!d || !isDevice(d) || !seesSource(req, d.source_id!)) throw new ApiError(404, "not_found", "device not found");
    return d;
  };

  const audit = (accountId: string, c: CommandRow, status: number) => deps.audit?.write({
    accountId, actor: c.actor, action: `device.command_${c.status}`, target: c.device_id, status,
    details: {
      command: c.id, device: c.device_name, entity_id: c.entity_id, action: c.action, value: c.value ?? null, tier: c.tier,
      by: c.actor_name, via: c.via, outcome: c.status, state_after: c.state_after ?? null, ...(c.decided_by ? { decided_by: c.decided_by } : {}),
    },
  }).catch(() => undefined);

  app.get("/v1/devices", async (req) => {
    const out = await data.withAccount(req.accountId!, async (s) => {
      const rows = (await deviceQuery(s).orderBy("e.area").orderBy("e.name").execute() as DeviceRow[]).filter((d) => isDevice(d) && seesSource(req, d.source_id!));
      return Promise.all(rows.map((d) => toDevice(s, req, d)));
    });
    return { data: out, next_cursor: null };
  });

  app.get<{ Params: { id: string } }>("/v1/devices/:id", async (req) =>
    data.withAccount(req.accountId!, async (s) => toDevice(s, req, await deviceOf(s, req, req.params.id))));

  // Off by default: a plug that powers a heater isn't switched by accident.
  app.patch<{ Params: { id: string }; Body: { controllable: boolean } }>(
    "/v1/devices/:id",
    { schema: { body: { type: "object", additionalProperties: false, required: ["controllable"], properties: { controllable: { type: "boolean" } } } } },
    async (req) => {
      if (req.access?.grants) throw new ApiError(403, "forbidden", "agents can't change which devices are controllable");
      const out = await data.withAccount(req.accountId!, async (s) => {
        const d = await deviceOf(s, req, req.params.id);
        await s.db.updateTable("bridge_entities").set({ controllable: req.body.controllable, controllable_by: req.access!.actor, controllable_at: new Date() })
          .where("id", "=", d.id).execute();
        return toDevice(s, req, { ...d, controllable: req.body.controllable });
      });
      await deps.audit?.write({ accountId: req.accountId!, actor: req.access!.actor, action: req.body.controllable ? "device.made_controllable" : "device.made_uncontrollable",
        target: out.id, status: 200, details: { device: out.name, entity_id: out.entity_id } });
      return out;
    },
  );

  /** Records an attempt that goes no further, and refuses it. */
  const refuse = async (accountId: string, base: Omit<CommandRow, "status" | "message" | "finished_at">, status: number, code: ErrorCode, message: string): Promise<never> => {
    const row = await data.withAccount(accountId, (s) => s.db.insertInto("device_commands")
      .values({ ...base, value: base.value === null ? null : JSON.stringify(base.value), state_after: null, status: "refused", message, finished_at: new Date() })
      .returningAll().executeTakeFirstOrThrow());
    await audit(accountId, row, status);
    throw new ApiError(status, code, message, { command: toCommand(row) });
  };

  /** Hands the command to the box and waits for what it read back; see TAKE_MS and WAIT_MS. */
  const dispatch = async (accountId: string, c: CommandRow): Promise<CommandRow> => {
    const bcId = `bcm_${randomBytes(9).toString("base64url")}`;
    const expires = new Date(Date.now() + takeMs);
    await data.withAccount(accountId, async (s) => {
      await s.db.insertInto("bridge_commands").values({
        id: bcId, account_id: accountId, bridge_id: c.bridge_id, kind: "device_control", created_by: c.actor, expires_at: expires,
        // run_by: a box that gets this later (a slow network, a clock far off) refuses it rather than run it late.
        args_sealed: data.box().encrypt(JSON.stringify({
          entity_id: c.entity_id, action: c.action, ...(c.value !== null ? { value: c.value } : {}), run_by: new Date(expires.getTime() + RUN_BY_GRACE_MS).toISOString(),
        })),
      }).execute();
      await s.db.updateTable("device_commands").set({ status: "sent", bridge_command_id: bcId, message: "Sent to the box." }).where("id", "=", c.id).execute();
    });
    bridgeKick.dispatchEvent(new Event(c.bridge_id));
    const until = Date.now() + waitMs;
    for (;;) {
      await new Promise((r) => setTimeout(r, 150));
      const now = await data.withAccount(accountId, (s) => s.db.selectFrom("device_commands").selectAll().where("id", "=", c.id).executeTakeFirstOrThrow());
      if (now.status !== "sent") return now;
      if (Date.now() >= expires.getTime()) {
        // Not taken in time: expire it, so the box can never run it later.
        const gone = await data.withAccount(accountId, (s) => s.db.updateTable("bridge_commands").set({ status: "expired", args_sealed: null, finished_at: new Date() })
          .where("id", "=", bcId).where("status", "=", "pending").executeTakeFirst());
        if (gone.numUpdatedRows) {
          const off = await data.withAccount(accountId, (s) => s.db.updateTable("device_commands").set({
            status: "offline", finished_at: new Date(),
            message: `${cap(c.device_name)}'s box didn't take the command within ${Math.round(takeMs / 1000)} seconds, so it wasn't sent and won't run later. The box may be offline.`,
          }).where("id", "=", c.id).where("status", "=", "sent").returningAll().executeTakeFirst());
          if (off) {
            await audit(accountId, off, 503);
            return off;
          }
        }
      }
      if (Date.now() >= until) return now;
    }
  };

  /** The answer for a command row: 200 with the state read back, 202 while waiting, an error otherwise. */
  const answer = (c: CommandRow) => {
    const body = toCommand(c);
    switch (c.status) {
      case "done": case "in_progress": case "unchanged": return { code: 200, body };
      case "awaiting_confirmation": case "sent": return { code: 202, body };
      case "offline": throw new ApiError(503, "device_offline", c.message ?? "the box is offline", { command: body });
      case "failed": throw new ApiError(502, "device_failed", c.message ?? "the box couldn't do it", { command: body });
      case "expired": throw new ApiError(409, "confirmation_expired", c.message ?? "nobody confirmed in time", { command: body });
      case "denied": throw new ApiError(409, "confirmation_denied", c.message ?? "a person said no", { command: body });
      default: throw new ApiError(403, "forbidden", c.message ?? "refused", { command: body });
    }
  };

  app.post<{ Params: { id: string }; Body: { action: Action; value?: number | string | null; confirm?: boolean } }>(
    "/v1/devices/:id/commands",
    { schema: { body: { type: "object", additionalProperties: false, required: ["action"], properties: {
      action: { enum: [...ACTIONS] }, value: { type: ["number", "string", "null"] }, confirm: { type: "boolean" },
    } } } },
    async (req, reply) => {
      const accountId = req.accountId!;
      const { d, p, tier } = await data.withAccount(accountId, async (s) => {
        const d = await deviceOf(s, req, req.params.id);
        return { d, p: await principalOf(req, s), ...classify(d) };
      });
      const action = req.body.action;
      if (!actionsOf(d).includes(action)) throw new ApiError(400, "validation_failed", `${d.name} can't ${action.replace(/_/g, " ")}; it offers ${actionsOf(d).join(", ")}`);
      const checked = checkValue(action, req.body.value);
      if ("error" in checked) throw new ApiError(400, "validation_failed", checked.error);
      const base = {
        id: newId("dcm"), account_id: accountId, device_id: d.id, bridge_id: d.bridge_id, entity_id: d.entity_id, device_name: d.name,
        action, value: checked.value, tier, actor: p.actor, actor_kind: p.kind, actor_name: p.name, via: p.via,
        state_after: null, bridge_command_id: null, expires_at: null, decided_by: null, decided_at: null, created_at: new Date(),
        agent_id: p.agentId ?? null, channel_id: p.channelId ?? null,
      };
      if (!d.controllable) await refuse(accountId, base, 409, "not_controllable", `${cap(d.name)} isn't controllable. An admin can make it controllable on the Devices page.`);
      if (req.access?.grants && !canSense(req, d.source_id!, CONTROL)) {
        await refuse(accountId, base, 403, "forbidden_sense", `This agent has no Control permission for ${d.name}. A person can give it one on the Agents page.`);
      }

      const asked = actionText(action, d.name, checked.value);
      if (tier === "secure" && p.kind === "user" && !req.body.confirm) {
        // A person confirms their own request in the app; nothing is recorded until they do.
        throw new ApiError(409, "confirmation_required", `Confirm to ${asked}.`, { action, device_id: d.id });
      }
      // A person asking in their own Telegram chat: the chat's buttons are their "are you sure", and it is their request.
      const person = p.channelId && tier === "secure" ? await data.withAccount(accountId, (s) => personChat(s, p.channelId!, d.source_id!)) : undefined;
      const waits = tier === "secure" && p.kind !== "user";
      const value = checked.value === null ? null : JSON.stringify(checked.value);
      const row = waits
        ? {
          ...base, value, status: "awaiting_confirmation" as const, expires_at: new Date(Date.now() + confirmMs),
          ...(person ? { actor: `user:${person.userId}`, actor_kind: "user" as const, actor_name: person.name } : {}),
          message: person
            ? `Confirm in this chat to ${asked}, within ${Math.round(confirmMs / 60_000)} minutes.`
            : `Waiting for a person to confirm: ${asked}. They have ${Math.round(confirmMs / 60_000)} minutes.`,
        }
        : { ...base, value, status: "sent" as const, message: checked.clamped ? `Set to ${checked.value} °C, the nearest safe setting.` : null };
      // Counted and recorded under a lock on the device, so concurrent requests can't all slip under the limit.
      const admitted = await data.withAccount(accountId, async (s) => {
        await s.db.selectFrom("bridge_entities").select("id").where("id", "=", d.id).forUpdate().executeTakeFirst();
        const recent = Number((await s.db.selectFrom("device_commands").select((e) => e.fn.countAll().as("n"))
          .where("device_id", "=", d.id).where("status", "!=", "refused").where("created_at", ">", new Date(Date.now() - 60_000)).executeTakeFirstOrThrow()).n);
        if (recent >= PER_MINUTE) {
          const message = `${cap(d.name)} has had ${PER_MINUTE} commands in the last minute, the most allowed. Try again shortly.`;
          return { limited: await s.db.insertInto("device_commands").values({ ...row, status: "refused", message, expires_at: null, finished_at: new Date() }).returningAll().executeTakeFirstOrThrow() };
        }
        return { row: await s.db.insertInto("device_commands").values(row).returningAll().executeTakeFirstOrThrow() };
      });
      if (admitted.limited) {
        await audit(accountId, admitted.limited, 429);
        throw new ApiError(429, "rate_limited", admitted.limited.message!, { command: toCommand(admitted.limited) });
      }
      const made = admitted.row!;
      if (waits) {
        await audit(accountId, made, 202);
        await deps.onConfirmation?.(accountId, toCommand(made), { sourceId: d.source_id!, ...(person ? { ownChannelId: p.channelId } : {}) }).catch(() => undefined);
        const out = answer(made);
        return reply.code(out.code).send(out.body);
      }
      const out = answer(await dispatch(accountId, made));
      return reply.code(out.code).send(out.body);
    },
  );

  app.get<{ Params: { id: string } }>("/v1/device-commands/:id", async (req) => {
    const row = await data.withAccount(req.accountId!, async (s) => {
      await expireOld(s);
      return s.db.selectFrom("device_commands").selectAll().where("id", "=", req.params.id).executeTakeFirst();
    });
    // An agent sees only its own requests.
    if (!row || (req.access?.agentId && row.agent_id !== req.access.agentId)) throw new ApiError(404, "not_found", "command not found");
    return toCommand(row);
  });

  /** Refuses this account's requests nobody confirmed in time. */
  const expireOld = async (s: AccountScope) => {
    const rows = await s.db.updateTable("device_commands").set({ status: "expired", finished_at: new Date(), message: "Nobody confirmed in time, so this wasn't done." })
      .where("status", "=", "awaiting_confirmation").where("expires_at", "<", new Date()).returningAll().execute();
    for (const r of rows) await audit(s.accountId, r, 409);
    return rows.length;
  };

  app.get("/v1/confirmations", async (req) => {
    const rows = await data.withAccount(req.accountId!, async (s) => {
      await expireOld(s);
      return s.db.selectFrom("device_commands").selectAll().where("status", "=", "awaiting_confirmation").orderBy("created_at").execute();
    });
    return { data: rows.map(toCommand), next_cursor: null };
  });

  // Only a person: agents can't reach this route (access.ts), and workspace keys are code, not people.
  app.post<{ Params: { id: string }; Body: { approve: boolean } }>(
    "/v1/confirmations/:id",
    { schema: { body: { type: "object", additionalProperties: false, required: ["approve"], properties: { approve: { type: "boolean" } } } } },
    async (req, reply) => {
      const a = req.access!;
      if (a.grants || !a.userId) throw new ApiError(403, "forbidden", "Only a person signed in to Senseplane can confirm a request.");
      const name = await data.withAccount(req.accountId!, async (s) => {
        const u = await s.db.selectFrom("users").select(["name", "email"]).where("id", "=", a.userId!).executeTakeFirst();
        return u?.name ?? u?.email ?? a.actor;
      });
      const out = answer(await decide(req.accountId!, req.params.id, req.body.approve, { actor: a.actor, name }));
      return reply.code(out.code).send(out.body);
    },
  );

  /** A person's answer to a waiting request: approved, it runs now; otherwise it is refused. */
  const decide = async (accountId: string, id: string, approve: boolean, by: { actor: string; name: string }): Promise<CommandRow> => {
    const row = await data.withAccount(accountId, async (s) => {
      await expireOld(s);
      const c = await s.db.selectFrom("device_commands").selectAll().where("id", "=", id).executeTakeFirst();
      if (!c) throw new ApiError(404, "not_found", "confirmation not found");
      // An agent or a key can't confirm its own request; a person's own request is theirs to confirm.
      if (c.actor_kind !== "user" && c.actor === by.actor) throw new ApiError(403, "forbidden", "A request can't be confirmed by whoever made it.");
      if (c.status === "expired") throw new ApiError(409, "confirmation_expired", c.message ?? "Nobody confirmed in time, so this wasn't done.", { command: toCommand(c) });
      if (c.status !== "awaiting_confirmation") throw new ApiError(409, "conflict", `This request was already answered (${c.status.replace(/_/g, " ")}).`, { command: toCommand(c) });
      const d = await deviceQuery(s).where("e.id", "=", c.device_id).executeTakeFirst() as DeviceRow | undefined;
      const why = !d || !d.controllable || !isDevice(d) ? `${cap(c.device_name)} isn't controllable any more, so this wasn't done.` : await stillAllowed(s, c, d.source_id!);
      const status: DeviceCommandStatus = !approve ? "denied" : why ? "refused" : "sent";
      const message = !approve ? `${by.name} said no, so this wasn't done.` : why ?? `Confirmed by ${by.name}.`;
      const done = status !== "sent";
      // Only the call that moves the row on runs it: a second tap, or a refusal after an approval, finds nothing to move.
      const moved = await s.db.updateTable("device_commands").set({ status, message, decided_by: by.name, decided_at: new Date(), ...(done ? { finished_at: new Date() } : {}) })
        .where("id", "=", id).where("status", "=", "awaiting_confirmation").returningAll().executeTakeFirst();
      if (!moved) throw new ApiError(409, "conflict", "This request was already answered.", { command: toCommand(c) });
      return moved;
    });
    if (row.status !== "sent") {
      await audit(accountId, row, 409);
      return row;
    }
    await deps.audit?.write({ accountId, actor: by.actor, action: "device.command_confirmed", target: row.device_id, status: 200,
      details: { command: row.id, device: row.device_name, action: row.action, requested_by: row.actor_name, via: row.via, decided_by: by.name } }).catch(() => undefined);
    return dispatch(accountId, row);
  };

  /** Why a waiting request may no longer run: its agent was revoked or lost Control, or its key was revoked. */
  const stillAllowed = async (s: AccountScope, c: CommandRow, sourceId: string): Promise<string | undefined> => {
    if (c.agent_id) {
      const agent = await s.db.selectFrom("agents").select("id").where("id", "=", c.agent_id).where("revoked_at", "is", null).executeTakeFirst();
      const now = new Date();
      const grants = agent ? await s.db.selectFrom("grants").select(["source_ids", "senses", "window_from", "window_to"]).where("agent_id", "=", c.agent_id).execute() : [];
      const ok = grants.some((g) => g.source_ids.includes(sourceId) && g.senses.includes(CONTROL) && (!g.window_from || g.window_from <= now) && (!g.window_to || g.window_to >= now));
      if (!ok) return `${c.actor_name ?? "The agent"} no longer has Control permission for ${c.device_name}, so this wasn't done.`;
    }
    if (c.actor_kind === "account_key") {
      const prefix = c.actor.replace(/^owner:/, "");
      const key = await s.db.selectFrom("api_keys").select("id").where("prefix", "like", `${prefix}%`).where("agent_id", "is", null).where("user_id", "is", null).where("revoked_at", "is", null).executeTakeFirst();
      if (!key) return "The key that asked for this was revoked, so this wasn't done.";
    }
    return undefined;
  };

  return { decide };
}

/** The box's report on a device command (POST /v1/bridge/commands/{id}): what the state is now. */
export async function finishDeviceCommand(data: DataAccess, accountId: string, bridgeCommandId: string, ok: boolean, result: Record<string, unknown> | undefined, error: string | undefined, audit?: AuditLog) {
  const row = await data.withAccount(accountId, async (s) => {
    const c = await s.db.selectFrom("device_commands").selectAll().where("bridge_command_id", "=", bridgeCommandId).where("status", "=", "sent").executeTakeFirst();
    if (!c) return undefined;
    const d = await s.db.selectFrom("bridge_entities").select(["entity_id", "name", "sense", "device_class", "controls"]).where("id", "=", c.device_id).executeTakeFirst();
    const type: DeviceType = d ? classify(d).type : "switch";
    const state = ok ? cleanState(result?.state) : null;
    const name = cap(c.device_name);
    let status: DeviceCommandStatus;
    let message: string;
    if (!ok) {
      status = "failed";
      message = `The box couldn't ${actionText(c.action as Action, c.device_name, c.value ?? null)}: ${error ?? "it failed"}`;
    } else if (result?.reached === true) {
      status = "done";
      message = `${name} is ${stateText(type, state)}.`;
    } else if (result?.changed === true) {
      status = "in_progress";
      message = `Sent; ${c.device_name} is ${stateText(type, state)} for now.`;
    } else {
      status = "unchanged";
      message = `Sent, but ${c.device_name} still reads ${stateText(type, state)}.`;
    }
    if (c.message && status === "done" && /nearest safe/.test(c.message)) message = `${message} ${c.message}`;
    return s.db.updateTable("device_commands").set({ status, message, state_after: state ? JSON.stringify(state) : null, finished_at: new Date() })
      .where("id", "=", c.id).where("status", "=", "sent").returningAll().executeTakeFirst();
  });
  if (row) {
    await audit?.write({
      accountId, actor: row.actor, action: `device.command_${row.status}`, target: row.device_id, status: 200,
      details: { command: row.id, device: row.device_name, entity_id: row.entity_id, action: row.action, value: row.value ?? null, tier: row.tier,
        by: row.actor_name, via: row.via, outcome: row.status, state_after: row.state_after ?? null, ...(row.decided_by ? { decided_by: row.decided_by } : {}) },
    }).catch(() => undefined);
  }
}

/**
 * Gives up on device commands a box took (or should have taken) more than LOST_S ago and never reported:
 * the request reads failed, and its box command can no longer be handed out or reported. Never sends anything.
 */
export async function sweepLostCommands(data: DataAccess, audit?: AuditLog, seconds = LOST_S) {
  const due = await data.stuckDeviceCommands(seconds);
  for (const r of due) {
    const row = await data.withAccount(r.account_id, async (s) => {
      const c = await s.db.updateTable("device_commands").set({
        status: "failed", finished_at: new Date(),
        message: "The box never said what happened, so it may or may not have run. Check the device before asking again.",
      }).where("id", "=", r.id).where("status", "=", "sent").returningAll().executeTakeFirst();
      if (c?.bridge_command_id) {
        await s.db.updateTable("bridge_commands").set({ status: "failed", args_sealed: null, error: "lost: no report from the box", finished_at: new Date() })
          .where("id", "=", c.bridge_command_id).where("status", "in", ["pending", "taken"]).execute();
      }
      return c;
    });
    if (row) {
      await audit?.write({ accountId: r.account_id, actor: row.actor, action: "device.command_failed", target: row.device_id, status: 504,
        details: { command: row.id, device: row.device_name, action: row.action, by: row.actor_name, via: row.via, outcome: "lost" } }).catch(() => undefined);
    }
  }
  return due.length;
}

/** Refuses requests nobody confirmed in time, across accounts (the API's periodic loop); it never sends anything. */
export async function expireConfirmations(data: DataAccess, audit?: AuditLog) {
  const due = (await data.expiredConfirmations()) as { id: string; account_id: string }[];
  for (const r of due) {
    const row = await data.withAccount(r.account_id, (s) => s.db.updateTable("device_commands")
      .set({ status: "expired", finished_at: new Date(), message: "Nobody confirmed in time, so this wasn't done." })
      .where("id", "=", r.id).where("status", "=", "awaiting_confirmation").returningAll().executeTakeFirst());
    if (row) {
      await audit?.write({ accountId: r.account_id, actor: row.actor, action: "device.command_expired", target: row.device_id, status: 409,
        details: { command: row.id, device: row.device_name, action: row.action, by: row.actor_name, via: row.via, outcome: "expired" } }).catch(() => undefined);
    }
  }
  return due.length;
}
