# 10. Continuous recording as a `segments` egress type

Date: 2026-10-15 · Status: accepted · Amended by ADR 0049, 0050 (segments are a feed egress sink; segment events are callbacks)

## Decision
Recording is a new egress type, `segments`, in the egress engine. It runs
continuously per source, writes the main stream (plus audio if the source
opts in) as fMP4 segments to object storage under
`raw/{account_id}/{source_id}/...` with **no re-encoding**, and announces each
one on `media.segment.written`. The API builds the segment index from those
events. Existing session-based egress types are unchanged.
