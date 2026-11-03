// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// What a device is and what may be done to it (ADR 0067). A device is an
// entity a box lists with the actions it can run (Home Assistant's
// `light.hall`, a Matter node's `matter.n4_e1_switch`). Its type decides its
// tier: switch (runs when allowed), secure (locks, garage doors, gates and
// alarms: an agent's request waits for a person) or never (heaters, ovens,
// medical devices and machinery are not offered at all). Nothing here sends
// anything; routes/devices.ts does, and only for a person or an agent a
// person granted Control.

import type { AccountScope } from "./data/access.js";
import { atLeast } from "./roles.js";

export const ACTIONS = [
  "turn_on", "turn_off", "set_brightness", "open", "close", "set_position",
  "set_temperature", "set_mode", "lock", "unlock", "arm_away", "arm_home", "disarm",
] as const;
export type Action = (typeof ACTIONS)[number];

export const MODES = ["off", "heat", "cool", "auto", "heat_cool", "dry", "fan_only"] as const;
/** A thermostat is never set outside this range (°C). */
export const MIN_SETPOINT = 10;
export const MAX_SETPOINT = 28;

export type DeviceType = "light" | "switch" | "fan" | "siren" | "cover" | "garage_door" | "gate" | "climate" | "lock" | "alarm";
export type Tier = "switch" | "secure" | "never";

const ALLOWED: Record<DeviceType, readonly Action[]> = {
  light: ["turn_on", "turn_off", "set_brightness"],
  switch: ["turn_on", "turn_off"],
  fan: ["turn_on", "turn_off"],
  siren: ["turn_on", "turn_off"],
  cover: ["open", "close", "set_position"],
  garage_door: ["open", "close", "set_position"],
  gate: ["open", "close", "set_position"],
  climate: ["set_temperature", "set_mode"],
  lock: ["lock", "unlock"],
  alarm: ["arm_away", "arm_home", "disarm"],
};
const SECURE = new Set<DeviceType>(["lock", "garage_door", "gate", "alarm"]);

/** Home Assistant domains that are never offered, whatever the box says it can do. */
const NEVER_DOMAINS = new Set(["water_heater", "vacuum", "lawn_mower", "valve", "humidifier", "remote", "button", "number", "select", "scene", "script", "automation"]);
/** Device classes and Matter device types of things that can hurt someone. */
const NEVER_CLASSES = new Set([
  "water_heater", "heater", "space_heater", "oven", "microwave_oven", "cooktop", "cook_surface", "extractor_hood", "heat_pump",
  "laundry_washer", "laundry_dryer", "dishwasher", "robot_vacuum_cleaner", "evse", "pump", "pump_controller", "irrigation", "medical",
]);
/** The same by part of a device class, as the bridge checks it (heat_pump, robotic_vacuum_cleaner, laundry_washer). */
const NEVER_CLASS_WORDS = /heater|heating|heat_pump|boiler|oven|cook|stove|hob|kettle|fryer|grill|microwave|extractor|washer|dryer|dishwasher|vacuum|mower|pump|valve|evse|charger|medical|oxygen|machine|sauna/;
/** Names of things that open a home: garage, gate, door, lock. */
const OPENER_WORDS = /(^|[^a-z])(garage|gates?|doors?|locks?)([^a-z]|$)/i;
/** Names that say heater, oven or machine: not offered, even on a plain plug. The controllable switch's warning covers the rest. */
const NEVER_WORDS = /\b(heaters?|heating|radiators?|ovens?|stoves?|cooktops?|hobs?|kettles?|irons?|boilers?|furnaces?|saunas?|grills?|fryers?|toasters?|blankets?|medical|oxygen|ventilators?|insulin|pumps?|saws?|drills?|lathes?|welders?|compressors?|heat lamps?)\b/i;

export interface DeviceEntity {
  entity_id: string;
  name: string;
  sense: string;
  device_class: string | null;
  controls: string[];
}

/** A device's type and tier, from its domain (or, for Matter, its sense), device class and name. */
export function classify(e: DeviceEntity): { type: DeviceType; tier: Tier } {
  const [domain = ""] = e.entity_id.split(".");
  const dc = (e.device_class ?? "").toLowerCase();
  const type = typeOf(domain, e.sense, dc);
  if (!type || NEVER_DOMAINS.has(domain) || NEVER_CLASSES.has(dc) || NEVER_CLASS_WORDS.test(dc) || NEVER_WORDS.test(e.name) || NEVER_WORDS.test(e.entity_id.replace(/[._]/g, " "))) {
    return { type: type ?? "switch", tier: "never" };
  }
  // A plain switch, relay or cover named for a garage door, gate, door or lock (a Shelly on a garage motor, a
  // Matter blind that is really a gate) is treated as one: promoted to secure, never demoted.
  const opens = (type === "cover" && dc === "door") || (type === "switch" || type === "cover") && (OPENER_WORDS.test(e.name) || OPENER_WORDS.test(e.entity_id.replace(/[._]/g, " ")));
  return { type, tier: SECURE.has(type) || opens ? "secure" : "switch" };
}

