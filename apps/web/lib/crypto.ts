import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  type CipherGCM,
  type DecipherGCM,
} from "node:crypto";

// Application-level secret encryption.
//
// Stored format: "v1:<base64-iv>:<base64-ciphertext-and-tag>"
// The v1 prefix lets us rotate algorithm/key by introducing v2 in the
// future without a schema change — decrypt() dispatches on the prefix.
//
// Master key is AGENTFLOW_SECRET_KEY: 64 hex chars (32 bytes) for AES-256.
// Generate one with: openssl rand -hex 32
// Set on Vercel (web) and Fly (worker), never NEXT_PUBLIC_*.

const ALG = "aes-256-gcm";
const IV_LEN = 12; // GCM standard
const TAG_LEN = 16;

function getMasterKey(): Buffer {
  const hex = process.env.AGENTFLOW_SECRET_KEY;
  if (!hex) {
    throw new Error(
      "AGENTFLOW_SECRET_KEY is not set. Generate with `openssl rand -hex 32` and add to the server env.",
    );
  }
  if (hex.length !== 64) {
    throw new Error(
      `AGENTFLOW_SECRET_KEY must be 64 hex chars (32 bytes); got ${hex.length}.`,
    );
  }
  return Buffer.from(hex, "hex");
}

export function encrypt(plaintext: string): string {
  const key = getMasterKey();
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALG, key, iv) as CipherGCM;
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  const payload = Buffer.concat([ciphertext, tag]);
  return `v1:${iv.toString("base64")}:${payload.toString("base64")}`;
}

export function decrypt(stored: string): string {
  const parts = stored.split(":");
  if (parts.length !== 3 || parts[0] !== "v1") {
    throw new Error("Invalid ciphertext format");
  }
  const iv = Buffer.from(parts[1]!, "base64");
  const payload = Buffer.from(parts[2]!, "base64");
  const ciphertext = payload.subarray(0, payload.length - TAG_LEN);
  const tag = payload.subarray(payload.length - TAG_LEN);

  const key = getMasterKey();
  const decipher = createDecipheriv(ALG, key, iv) as DecipherGCM;
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString(
    "utf8",
  );
}

export function last4(s: string): string {
  return s.length <= 4 ? s : s.slice(-4);
}
