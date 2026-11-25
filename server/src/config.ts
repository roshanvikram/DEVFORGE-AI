import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const SERVER_ROOT = path.resolve(here, "..");
export const PROJECT_ROOT = path.resolve(SERVER_ROOT, "..");

/** Minimal .env loader (no dependency). Existing process env wins. */
function loadDotEnv(file: string) {
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = val;
  }
}
loadDotEnv(path.join(PROJECT_ROOT, ".env"));
loadDotEnv(path.join(SERVER_ROOT, ".env"));

const env = process.env;
const isTest = env.NODE_ENV === "test" || !!env.VITEST;

export const DATA_DIR = path.resolve(env.DATA_DIR ?? path.join(PROJECT_ROOT, "data", isTest ? `test-${process.pid}` : "app"));
fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });

/** APP_SECRET is used for encrypting stored secrets. In dev it is generated once and kept in DATA_DIR. */
function resolveAppSecret(): string {
  if (env.APP_SECRET && env.APP_SECRET.length >= 32) return env.APP_SECRET;
  if (env.NODE_ENV === "production") throw new Error("APP_SECRET (>=32 chars) must be set in production");
  const file = path.join(DATA_DIR, ".app-secret");
  if (fs.existsSync(file)) return fs.readFileSync(file, "utf8").trim();
  const s = crypto.randomBytes(48).toString("base64url");
  fs.writeFileSync(file, s, { mode: 0o600 });
  return s;
}

export const config = {
  env: env.NODE_ENV ?? "development",
  isProd: env.NODE_ENV === "production",
  isTest,
  port: Number(env.PORT ?? 4000),
  appUrl: env.APP_URL ?? "http://localhost:5173",
  dataDir: DATA_DIR,
  dbPath: env.DATABASE_PATH ?? path.join(DATA_DIR, "devforge.db"),
  reposDir: path.join(DATA_DIR, "repos"),
  sandboxDir: path.join(DATA_DIR, "sandbox"),
  appSecret: resolveAppSecret(),
  sessionTtlHours: Number(env.SESSION_TTL_HOURS ?? 24 * 7),
  /** Local repository import is only allowed from these roots (comma separated). Empty = disabled. */
  localImportRoots: (env.LOCAL_IMPORT_ROOTS ?? "").split(",").map((s) => s.trim()).filter(Boolean).map((p) => path.resolve(p)),
  /** Allowed git hosts for URL import. "*" allows any public host (private/loopback IPs are always blocked). */
  gitHostAllowlist: (env.GIT_HOST_ALLOWLIST ?? "github.com,gitlab.com,bitbucket.org,codeberg.org").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
  maxRepoBytes: Number(env.MAX_REPO_MB ?? 300) * 1024 * 1024,
  maxIndexedFiles: Number(env.MAX_INDEXED_FILES ?? 8000),
  maxFileBytes: Number(env.MAX_FILE_KB ?? 512) * 1024,
  /** sandbox mode for running repository code: auto | macos | docker | disabled */
  sandboxMode: (env.SANDBOX_MODE ?? "auto") as "auto" | "macos" | "docker" | "disabled",
  sandboxTimeoutMs: Number(env.SANDBOX_TIMEOUT_SEC ?? 180) * 1000,
  osvEnabled: (env.OSV_ENABLED ?? "true") !== "false",
  ai: {
    model: env.DEVFORGE_AI_MODEL ?? "claude-opus-5-5",
    timeoutMs: Number(env.AI_TIMEOUT_SEC ?? 300) * 1000,
  },
  smtp: env.SMTP_HOST
    ? { host: env.SMTP_HOST, port: Number(env.SMTP_PORT ?? 587), user: env.SMTP_USER, pass: env.SMTP_PASS, from: env.SMTP_FROM ?? "DevForge AI <no-reply@devforge.local>" }
    : null,
  oauth: {
    github: env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET ? { clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET } : null,
    google: env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET ? { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET } : null,
  },
};

fs.mkdirSync(config.reposDir, { recursive: true, mode: 0o700 });
fs.mkdirSync(config.sandboxDir, { recursive: true, mode: 0o700 });