function typeOf(domain: string, sense: string, dc: string): DeviceType | undefined {
  if (domain === "matter") {
    if (sense === "switch") return /light/.test(dc) ? "light" : /fan/.test(dc) ? "fan" : "switch";
    if (sense === "lock") return "lock";
    if (sense === "cover") return "cover";
    if (sense === "setpoint") return "climate";
    return undefined;
  }
  switch (domain) {
    case "light": return "light";
    case "switch": case "input_boolean": return "switch";
    case "fan": return "fan";
    case "siren": return "siren";
    case "cover": return dc === "garage" ? "garage_door" : dc === "gate" ? "gate" : "cover";
    case "climate": return "climate";
    case "lock": return "lock";
    case "alarm_control_panel": return "alarm";
  }
  return undefined;
}

/** What may be asked of a device: what its box can do, within what its type allows. */
export function actionsOf(e: DeviceEntity): Action[] {
  const { type, tier } = classify(e);
  if (tier === "never") return [];
  return ALLOWED[type].filter((a) => e.controls.includes(a));
}

/** Checks a command's value; a thermostat setting is clamped to the safe range. */
export function checkValue(action: Action, value: unknown): { value: number | string | null; clamped?: boolean } | { error: string } {
  switch (action) {
    case "set_brightness":
    case "set_position":
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) return { error: `${action} takes a value from 0 to 100 (percent)` };
      return { value: Math.round(value) };
    case "set_temperature": {
      if (typeof value !== "number" || !Number.isFinite(value)) return { error: "set_temperature takes a temperature in °C" };
      const v = Math.round(Math.min(MAX_SETPOINT, Math.max(MIN_SETPOINT, value)) * 2) / 2;
      return { value: v, ...(v !== value ? { clamped: true } : {}) };
    }
    case "set_mode":
      if (typeof value !== "string" || !(MODES as readonly string[]).includes(value)) return { error: `set_mode takes one of ${MODES.join(", ")}` };
      return { value };
    default:
      if (value !== undefined && value !== null) return { error: `${action} takes no value` };
      return { value: null };
  }
}

/** Shown before a person makes a device controllable. */
export function warningFor(type: DeviceType): string {
  switch (type) {
    case "switch":
      return "Only make this controllable if nothing that could hurt someone is plugged into it or wired to it: no heaters, irons, cookers, medical devices or machinery. If it opens a garage door, gate or door, name it so (\"Garage door\"): then every request is confirmed by a person.";
    case "light":
    case "fan":
      return "People in your workspace, and agents you give the Control permission, will be able to switch this. Make sure nothing else is wired to it.";
    case "siren":
      return "A siren can frighten people and disturb neighbours. Agents with the Control permission will be able to sound it.";
    case "cover":
      return "Blinds and covers can trap fingers or pets as they move. Agents with the Control permission will be able to move them. If this opens a door or gate, name it so: then every request is confirmed by a person.";
    case "climate":
      return "Agents with the Control permission can set this between 10 and 28 °C and change its mode.";
    case "lock":
    case "garage_door":
    case "gate":
      return "This opens your home. A request from an agent always waits for a person to confirm it, and people confirm their own.";
    case "alarm":
      return "Disarming the alarm lowers your protection. A request from an agent always waits for a person to confirm it.";
  }
}

/** A device's state, as the box reads it back (all optional). */
export interface DeviceState {
  available?: boolean;
  on?: boolean;
  brightness?: number;
  open?: boolean;
  position?: number;
  moving?: string;
  target_temperature?: number;
  mode?: string;
  locked?: boolean;
  alarm?: string;
  at?: string;
}

/** The state a stored reading says (the device's own sense). */
export function stateFromReading(sense: string, value: number, at: Date): DeviceState {
  const out: DeviceState = { at: at.toISOString() };
  if (sense === "switch") out.on = value === 1;
  else if (sense === "lock") out.locked = value === 0; // the lock sense is true when unlocked (ADR 0060)
  else if (sense === "cover") out.open = value === 1;
  else if (sense === "alarm") out.alarm = value === 1 ? "armed" : "disarmed";
  else if (sense === "setpoint") out.target_temperature = value;
  return out;
}

