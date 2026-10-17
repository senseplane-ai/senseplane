// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Rooms and participants (spec/media/signalling.md, control-api.yaml). A room
// is created by the control API, holds one mediasoup Router (with the room's
// codecs) and any number of participants, each the holder of one join token.
// Every way in (a signalling WebSocket, a WHIP publish, the dev replay)
// becomes a Participant through `join`, so the join gate, newest-replaces,
// subscribeKinds and the room callbacks apply to all of them alike.
import { randomUUID } from "node:crypto";
import { BlockList, isIPv4, isIPv6 } from "node:net";
import type { types } from "mediasoup";
import { type Callback, type Log, type RoomEventType, RoomEvents } from "./callbacks.js";
import { type RoomCodec, roomCodecs } from "./codecs.js";
import type { MediaConfig } from "./config.js";
import type { Grants, JoinClaims, ParticipantKind, SubscribeRule } from "./tokens.js";

export type ErrorCode =
  | "unauthorized" | "replayed" | "protocol_version" | "forbidden_transport" | "forbidden" | "not_subscribable"
  | "subscription_limit" | "room_closed" | "no_such_room" | "no_such_producer" | "no_such_transport"
  | "duplicate_identity" | "node_draining" | "capacity" | "bad_request" | "internal";

export class MediaError extends Error {
  constructor(readonly code: ErrorCode, message?: string) {
    super(message ?? code);
  }
}

export interface WorkerNode {
  worker: types.Worker;
  webRtcServer?: types.WebRtcServer;
}

/** The client side of a participant: a WebSocket, a WHIP session, a replay. */
export interface Peer {
  send(frame: object): void;
  close(code: number, reason: string): void;
}

export interface RoomOptions {
  liveness?: "humans" | "any";
  codecs?: RoomCodec[];
  onDuplicateIdentity?: "replace";
  events?: RoomEventType[];
}

export interface RoomRecord {
  roomId: string;
  createdAt: Date;
  endedAt?: Date;
  endedReason?: string;
  emptyTimeoutSeconds: number;
  maxParticipants: number | null;
  metadata: Record<string, string>;
  callback: Callback | null;
  options: RoomOptions;
}

const HUMANS = new Set<ParticipantKind>(["human", "sip"]);
const ANY = new Set<ParticipantKind>(["human", "sip", "agent", "ingress"]);

export function ruleAllows(rule: SubscribeRule | undefined, identity: string): boolean {
  if (!rule || rule.mode === "all") return true;
  if (rule.mode === "none") return false;
  return rule.mode === "allow" ? rule.identities.includes(identity) : !rule.identities.includes(identity);
}

export const maySubscribeKind = (g: Grants, kind: "audio" | "video") => !g.subscribeKinds || g.subscribeKinds.includes(kind);

/** What a publisher must be granted to send a track: a screen share is "screen", everything else its track kind. */
function requiredPublishKind(source: string | undefined, kind: "audio" | "video"): "audio" | "video" | "screen" {
  return source === "screen" && kind === "video" ? "screen" : kind;
}

interface TransportEntry {
  transport: types.Transport;
  direction: "send" | "recv";
  kind: "webrtc" | "plain";
}

export class Participant {
  readonly sessionId = randomUUID();
  readonly joinedAt = Date.now();
  readonly transports = new Map<string, TransportEntry>();
  readonly producers = new Map<string, { producer: types.Producer; source?: string }>();
  readonly consumers = new Map<string, types.Consumer>();
  closed = false;
  /** What the client was told in roomClosed, reported in participant.left. */
  private roomClosedReason?: string;
  private teardownDone?: Promise<void>;

  constructor(readonly room: Room, readonly claims: JoinClaims, readonly peer: Peer, private readonly mgr: RoomManager) {}

  get identity() { return this.claims.identity; }
  get kind() { return this.claims.kind; }
  get grants() { return this.claims.grants; }

