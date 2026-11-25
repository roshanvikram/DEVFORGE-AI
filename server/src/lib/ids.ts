import crypto from "node:crypto";
export const newId = (prefix = "") => prefix + crypto.randomBytes(12).toString("base64url").replace(/[-_]/g, "x").slice(0, 16);
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString("base64url");
export const sha256 = (s: string | Buffer) => crypto.createHash("sha256").update(s).digest("hex");
