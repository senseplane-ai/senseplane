// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Key rotation (ADR 0066), as background jobs (ADR 0058).
//   - Master key: MEDIA_ENCRYPTION_KEY replaced, the old one kept in
//     MEDIA_ENCRYPTION_KEY_PREVIOUS; every account's data key is wrapped again
//     under the new one. No footage is touched.
//   - An account's data key: a new version becomes current (new footage uses
//     it at once); recordings, clip copies, snapshots and exports under older
//     versions are re-encrypted in batches; then the old versions are deleted,
//     so copies made before (backups, a leaked bucket) can't be read any more.
import { sql } from "kysely";
import type { FastifyBaseLogger } from "fastify";
import type { DataAccess } from "./data/access.js";
import { type KeyRing, type KeyWrapper, decryptSegment, encryptSegment, isSealed, openObject, sealObject, segmentIV, segmentKey } from "./keys.js";
import type { ObjectStorage } from "./storage.js";

export interface RotationDeps {
  data: DataAccess;
  /** The bucket as it is (not the sealing layer): rotation reads and writes ciphertext. */
  storage: ObjectStorage;
  keys: KeyRing;
  wrapper: KeyWrapper;
  log?: FastifyBaseLogger;
}

/**
 * Old versions are deleted no sooner than this after the new one was made:
 * other API processes keep keys cached for up to 10 minutes, and a segment
 * being uploaded with the old key reports it a little later.
 */
export const SETTLE_MS = 15 * 60_000;

const BATCH = 50;

interface KeyVersions {
  account_id: string;
  versions: number;
  current: number;
  current_since: Date;
}

const accountsWithKeys = async (data: DataAccess) => (await sql<KeyVersions>`select * from account_key_versions()`.execute(data.db())).rows;

async function readAll(body: ReadableStream | NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of body as AsyncIterable<Uint8Array>) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks);
}

/** Wraps every account key under the current master key; returns how many moved. */
export async function rewrapKeys(deps: RotationDeps): Promise<number> {
  if (!deps.wrapper.rewrap) return 0;
  let moved = 0;
  for (const a of await accountsWithKeys(deps.data)) {
    const rows = await deps.data.withAccount(a.account_id, (s) => s.db.selectFrom("account_keys").select(["version", "wrapped"]).where("account_id", "=", a.account_id).execute());
    for (const r of rows) {
      const wrapped = await deps.wrapper.rewrap(r.wrapped, a.account_id);
      if (!wrapped) continue;
      await deps.data.withAccount(a.account_id, (s) => s.db.updateTable("account_keys").set({ wrapped })
        .where("account_id", "=", a.account_id).where("version", "=", r.version).where("wrapped", "=", r.wrapped).execute());
      moved++;
    }
  }
  if (moved) deps.log?.info({ keys: moved }, "account keys wrapped under the new MEDIA_ENCRYPTION_KEY; MEDIA_ENCRYPTION_KEY_PREVIOUS can go once every API process runs with it");
  return moved;
}

export interface ReencryptResult {
  segments: number;
  clipSegments: number;
  objects: number;
  /** Accounts whose rotation finished in this run (old versions deleted). */
  retired: number;
}