  /** May this participant receive media from `owner`? Identity rules of both sides; not the kind. */
  mayReceiveFrom(owner: Participant): boolean {
    if (!this.grants.canSubscribe || owner.identity === this.identity) return false;
    return ruleAllows(this.grants.subscribe, owner.identity) && ruleAllows(owner.grants.visibleTo, this.identity);
  }

  /**
   * Ends this session from the node's side: `roomClosed` with the reason the
   * client should act on, then a 1008 close, then the teardown.
   */
  evict(reason: string, opts: { closeReason?: string } = {}): Promise<void> {
    if (this.closed) return this.teardownDone ?? Promise.resolve();
    this.roomClosedReason = reason;
    try {
      this.peer.send({ event: "roomClosed", reason });
    } catch {
      // the client is already gone
    }
    this.peer.close(1008, opts.closeReason ?? "room_closed");
    return this.leave(reason);
  }

  /** A newer connection took this identity (signalling.md): it must not reconnect on its own. */
  replace(): Promise<void> {
    return this.evict("replaced", { closeReason: "room_closed" });
  }

  /** Releases everything this participant holds. Idempotent. */
  leave(reason: string): Promise<void> {
    if (this.teardownDone) return this.teardownDone;
    this.closed = true;
    this.teardownDone = this.mgr.teardown(this, this.roomClosedReason ?? reason);
    return this.teardownDone;
  }
}

export class Room {
  readonly participants = new Map<string, Participant>();
  /** identity → removal time (epoch seconds): a token issued before it is refused. */
  readonly evictions = new Map<string, number>();
  router?: types.Router;
  private routerPromise?: Promise<types.Router>;
  emptySince: number | null = Date.now();

  constructor(public record: RoomRecord, readonly node: WorkerNode) {}

  get id() { return this.record.roomId; }
  get ended() { return Boolean(this.record.endedAt); }

  acquireRouter(): Promise<types.Router> {
    this.routerPromise ??= this.node.worker.createRouter({ mediaCodecs: roomCodecs(this.record.options.codecs) }).then((r) => (this.router = r));
    return this.routerPromise;
  }

  /** Participants who keep the room alive (its liveness option). */
  alive(): number {
    const kinds = this.record.options.liveness === "any" ? ANY : HUMANS;
    let n = 0;
    for (const p of this.participants.values()) if (!p.closed && kinds.has(p.kind)) n++;
    return n;
  }

  recording(): boolean {
    for (const p of this.participants.values()) if (!p.closed && p.kind === "egress") return true;
    return false;
  }

  findProducer(producerId: string): { owner: Participant; producer: types.Producer; source?: string } | undefined {
    for (const owner of this.participants.values()) {
      const e = owner.producers.get(producerId);
      if (e && !e.producer.closed) return { owner, ...e };
    }
    return undefined;
  }
}

export interface CreateRoomInput {
  roomId: string;
  emptyTimeoutSeconds?: number;
  maxParticipants?: number;
  metadata?: Record<string, string>;
  callback?: Callback | null;
  options?: RoomOptions;
}

export class RoomManager {
  readonly rooms = new Map<string, Room>();
  readonly events: RoomEvents;
  draining = false;
  private next = 0;
  private readonly sweeper: NodeJS.Timeout;
  private readonly peerBlock: BlockList;
  private readonly iceTimers = new WeakMap<types.Transport, NodeJS.Timeout>();

  constructor(
    private readonly nodes: WorkerNode[],
    private readonly cfg: Pick<MediaConfig, "rooms" | "plain" | "listenIp" | "announcedAddress">,
    private readonly log: Log,
    events?: RoomEvents,
  ) {
    this.events = events ?? new RoomEvents({ log });
    this.peerBlock = new BlockList();
    for (const cidr of cfg.plain.peerCidrs) {
      const [net, bits] = cidr.split("/");
      if (!net || bits === undefined) continue;
      this.peerBlock.addSubnet(net, Number(bits), isIPv6(net) ? "ipv6" : "ipv4");
    }
    this.sweeper = setInterval(() => this.sweep(), 2000);
    this.sweeper.unref();
  }