/** Only the known fields of a state the box sent, so nothing else is stored or shown. */
export function cleanState(raw: unknown): DeviceState | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const out: DeviceState = {};
  const num = (k: "brightness" | "position" | "target_temperature") => {
    if (typeof r[k] === "number" && Number.isFinite(r[k])) out[k] = r[k] as number;
  };
  const bool = (k: "available" | "on" | "open" | "locked") => {
    if (typeof r[k] === "boolean") out[k] = r[k] as boolean;
  };
  const word = (k: "moving" | "mode" | "alarm") => {
    if (typeof r[k] === "string" && /^[a-z_]{1,40}$/.test(r[k] as string)) out[k] = r[k] as string;
  };
  bool("available"); bool("on"); bool("open"); bool("locked");
  num("brightness"); num("position"); num("target_temperature");
  word("moving"); word("mode"); word("alarm");
  return out;
}

const words = (s: string) => s.replace(/_/g, " ");

/** The state in a few words: "on at 80%", "locked", "set to 21 °C (heat)". */
export function stateText(type: DeviceType, s: DeviceState | null): string {
  if (!s) return "unknown";
  if (s.available === false) return "unavailable";
  switch (type) {
    case "light":
      if (s.on === false) return "off";
      return s.brightness !== undefined ? `on at ${s.brightness}%` : s.on ? "on" : "unknown";
    case "switch":
    case "fan":
    case "siren":
      return s.on === undefined ? "unknown" : s.on ? "on" : "off";
    case "cover":
    case "garage_door":
    case "gate":
      if (s.moving) return words(s.moving);
      if (s.position !== undefined && s.position > 0 && s.position < 100) return `${s.position}% open`;
      return s.open === undefined && s.position === undefined ? "unknown" : (s.open ?? s.position! > 0) ? "open" : "closed";
    case "climate":
      return s.target_temperature === undefined ? (s.mode ? words(s.mode) : "unknown") : `set to ${s.target_temperature} °C${s.mode ? ` (${words(s.mode)})` : ""}`;
    case "lock":
      return s.locked === undefined ? "unknown" : s.locked ? "locked" : "unlocked";
    case "alarm":
      return s.alarm ? words(s.alarm) : "unknown";
  }
}

/** What the action asks for, in words: "turn Hall light on". */
export function actionText(action: Action, name: string, value: number | string | null): string {
  switch (action) {
    case "turn_on": return `turn ${name} on`;
    case "turn_off": return `turn ${name} off`;
    case "set_brightness": return `set ${name} to ${value}%`;
    case "open": return `open ${name}`;
    case "close": return `close ${name}`;
    case "set_position": return `set ${name} to ${value}% open`;
    case "set_temperature": return `set ${name} to ${value} °C`;
    case "set_mode": return `set ${name} to ${words(String(value))}`;
    case "lock": return `lock ${name}`;
    case "unlock": return `unlock ${name}`;
    case "arm_away": return `arm ${name} (away)`;
    case "arm_home": return `arm ${name} (home)`;
    case "disarm": return `disarm ${name}`;
  }
}

/**
 * A Telegram chat that may confirm requests for a device (ADR 0067): a private
 * chat, still linked, linked by someone who is still a member or above, whose
 * agent has a grant on the device's source. Returns that person, else undefined.
 */
export async function personChat(s: AccountScope, channelId: string, sourceId: string): Promise<{ userId: string; name: string; agentId: string } | undefined> {
  const ch = await s.db.selectFrom("channels").select(["chat_type", "status", "linked_by", "agent_id"]).where("id", "=", channelId).executeTakeFirst();
  if (!ch || ch.chat_type !== "private" || ch.status !== "active" || !ch.linked_by) return undefined;
  const member = await s.db.selectFrom("memberships").select("role").where("user_id", "=", ch.linked_by).where("account_id", "=", s.accountId).executeTakeFirst();
  if (!member || !atLeast(member.role, "member")) return undefined;
  const agent = await s.db.selectFrom("agents").select("id").where("id", "=", ch.agent_id).where("revoked_at", "is", null).executeTakeFirst();
  if (!agent) return undefined;
  const grants = await s.db.selectFrom("grants").select("source_ids").where("agent_id", "=", ch.agent_id).execute();
  if (!grants.some((g) => g.source_ids.includes(sourceId))) return undefined;
  const u = await s.db.selectFrom("users").select(["name", "email"]).where("id", "=", ch.linked_by).executeTakeFirst();
  return { userId: ch.linked_by, name: u?.name ?? u?.email ?? "someone", agentId: ch.agent_id };
}