/** Re-encrypts footage under old key versions for up to budgetMs; finished accounts lose their old versions. */
export async function reencryptKeys(deps: RotationDeps, budgetMs = 45_000, now = () => Date.now()): Promise<ReencryptResult> {
  const until = now() + budgetMs;
  const out: ReencryptResult = { segments: 0, clipSegments: 0, objects: 0, retired: 0 };
  const rotating = (await accountsWithKeys(deps.data)).filter((a) => a.versions > 1);
  for (const a of rotating) {
    if (now() >= until) break;
    const acc = a.account_id;
    const cur = await deps.keys.current(acc);
    const reseal = async (key: string, sourceId: string, version: number, iv: Buffer) => {
      const old = await deps.keys.get(acc, version);
      if (!old) throw new Error(`key version ${version} of ${acc} is gone`);
      const plain = decryptSegment(segmentKey(old, sourceId), iv, await readAll((await deps.storage.get(key)).body));
      const newIv = segmentIV(cur.key, key);
      await deps.storage.put(key, encryptSegment(segmentKey(cur.key, sourceId), newIv, plain), "video/iso.segment");
      return newIv;
    };
    const gone = (err: unknown) => (err as { name?: string })?.name === "NoSuchKey"; // deleted by retention meanwhile

    let segmentsLeft = true;
    while (now() < until) {
      const batch = await deps.data.withAccount(acc, (s) => s.db.selectFrom("segments").select(["id", "key", "source_id", "enc_version", "enc_iv"])
        .where("enc_version", "<", cur.version).limit(BATCH).execute());
      for (const r of batch) {
        try {
          const iv = await reseal(r.key, r.source_id, r.enc_version!, r.enc_iv!);
          await deps.data.withAccount(acc, (s) => s.db.updateTable("segments").set({ enc_version: cur.version, enc_iv: iv }).where("id", "=", r.id).where("enc_version", "=", r.enc_version).execute());
        } catch (err) {
          if (!gone(err)) throw err;
          await deps.data.withAccount(acc, (s) => s.db.deleteFrom("segments").where("id", "=", r.id).execute());
        }
        out.segments++;
      }
      if (batch.length < BATCH) {
        segmentsLeft = false;
        break;
      }
    }

    let clipsLeft = true;
    while (!segmentsLeft && now() < until) {
      const batch = await deps.data.withAccount(acc, (s) => s.db.selectFrom("clip_segments").innerJoin("clips", "clips.id", "clip_segments.clip_id")
        .select(["clip_segments.clip_id", "clip_segments.seq", "clip_segments.key", "clips.source_id", "clip_segments.enc_version", "clip_segments.enc_iv"])
        .where("clip_segments.enc_version", "<", cur.version).limit(BATCH).execute());
      for (const r of batch) {
        try {
          const iv = await reseal(r.key, r.source_id, r.enc_version!, r.enc_iv!);
          await deps.data.withAccount(acc, (s) => s.db.updateTable("clip_segments").set({ enc_version: cur.version, enc_iv: iv })
            .where("clip_id", "=", r.clip_id).where("seq", "=", r.seq).where("enc_version", "=", r.enc_version).execute());
        } catch (err) {
          if (!gone(err)) throw err;
        }
        out.clipSegments++;
      }
      if (batch.length < BATCH) {
        clipsLeft = false;
        break;
      }
    }

    // Story segments (ADR 0070): each names the id its key comes from (its camera, or the story).
    let storiesLeft = true;
    while (!segmentsLeft && !clipsLeft && now() < until) {
      const batch = await deps.data.withAccount(acc, (s) => s.db.selectFrom("story_segments")
        .select(["story_id", "seq", "key", "key_source", "enc_version", "enc_iv"]).where("enc_version", "<", cur.version).limit(BATCH).execute());
      for (const r of batch) {
        try {
          const iv = await reseal(r.key, r.key_source, r.enc_version!, r.enc_iv!);
          await deps.data.withAccount(acc, (s) => s.db.updateTable("story_segments").set({ enc_version: cur.version, enc_iv: iv })
            .where("story_id", "=", r.story_id).where("seq", "=", r.seq).where("enc_version", "=", r.enc_version).execute());
        } catch (err) {
          if (!gone(err)) throw err;
          // Its story was deleted meanwhile; the row goes with it.
          await deps.data.withAccount(acc, (s) => s.db.deleteFrom("story_segments").where("story_id", "=", r.story_id).where("seq", "=", r.seq).execute());
        }
        out.clipSegments++;
      }
      if (batch.length < BATCH) {
        storiesLeft = false;
        break;
      }
    }

    // Snapshots and exports: their version is in their header.
    let objectsDone = !segmentsLeft && !clipsLeft && !storiesLeft && Boolean(deps.storage.list);
    for (const prefix of [`snapshots/${acc}/`, `exports/${acc}/`, `speak/${acc}/`]) {
      if (!objectsDone || !deps.storage.list) break;
      for await (const key of deps.storage.list(prefix)) {
        if (now() >= until) {
          objectsDone = false;
          break;
        }
        let obj: Awaited<ReturnType<ObjectStorage["get"]>>;
        try {
          obj = await deps.storage.get(key);
        } catch (err) {
          if (gone(err)) continue;
          throw err;
        }
        const stored = await readAll(obj.body);
        if (!isSealed(stored) || stored.readUInt32BE(4) >= cur.version) continue;
        await deps.storage.put(key, await sealObject(deps.keys, acc, await openObject(deps.keys, acc, stored)), obj.contentType ?? "application/octet-stream");
        out.objects++;
      }
    }

    // Done, and settled: the old versions go, and with them every copy made before.
    if (objectsDone && now() - new Date(a.current_since).getTime() >= SETTLE_MS) {
      const n = await deps.keys.retire(acc);
      out.retired++;
      deps.log?.info({ account: acc, version: cur.version, retired: n }, "account key rotated: footage re-encrypted, old key deleted");
    }
  }
  return out;
}