  /** Idempotent: an existing live room is returned unchanged; an ended one is created again. */
  create(input: CreateRoomInput): Room {
    const existing = this.rooms.get(input.roomId);
    if (existing && !existing.ended) return existing;
    const node = this.nodes[this.next++ % this.nodes.length]!;
    const room = new Room({
      roomId: input.roomId,
      createdAt: new Date(),
      emptyTimeoutSeconds: input.emptyTimeoutSeconds ?? this.cfg.rooms.emptyTimeoutSeconds,
      maxParticipants: input.maxParticipants ?? null,
      metadata: input.metadata ?? {},
      callback: input.callback ?? null,
      options: input.options ?? {},
    }, node);
    this.rooms.set(input.roomId, room);
    return room;
  }

  get(roomId: string): Room | undefined {
    return this.rooms.get(roomId);
  }

  /** Ends a room for everyone in it. Idempotent. */
  async end(roomId: string, reason: string): Promise<void> {
    const room = this.rooms.get(roomId);
    if (!room || room.ended) return;
    room.record = { ...room.record, endedAt: new Date(), endedReason: reason };
    await Promise.allSettled([...room.participants.values()].map((p) => p.evict("room_closed")));
    room.router?.close();
    this.events.ended(room.id, room.record.callback, room.record.endedAt!, reason);
    this.log.info({ roomId, reason }, "room ended");
  }

  /** Control API participant removal: records the time, then ends the session with the reason. */
  async removeParticipant(roomId: string, identity: string, reason?: string): Promise<void> {
    const room = this.rooms.get(roomId);
    if (!room) return;
    room.evictions.set(identity, Math.floor(Date.now() / 1000));
    const p = room.participants.get(identity);
    if (p) await p.evict(reason ?? "room_closed");
  }

  /**
   * Admits a verified (and consumed) join token: the join gate after the
   * token (signalling.md *Join*, steps 3–7), then the `joined` snapshot.
   */
  async join(claims: JoinClaims, peer: Peer): Promise<{ participant: Participant; joined: object }> {
    if (this.draining) throw new MediaError("node_draining", "reconnect later");
    const room = this.rooms.get(claims.room);
    const removed = room?.evictions.get(claims.identity);
    if (removed !== undefined && claims.iat < removed) throw new MediaError("unauthorized");
    if (!room) throw new MediaError("no_such_room");
    if (room.ended) throw new MediaError("room_closed", room.record.endedReason ?? "ended");

    const existing = room.participants.get(claims.identity);
    if (existing && !existing.closed) {
      // An RTMP-style encoder (ingress over plain) keeps the refusal: two encoders on one key must not take turns.
      if (claims.kind === "ingress" && claims.transport === "plain") throw new MediaError("duplicate_identity", "that identity is already in this room");
      this.log.info({ roomId: room.id, identity: claims.identity }, "a newer connection replaces a session");
      await existing.replace();
    }
    if (room.record.maxParticipants !== null) {
      let count = 0;
      for (const p of room.participants.values()) if (!p.closed && p.identity !== claims.identity) count++;
      if (count >= room.record.maxParticipants) throw new MediaError("capacity", "this room is full");
    }
    const router = await room.acquireRouter();
    // Decisive after the await: a third connection racing this one is refused, not looped on.
    const racing = room.participants.get(claims.identity);
    if (racing && !racing.closed) throw new MediaError("duplicate_identity", "that identity is already in this room");
    if (room.ended) throw new MediaError("room_closed", room.record.endedReason ?? "ended");

    const participant = new Participant(room, claims, peer, this);
    room.participants.set(claims.identity, participant);
    if (room.alive() > 0) room.emptySince = null;

    const visible = [...room.participants.values()].filter((o) => o !== participant && !o.closed);
    const producers = visible
      .filter((o) => participant.mayReceiveFrom(o))
      .flatMap((o) => [...o.producers.values()].map((e) => ({ owner: o, ...e })))
      .filter((e) => !e.producer.closed && maySubscribeKind(participant.grants, e.producer.kind))
      .map((e) => ({ producerId: e.producer.id, identity: e.owner.identity, kind: e.producer.kind, ...(e.source ? { source: e.source } : {}) }));
    const joined = {
      event: "joined",
      identity: claims.identity,
      room: room.id,
      routerRtpCapabilities: router.rtpCapabilities,
      // Barrier-filtered like producers: presence is disclosed only to who may receive it.
      peers: visible.filter((o) => participant.mayReceiveFrom(o))
        .map((o) => ({ identity: o.identity, ...(o.claims.name ? { name: o.claims.name } : {}), kind: o.kind })),
      producers,
      iceServers: [],
      recording: room.recording(),
      grants: claims.grants,
    };
    for (const o of visible) {
      if (o.mayReceiveFrom(participant)) o.peer.send({ event: "peerJoined", identity: claims.identity, kind: claims.kind, ...(claims.name ? { name: claims.name } : {}) });
    }
    if (claims.kind === "egress") for (const o of visible) o.peer.send({ event: "recordingChanged", recording: true });
    this.events.event(room.id, room.record.callback, room.record.options.events, "participant.joined",
      { identity: claims.identity, kind: claims.kind, sessionId: participant.sessionId }, `participant.joined:${participant.sessionId}`);
    return { participant, joined };
  }

