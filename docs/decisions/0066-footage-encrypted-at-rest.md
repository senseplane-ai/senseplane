# 66. Footage encrypted at rest, with keys the server holds

Date: 2026-11-02 · Status: accepted

## Context

Recordings, clips, snapshots and exports sit in an S3-compatible bucket
(RustFS when self-hosted). Anyone with the bucket's credentials, a copy of
it, or a backup could watch everything. Bucket-side encryption (SSE) only
protects the provider's disks: whoever can read the bucket reads plain
video. End-to-end encryption, where only the user holds the key, would
keep the server from seeing the video, and seeing it is the product
(detection, watches, AI checks, answers), so the keys stay with the server
and Senseplane says "encrypted at rest", never "end-to-end".

## Decision

**Keys.** Each account has a random 256-bit data key, stored in
`account_keys` only wrapped (AES-256-GCM, the account id as associated
data) by the instance's `MEDIA_ENCRYPTION_KEY`. Like `SECRETS_ENCRYPTION_KEY`
(ADR 0027), it is required in production and generated once outside it; a
KMS can stand in for it (`keyWrapper`). Keys are versioned, so an account's
key can be replaced while older footage keeps its version.

**Recordings: HLS AES-128, encrypted by the media plane.** The media plane
uploads each segment with a presigned PUT it asks the API for (ADR 0049).
It now offers `encryption: ["aes-128"]` with that request; the API answers
media segments (never the init segment, which holds codec settings and no
pictures) with a key, an IV and a key id. The media plane encrypts the
segment (AES-128-CBC, PKCS#7, RFC 8216 5.2), uploads it, and reports the
key id and IV in `segment.written`, where the API stores them with the
segment. The key is per camera (derived from the account key), so a link to
one camera's footage never opens another's; the IV comes from the object
key. The media plane holds a key only for one upload and knows nothing else.
A media plane that doesn't offer encryption keeps uploading as before.

**Playback stays direct.** Playlists name each encrypted segment's key and
IV (`#EXT-X-KEY`, switched off before init sections). The key is served at
`/playback/{token}/k/{version}.key`, authorised by the same signed token as
the playlist and re-checked against grants (ADR 0036). Players (hls.js,
Safari, ffmpeg) fetch it and decrypt, so segments still come from the
bucket by presigned link and the API stays out of the video bytes. A
video-only link gets no key: the API decrypts its segments and removes the
audio itself (ADR 0037). Clips copy the ciphertext and keep its key and IV.

**Snapshots and exports: sealed by the API.** The storage layer seals them
with AES-256-GCM under the account key (`SPE1` header with the key version)
and opens them on read. They are never presigned: the API streams them,
decrypted, to whoever holds a valid link.

**Deleting an account deletes its keys** at once, in the same transaction
as the deletion. Its footage becomes unreadable everywhere, backups
included, before the purge removes the objects. Other API processes notice
within ten minutes (their key cache), and the account's tokens are already
revoked.

**Objects stored before this** carry no key: segments without a key version
and objects without the `SPE1` header are read as they are, until retention
removes them.

## Consequences

- **`MEDIA_ENCRYPTION_KEY` must be backed up apart from the database.** Lose
  it and no recording can be played again. The self-host docs say so.
- The server still sees footage in clear while it analyses and serves it;
  this protects stored copies (the bucket, backups, a leaked credential),
  not a compromised server.
- Bucket-side encryption (SSE) can still be turned on underneath; it adds
  little but costs nothing.
- The hosted media plane (TribeNest's egress) needs the same change to
  offer encryption; until it does, its recordings are stored as before.
- Not yet: rotating an account's key with re-encryption of its footage, and
  re-wrapping all keys under a new master key. Both are background jobs on
  top of the versioned keys.
- Tested end to end against the object store: ffmpeg plays encrypted
  recordings and clips through their signed playlists and key links.
