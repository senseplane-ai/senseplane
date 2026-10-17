# 18. Signed HLS playback from the segment index

Date: 2026-10-16 · Status: accepted

## Decision
- `GET /v1/sources/{id}/playback?from&to` returns a signed playlist URL
  (`/playback/{token}/index.m3u8`), valid 15 minutes. The token is an
  HMAC-SHA256-signed scope (account + source range, or account + clip) with an
  expiry. `PLAYBACK_SIGNING_SECRET` is required in production; elsewhere one
  is generated and stored like the ingest key.
- The playlist is built on demand from the segment index: fMP4 (`EXT-X-MAP`),
  `EXT-X-PROGRAM-DATE-TIME` on every segment, and `EXT-X-DISCONTINUITY` when
  the init segment changes (recorder restart) or there is a gap over 1.5 s.
- Segment and init URLs are relative to the token, and each request is
  checked against the signed scope (a segment outside the range is a 404).
  Delivery: a 302 to a presigned object URL when `S3_PUBLIC_ENDPOINT` is set,
  otherwise streamed through the API (the default, so the object store never
  has to be public). Setting `S3_PUBLIC_ENDPOINT` is recommended for larger
  deployments: segment bytes go straight from object storage to the viewer
  and never through API nodes; the bucket then needs a CORS rule allowing GET
  from the console origin.
- Limits: a playlist covers at most **24 h**; a clip at most **1 h**.
- Clips copy whole segments and their init segments to
  `clips/{account_id}/{clip_id}/` (no re-encoding), so they survive raw
  retention and source deletion. Deleting a clip deletes its objects.
- `GET /v1/sources/{id}/timeline` returns recorded ranges and gaps, computed
  in SQL (gaps-and-islands), for the console timeline.