  /** Called once per participant (Participant.leave). */
  async teardown(p: Participant, reason: string): Promise<void> {
    const room = p.room;
    for (const e of p.transports.values()) {
      clearTimeout(this.iceTimers.get(e.transport));
      e.transport.close();
    }
    p.transports.clear();
    if (room.participants.get(p.identity) === p) room.participants.delete(p.identity);
    for (const o of room.participants.values()) {
      if (!o.closed && o.mayReceiveFrom(p)) o.peer.send({ event: "peerLeft", identity: p.identity });
    }
    if (p.kind === "egress" && !room.recording()) for (const o of room.participants.values()) o.peer.send({ event: "recordingChanged", recording: false });
    this.events.event(room.id, room.record.callback, room.record.options.events, "participant.left",
      { identity: p.identity, kind: p.kind, sessionId: p.sessionId, reason }, `participant.left:${p.sessionId}`);
    if (room.alive() === 0 && room.emptySince === null) room.emptySince = Date.now();
  }

  // --- transports, producers, consumers -------------------------------------

  async createTransport(p: Participant, direction: "send" | "recv", sctp = false) {
    if (p.closed) throw new MediaError("unauthorized", "session closed");
    if (direction !== "send" && direction !== "recv") throw new MediaError("bad_request", "direction must be send or recv");
    if (direction === "send" && !p.grants.canPublish) throw new MediaError("forbidden", "this token may not publish");
    if (direction === "recv" && !p.grants.canSubscribe) throw new MediaError("forbidden", "this token may not receive");
    if (p.transports.size >= this.cfg.rooms.maxTransportsPerSession) throw new MediaError("bad_request", "too many transports");
    const router = await p.room.acquireRouter();
    // `plain`: an RTMP-style ingress or a gateway. `pipe`: this media plane's own egress leg (spec/media/tokens.md),
    // here a plain RTP leg to the media plane's own network. Both are peer-checked on connect.
    if (p.claims.transport === "plain" || p.claims.transport === "pipe") {
      const t = await router.createPlainTransport({
        listenInfo: { protocol: "udp", ip: this.cfg.plain.listenIp, ...(this.cfg.plain.announcedAddress ? { announcedAddress: this.cfg.plain.announcedAddress } : {}) },
        rtcpMux: false,
        comedia: false,
      });
      p.transports.set(t.id, { transport: t, direction, kind: "plain" });
      return {
        transportId: t.id, ip: this.cfg.plain.announcedAddress ?? t.tuple.localAddress, port: t.tuple.localPort,
        ...(t.rtcpTuple ? { rtcpPort: t.rtcpTuple.localPort } : {}), direction,
      };
    }
    if (p.claims.transport !== "webrtc") throw new MediaError("forbidden_transport", `${p.claims.transport} transports are not offered here`);
    const node = p.room.node;
    const t = await router.createWebRtcTransport({
      ...(node.webRtcServer
        ? { webRtcServer: node.webRtcServer }
        : { listenInfos: [{ protocol: "udp", ip: this.cfg.listenIp, ...(this.cfg.announcedAddress ? { announcedAddress: this.cfg.announcedAddress } : {}) }] }),
      enableUdp: true, enableTcp: true, preferUdp: true, enableSctp: sctp,
    });
    p.transports.set(t.id, { transport: t, direction, kind: "webrtc" });
    t.on("dtlsstatechange", (s) => {
      if (s === "closed" || s === "failed") void p.leave(`dtls_${s}`);
    });
    // A publisher that vanished without closing (a camera unplugged): its ICE consent lapses.
    t.on("icestatechange", (s) => {
      clearTimeout(this.iceTimers.get(t));
      if (s === "disconnected") {
        const timer = setTimeout(() => void p.leave("ice_disconnected"), 15_000);
        timer.unref();
        this.iceTimers.set(t, timer);
      }
    });
    return {
      transportId: t.id, id: t.id, iceParameters: t.iceParameters, iceCandidates: t.iceCandidates, dtlsParameters: t.dtlsParameters,
      ...(t.sctpParameters ? { sctpParameters: t.sctpParameters } : {}), direction,
    };
  }

