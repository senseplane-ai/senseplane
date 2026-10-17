# 9. Senses are a flat, open list

Date: 2026-10-15 · Status: accepted

## Decision
`Sense = "video" | "audio" | "temperature" | "humidity"`, one per thing
measured, matching the locked "senses in v1". Grants are per sense. The enum is
open: new senses (`co2`, `contact`, `presence`, `power`) are added as sensors
arrive, and clients must accept unknown values. The MCP tool keeps the name
`read_environment`.
