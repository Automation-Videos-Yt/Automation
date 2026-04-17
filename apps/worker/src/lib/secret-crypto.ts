import crypto from "node:crypto";
import { env } from "../config/env";

const PREFIX = "enc:v1:";

function keyBuffer(): Buffer {
  const raw = env.YOUTUBE_TOKEN_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error("YOUTUBE_TOKEN_ENCRYPTION_KEY is not configured");
  }
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    return Buffer.from(raw, "hex");
  }
  return Buffer.from(raw, "base64");
}

export function encryptSecret(plainText: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", keyBuffer(), iv);
  const encrypted = Buffer.concat([
    cipher.update(plainText, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString("base64")}:${tag.toString("base64")}:${encrypted.toString("base64")}`;
}

export function decryptSecret(secret: string): string {
  if (!secret.startsWith(PREFIX)) {
    return secret;
  }

  const payload = secret.slice(PREFIX.length).split(":");
  if (payload.length !== 3) {
    throw new Error("invalid encrypted secret payload");
  }

  const [ivB64, tagB64, ciphertextB64] = payload;
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    keyBuffer(),
    Buffer.from(ivB64, "base64"),
  );
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(ciphertextB64, "base64")),
    decipher.final(),
  ]);
  return decrypted.toString("utf8");
}