  /** Registers a transport made outside createTransport (the dev replay's plain input). */
  attachTransport(p: Participant, transport: types.Transport, direction: "send" | "recv") {
    p.transports.set(transport.id, { transport, direction, kind: "plain" });
  }

  private entry(p: Participant, transportId: unknown): TransportEntry {
    const e = typeof transportId === "string" ? p.transports.get(transportId) : undefined;
    if (!e) throw new MediaError("no_such_transport");
    return e;
  }

  async connectTransport(p: Participant, transportId: unknown, f: { dtlsParameters?: unknown; ip?: unknown; port?: unknown; rtcpPort?: unknown }) {
    const e = this.entry(p, transportId);
    if (e.kind === "webrtc") {
      if (!f.dtlsParameters || typeof f.dtlsParameters !== "object") throw new MediaError("bad_request", "dtlsParameters is required");
      await (e.transport as types.WebRtcTransport).connect({ dtlsParameters: f.dtlsParameters as types.DtlsParameters });
    } else {
      const ip = typeof f.ip === "string" ? f.ip : "";
      const port = Number(f.port);
      if (!(isIPv4(ip) || isIPv6(ip)) || !Number.isInteger(port) || port < 1 || port > 65535) throw new MediaError("bad_request", "ip and port are required");
      // A plain transport only ever sends to the media plane's own network: never a reflector.
      if (!this.peerBlock.check(ip, isIPv6(ip) ? "ipv6" : "ipv4")) throw new MediaError("forbidden", "that address is not on this media plane's network");
      const rtcpPort = f.rtcpPort === undefined ? undefined : Number(f.rtcpPort);
      await (e.transport as types.PlainTransport).connect({ ip, port, ...(rtcpPort ? { rtcpPort } : {}) });
    }
    return { connected: true };
  }

