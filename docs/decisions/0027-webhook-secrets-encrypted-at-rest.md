# 27. Webhook signing secrets encrypted at rest

Date: 2026-10-17 · Status: accepted

## Context
Webhook signing secrets must be readable to sign each delivery, so they can't
be hashed like API keys. They were stored in plain text.

## Decision
- Secrets are encrypted with AES-256-GCM before they are stored, as
  `enc:v1:<iv|tag|ciphertext>`, with a key derived from `SECRETS_ENCRYPTION_KEY`
  (at least 32 characters). The key never reaches the database.
- In production the API refuses to start without the key. Outside production a
  key is generated once and stored with the other instance secrets.
- Rows stored in plain text before this change are encrypted at startup
  (idempotent). Decryption passes legacy plain values through, so a partly
  migrated table keeps working.
- The secret is shown once, at creation, as before.

## Consequences
Rotating the key needs a re-encryption job (not built yet). Losing the key
means webhooks must be re-created. A database dump alone no longer reveals
the secrets.
