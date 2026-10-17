// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Tests: an in-memory media plane behind the control client (spec/media
// control-api.yaml), so the real media driver runs against it. Tests make a
// camera publish or a viewer join by changing its rooms.
import type { ControlClient, EgressSnapshot, RoomInput, RoomView } from "./media-client.js";

export interface FakeParticipant {
  identity: string;
  kind: string;
  publishing: { producerId: string; kind: "audio" | "video"; paused: boolean }[];
}

export function fakeMediaPlane(signalUrl = "ws://media.test/") {
  const rooms = new Map<string, { input: RoomInput; status: "live" | "ended"; participants: Map<string, FakeParticipant> }>();
  const egress = new Map<string, { body: Record<string, unknown>; status: EgressSnapshot["status"] }>();
  const removed: { room: string; identity: string; reason?: string }[] = [];
  const calls: string[] = [];
  const client: ControlClient = {
    async createRoom(input) {
      calls.push(`createRoom ${input.roomId}`);
      const r = rooms.get(input.roomId);
      if (!r || r.status === "ended") rooms.set(input.roomId, { input, status: "live", participants: new Map() });
      return { roomId: input.roomId, signal_url: signalUrl };
    },
    async getRoom(roomId): Promise<RoomView | undefined> {
      const r = rooms.get(roomId);
      if (!r) return undefined;
      return { roomId, status: r.status, participants: [...r.participants.values()].map((p) => ({ ...p, joinedAt: new Date().toISOString() })) };
    },
    async removeParticipant(room, identity, reason) {
      calls.push(`removeParticipant ${room} ${identity} ${reason ?? ""}`.trim());
      removed.push({ room, identity, ...(reason ? { reason } : {}) });
      rooms.get(room)?.participants.delete(identity);
    },
    async startEgress(body) {
      const id = String(body.sessionId);
      calls.push(`startEgress ${id}`);
      const e = egress.get(id) ?? { body, status: "waiting" as const };
      egress.set(id, e);
      return { sessionId: id, room: String(body.room), status: e.status };
    },
    async getEgress(id) {
      const e = egress.get(id);
      return e ? { sessionId: id, room: String(e.body.room), status: e.status } : undefined;
    },
    async stopEgress(id) {
      calls.push(`stopEgress ${id}`);
      const e = egress.get(id);
      if (e) e.status = "finished";
    },
  };
  return {
    client, rooms, egress, removed, calls,
    /** The camera publishes video (a capture page by default) in its room. */
    publish(sourceId: string, identity = `${sourceId}:capture`) {
      const room = rooms.get(`sp-${sourceId}`) ?? { input: { roomId: `sp-${sourceId}` }, status: "live" as const, participants: new Map() };
      rooms.set(`sp-${sourceId}`, room);
      room.participants.set(identity, { identity, kind: identity.endsWith(":whip") ? "ingress" : "human", publishing: [{ producerId: `p-${identity}`, kind: "video", paused: false }] });
    },
    unpublish(sourceId: string, identity = `${sourceId}:capture`) {
      rooms.get(`sp-${sourceId}`)?.participants.delete(identity);
    },
    feeds: (sourceId: string) => [...egress.values()].filter((e) => e.body.room === `sp-${sourceId}`),
  };
}

export type FakeMediaPlane = ReturnType<typeof fakeMediaPlane>;