  async produce(p: Participant, transportId: unknown, kind: unknown, rtpParameters: unknown, appData?: unknown) {
    const e = this.entry(p, transportId);
    if (kind !== "audio" && kind !== "video") throw new MediaError("bad_request", "kind must be audio or video");
    if (e.direction !== "send") throw new MediaError("bad_request", "produce needs a send transport");
    if (!p.grants.canPublish) throw new MediaError("forbidden", "this token may not publish");
    const source = appData && typeof appData === "object" && typeof (appData as { source?: unknown }).source === "string"
      ? String((appData as { source: string }).source).slice(0, 32) : undefined;
    const need = requiredPublishKind(source, kind);
    if (p.grants.publishKinds && !p.grants.publishKinds.includes(need)) throw new MediaError("forbidden", `this token may not publish ${need}`);
    let producer: types.Producer;
    try {
      producer = await e.transport.produce({ kind, rtpParameters: rtpParameters as types.RtpParameters, appData: source ? { source } : {} });
    } catch (err) {
      // The room's codecs refuse it (VP8 in an H.264 room), or the parameters are wrong.
      throw new MediaError("bad_request", (err as Error).message);
    }
    if (p.closed) {
      producer.close();
      throw new MediaError("unauthorized", "session closed");
    }
    p.producers.set(producer.id, { producer, ...(source ? { source } : {}) });
    const room = p.room;
    producer.observer.once("close", () => {
      p.producers.delete(producer.id);
      this.events.event(room.id, room.record.callback, room.record.options.events, "producer.removed",
        { identity: p.identity, producerId: producer.id, kind, ...(source ? { source } : {}) }, `producer.removed:${producer.id}`);
    });
    producer.on("transportclose", () => {
      if (!p.closed) p.peer.send({ event: "producerClosed", producerId: producer.id });
    });
    this.events.event(room.id, room.record.callback, room.record.options.events, "producer.added",
      { identity: p.identity, producerId: producer.id, kind, ...(source ? { source } : {}) }, `producer.added:${producer.id}`);
    for (const o of room.participants.values()) {
      if (o === p || o.closed || !o.mayReceiveFrom(p) || !maySubscribeKind(o.grants, kind)) continue;
      o.peer.send({ event: "producerAppeared", producerId: producer.id, identity: p.identity, kind, ...(source ? { source } : {}) });
    }
    return { producerId: producer.id };
  }

  closeProducer(p: Participant, producerId: unknown) {
    const e = typeof producerId === "string" ? p.producers.get(producerId) : undefined;
    if (!e) throw new MediaError("no_such_producer");
    e.producer.close();
    return { producerId, closed: true };
  }

  async consume(p: Participant, transportId: unknown, producerId: unknown, rtpCapabilities: unknown) {
    if (!p.grants.canSubscribe) throw new MediaError("forbidden", "this token may not receive");
    if (typeof producerId !== "string" || !rtpCapabilities || typeof rtpCapabilities !== "object") throw new MediaError("bad_request", "producerId and rtpCapabilities are required");
    const found = p.room.findProducer(producerId);
    if (!found) throw new MediaError("no_such_producer");
    if (!p.mayReceiveFrom(found.owner)) throw new MediaError("not_subscribable");
    // A privacy property of the people in the room, so it is the node's to enforce (subscribeKinds).
    if (!maySubscribeKind(p.grants, found.producer.kind)) throw new MediaError("forbidden", `this token may not receive ${found.producer.kind}`);
    if (p.grants.maxSubscriptions !== undefined && p.consumers.size >= p.grants.maxSubscriptions) throw new MediaError("subscription_limit");
    const e = this.entry(p, transportId);
    if (e.direction !== "recv") throw new MediaError("bad_request", "consume needs a recv transport");
    const router = await p.room.acquireRouter();
    if (!router.canConsume({ producerId, rtpCapabilities: rtpCapabilities as types.RtpCapabilities })) {
      throw new MediaError("bad_request", "these capabilities can't receive this producer's codec");
    }
    const consumer = await e.transport.consume({ producerId, rtpCapabilities: rtpCapabilities as types.RtpCapabilities, paused: true });
    p.consumers.set(consumer.id, consumer);
    consumer.on("producerclose", () => {
      if (!p.consumers.delete(consumer.id) || p.closed) return;
      p.peer.send({ event: "producerClosed", producerId, consumerId: consumer.id });
    });
    consumer.on("transportclose", () => p.consumers.delete(consumer.id));
    return { consumerId: consumer.id, producerId, kind: consumer.kind, rtpParameters: consumer.rtpParameters, type: consumer.type, paused: true };
  }

