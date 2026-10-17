// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Encryption at rest for secrets the API must read back, such as webhook
// signing secrets (they are needed in clear to sign each delivery, so they
// cannot be hashed). AES-256-GCM with a key from SECRETS_ENCRYPTION_KEY.
// Stored form: `enc:v1:<base64url(iv | tag | ciphertext)>` (ADR 0027).
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const PREFIX = "enc:v1:";

export interface SecretBox {
  encrypt(plain: string): string;
  /** Decrypts stored values; unencrypted values come back unchanged. */
  decrypt(stored: string): string;
  isEncrypted(stored: string): boolean;
}

export function createSecretBox(keyMaterial: string): SecretBox {
  if (!keyMaterial || keyMaterial.length < 32) throw new Error("SECRETS_ENCRYPTION_KEY must be at least 32 characters");
  const key = createHash("sha256").update(keyMaterial).digest();
  return {
    encrypt(plain) {
      const iv = randomBytes(12);
      const c = createCipheriv("aes-256-gcm", key, iv);
      const body = Buffer.concat([c.update(plain, "utf8"), c.final()]);
      return PREFIX + Buffer.concat([iv, c.getAuthTag(), body]).toString("base64url");
    },
    decrypt(stored) {
      if (!stored.startsWith(PREFIX)) return stored;
      const raw = Buffer.from(stored.slice(PREFIX.length), "base64url");
      const d = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
      d.setAuthTag(raw.subarray(12, 28));
      return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString("utf8");
    },
    isEncrypted: (stored) => stored.startsWith(PREFIX),
  };
}

export const newSecretsKey = () => randomBytes(32).toString("base64url");
