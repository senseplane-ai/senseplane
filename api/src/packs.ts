// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Packs (ADR 0057): ready-made sets of watches for a use case, added in one
// step on the chosen cameras. Most are plain sentences, compiled like any
// watch (zones named in them are used when the camera has them); conditions
// and digests are given compiled, and a digest summarises the pack's own
// tracking watches.
import type { ActivityQuery } from "./activity-query.js";

export interface PackItem {
  key: string;
  instruction: string;
  mode: "alert" | "track";
  /** Given compiled (conditions, digests); `ids` are the watches made from this pack's earlier items, by key. */
  compiled?: (ids: Record<string, string>) => Record<string, unknown>;
  /** Wall-clock hours, in the time zone the pack is added in. */
  hours?: { from: string; to: string };
}

export interface Pack {
  id: string;
  name: string;
  description: string;
  items: PackItem[];
}

const person = (zone?: string): ActivityQuery["what"] => ({ label: "person", ...(zone ? { zone } : {}) });
const condition = (query: ActivityQuery, test: Record<string, unknown>, when: Record<string, unknown>) =>
  ({ trigger: { type: "condition", query, test, ...when }, cooldown_s: 0, active_hours: null });
const digest = (at: string, items: { label: string; query: ActivityQuery }[]) =>
  ({ trigger: { type: "digest", at, items }, cooldown_s: 0, active_hours: null });

export const PACKS: Pack[] = [
  {
    id: "eldercare",
    name: "Looking after someone at home",
    description: "Keeps track of meals, medication and rest, tells you about a fall, a smoke alarm or a long quiet spell, and sends a summary of the day.",
    items: [
      { key: "meals", instruction: "Track when someone is eating at the table", mode: "track" },
      { key: "pills", instruction: "Track when someone takes pills or medication", mode: "track" },
      { key: "bed", instruction: "Track when someone is lying in bed", mode: "track" },
      { key: "fall", instruction: "Tell me if someone is lying on the floor", mode: "alert" },
      { key: "alarm", instruction: "Tell me if a smoke alarm goes off", mode: "alert" },
      {
        key: "quiet", instruction: "Tell me if no one has been seen for 3 hours during the day", mode: "alert", hours: { from: "08:00", to: "22:00" },
        compiled: () => condition({ measure: "since_last", what: person() }, { op: "gte", value: 3 * 3600 }, { every_min: 10 }),
      },
      {
        key: "up", instruction: "Tell me if no one is up and about by 10:00", mode: "alert",
        compiled: () => condition({ measure: "count", what: person(), between: { from: "05:00", to: "10:00" } }, { op: "eq", value: 0 }, { at: "10:00" }),
      },
      {
        key: "day", instruction: "A summary of the day", mode: "alert",
        compiled: (ids) => digest("20:00", [
          { label: "First seen", query: { measure: "first", what: person() } },
          { label: "Meals", query: { measure: "count", what: { watch_id: ids.meals! }, compare: "last_14_days" } },
          { label: "Medication", query: { measure: "count", what: { watch_id: ids.pills! } } },
          { label: "Longest quiet spell", query: { measure: "longest_gap", what: person(), between: { from: "08:00", to: "20:00" } } },
          { label: "Time in bed last night", query: { measure: "total_duration", what: { watch_id: ids.bed! }, period: "last_24_hours", between: { from: "20:00", to: "10:00" } } },
        ]),
      },
    ],
  },
  {
    id: "home",
    name: "Home",
    description: "Parcels at the door, pets on the furniture, the kids getting home, and a quiet-house check while you're away.",
    items: [
      { key: "parcel", instruction: "Tell me if a package is left at the front door", mode: "alert" },
      { key: "pet", instruction: "Track when the dog or cat is on the sofa", mode: "track" },
      { key: "kids", instruction: "Track when someone comes in through the front door", mode: "track" },
      { key: "glass", instruction: "Tell me if glass breaks", mode: "alert" },
      {
        key: "day", instruction: "A summary of the day at home", mode: "alert",
        compiled: (ids) => digest("21:00", [
          { label: "Arrivals", query: { measure: "count", what: { watch_id: ids.kids! } } },
          { label: "Pets on the sofa", query: { measure: "total_duration", what: { watch_id: ids.pet! } } },
          { label: "Time anyone was in", query: { measure: "total_duration", what: person() } },
        ]),
      },
    ],
  },
  {
    id: "shop",
    name: "Shop or café",
    description: "Queues at the till, when the doors opened, how busy each hour was, compared with a normal week.",
    items: [
      { key: "queue", instruction: "Track when 3 or more people are queuing at the till", mode: "track" },
      { key: "queue_long", instruction: "Tell me if more than 5 people are queuing at the till for 2 minutes", mode: "alert" },
      {
        key: "opened", instruction: "Tell me if no one has come into the shop by 09:30", mode: "alert",
        compiled: () => condition({ measure: "count", what: person(), between: { from: "06:00", to: "09:30" } }, { op: "eq", value: 0 }, { at: "09:30", days: ["mon", "tue", "wed", "thu", "fri", "sat"] }),
      },
      {
        key: "day", instruction: "A summary of the trading day", mode: "alert",
        compiled: (ids) => digest("19:00", [
          { label: "First customer", query: { measure: "first", what: person() } },
          { label: "Visits", query: { measure: "count", what: person(), compare: "same_weekday" } },
          { label: "Time with a queue", query: { measure: "total_duration", what: { watch_id: ids.queue! }, compare: "same_weekday" } },
          { label: "Longest queue spell", query: { measure: "longest", what: { watch_id: ids.queue! } } },
        ]),
      },
    ],
  },
  {
    id: "site",
    name: "Site after hours",
    description: "People and vehicles on site out of hours, with a morning report on the night.",
    items: [
      { key: "person", instruction: "Tell me if a person is on site", mode: "alert", hours: { from: "19:00", to: "06:00" } },
      { key: "vehicle", instruction: "Tell me if a vehicle comes in", mode: "alert", hours: { from: "19:00", to: "06:00" } },
      { key: "loiter", instruction: "Tell me if someone stays near the gate for 2 minutes", mode: "alert", hours: { from: "19:00", to: "06:00" } },
      {
        key: "night", instruction: "A report on the night", mode: "alert",
        compiled: () => digest("07:00", [
          { label: "People seen overnight", query: { measure: "count", what: person(), period: "last_24_hours", between: { from: "19:00", to: "06:00" } } },
          { label: "Vehicles seen overnight", query: { measure: "count", what: { label: "vehicle" }, period: "last_24_hours", between: { from: "19:00", to: "06:00" } } },
          { label: "Time anyone was on site", query: { measure: "total_duration", what: person(), period: "last_24_hours", between: { from: "19:00", to: "06:00" } } },
        ]),
      },
    ],
  },
];

/** A pack as the API shows it. */
export const toPack = (p: Pack) => ({
  id: p.id, name: p.name, description: p.description,
  watches: p.items.map((i) => ({ key: i.key, instruction: i.instruction, mode: i.mode, ...(i.hours ? { hours: i.hours } : {}) })),
});