  private consumer(p: Participant, consumerId: unknown): types.Consumer {
    const c = typeof consumerId === "string" ? p.consumers.get(consumerId) : undefined;
    if (!c) throw new MediaError("no_such_producer", "no such consumer");
    return c;
  }

  async resumeConsumer(p: Participant, consumerId: unknown) {
    const c = this.consumer(p, consumerId);
    await c.resume();
    if (c.kind === "video") await c.requestKeyFrame().catch(() => undefined);
    return { consumerId, resumed: true };
  }

  async pauseConsumer(p: Participant, consumerId: unknown) {
    await this.consumer(p, consumerId).pause();
    return { consumerId, paused: true };
  }

  closeConsumer(p: Participant, consumerId: unknown) {
    const c = this.consumer(p, consumerId);
    p.consumers.delete(c.id);
    c.close();
    return { consumerId, closed: true };
  }

  async requestKeyFrame(p: Participant, consumerId: unknown) {
    const c = this.consumer(p, consumerId);
    if (c.kind === "video") await c.requestKeyFrame();
    return { requested: true };
  }

  // --- lifecycle --------------------------------------------------------------

  /** Ends rooms that have had nobody who keeps them alive for their empty timeout. */
  sweep(now = Date.now()) {
    for (const room of this.rooms.values()) {
      if (room.ended) {
        if (now - room.record.endedAt!.getTime() > 3600_000) this.rooms.delete(room.id);
        continue;
      }
      if (room.alive() > 0) {
        room.emptySince = null;
        continue;
      }
      room.emptySince ??= now;
      if (now - room.emptySince >= room.record.emptyTimeoutSeconds * 1000) void this.end(room.id, "empty_timeout");
    }
  }

  /** The node is going away: everyone is told to reconnect elsewhere, then their sessions end. */
  async drain(reconnectAfterMs: number) {
    this.draining = true;
    const all = [...this.rooms.values()].flatMap((r) => [...r.participants.values()]);
    for (const p of all) p.peer.send({ event: "draining", reconnectAfterMs });
    await Promise.allSettled(all.map((p) => p.leave("node_draining")));
    for (const p of all) p.peer.close(1001, "node_draining");
  }

  usage() {
    let rooms = 0, participants = 0, producers = 0, consumers = 0;
    for (const r of this.rooms.values()) {
      if (r.ended) continue;
      rooms++;
      for (const p of r.participants.values()) {
        participants++;
        producers += p.producers.size;
        consumers += p.consumers.size;
      }
    }
    return { rooms, participants, producers, consumers };
  }

  describe(room: Room) {
    const participants = [...room.participants.values()].filter((p) => !p.closed);
    return {
      roomId: room.id,
      status: room.ended ? "ended" : "live",
      createdAt: room.record.createdAt.toISOString(),
      ...(room.ended ? { endedAt: room.record.endedAt!.toISOString(), endedReason: room.record.endedReason } : {}),
      participantCount: participants.length,
      participants: participants.map((p) => ({
        identity: p.identity,
        ...(p.claims.name ? { name: p.claims.name } : {}),
        kind: p.kind,
        joinedAt: new Date(p.joinedAt).toISOString(),
        publishing: [...p.producers.values()].filter((e) => !e.producer.closed)
          .map((e) => ({ producerId: e.producer.id, kind: e.producer.kind, paused: e.producer.paused })),
      })),
    };
  }

  close() {
    clearInterval(this.sweeper);
  }
}
