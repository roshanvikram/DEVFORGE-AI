import crypto from "node:crypto";
import { config } from "../config.js";

const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function scrypt(pw: string, salt: Buffer, keylen: number, opts: crypto.ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => crypto.scrypt(pw, salt, keylen, opts, (err, key) => (err ? reject(err) : resolve(key))));
}

/** Password hashing with scrypt (memory-hard). Format: scrypt$N$r$p$salt$hash */
export async function hashPassword(pw: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(pw, salt, 64, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export async function verifyPassword(pw: string, stored: string | null | undefined): Promise<boolean> {
  if (!stored) {
    // Do equivalent work so response timing doesn't reveal whether the account exists.
    await scrypt(pw, crypto.randomBytes(16), 64, SCRYPT);
    return false;
  }
  const [alg, N, r, p, saltB64, hashB64] = stored.split("$");
  if (alg !== "scrypt") return false;
  const expected = Buffer.from(hashB64, "base64");
  const got = await scrypt(pw, Buffer.from(saltB64, "base64"), expected.length, { N: Number(N), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem });
  return got.length === expected.length && crypto.timingSafeEqual(got, expected);
}

const KEY = crypto.createHash("sha256").update("devforge-secrets:" + config.appSecret).digest();

/** AES-256-GCM encryption for secrets at rest (API keys, OAuth tokens). */
export function encryptSecret(plain: string): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", KEY, iv);
  const enc = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return ["v1", iv.toString("base64"), c.getAuthTag().toString("base64"), enc.toString("base64")].join(":");
}

export function decryptSecret(blob: string | null | undefined): string | null {
  if (!blob) return null;
  const [v, iv, tag, data] = blob.split(":");
  if (v !== "v1") return null;
  try {
    const d = crypto.createDecipheriv("aes-256-gcm", KEY, Buffer.from(iv, "base64"));
    d.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([d.update(Buffer.from(data, "base64")), d.final()]).toString("utf8");
  } catch {
    return null;
  }
}

export const last4 = (s: string) => (s.length > 4 ? s.slice(-4) : "****");
