import type { Request, Response, NextFunction } from "express";
import { db, now } from "../db/db.js";
import { newId, randomToken, sha256 } from "../lib/ids.js";
import { config } from "../config.js";
import { unauthorized, forbidden, badRequest } from "../lib/errors.js";
import { can, type Permission, type Role } from "./rbac.js";

export const SESSION_COOKIE = "df_session";

export type SessionUser = { id: string; email: string; name: string; email_verified_at: string | null; avatar_url: string | null; created_at: string };
export type Session = { id: string; user: SessionUser; activeWorkspaceId: string | null; expiresAt: string };

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      session?: Session;
      user?: SessionUser;
      workspaceId?: string;
      role?: Role;
    }
  }
}

export function createSession(userId: string, req: Request): { token: string; expiresAt: string } {
  const token = randomToken(32);
  const expiresAt = new Date(Date.now() + config.sessionTtlHours * 3600_000).toISOString();
  const ws = db().prepare(`SELECT workspace_id FROM memberships WHERE user_id = ? ORDER BY created_at LIMIT 1`).get(userId) as { workspace_id: string } | undefined;
  db()
    .prepare(`INSERT INTO sessions (id, user_id, token_hash, active_workspace_id, ip, user_agent, expires_at) VALUES (?,?,?,?,?,?,?)`)
    .run(newId("ses_"), userId, sha256(token), ws?.workspace_id ?? null, req.ip ?? null, String(req.headers["user-agent"] ?? "").slice(0, 300), expiresAt);
  return { token, expiresAt };
}

export function setSessionCookie(res: Response, token: string, expiresAt: string) {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: config.isProd,
    path: "/",
    expires: new Date(expiresAt),
  });
}

export function resolveSession(token: string): Session | null {
  const row = db()
    .prepare(
      `SELECT s.id, s.expires_at, s.active_workspace_id, s.last_seen_at, u.id AS uid, u.email, u.name, u.email_verified_at, u.avatar_url, u.created_at
       FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`,
    )
    .get(sha256(token)) as any;
  if (!row) return null;
  if (row.expires_at < now()) {
    db().prepare(`DELETE FROM sessions WHERE id = ?`).run(row.id);
    return null;
  }
  // Touch at most once per minute.
  if (Date.now() - Date.parse(row.last_seen_at) > 60_000) db().prepare(`UPDATE sessions SET last_seen_at = ? WHERE id = ?`).run(now(), row.id);
  return {
    id: row.id,
    expiresAt: row.expires_at,
    activeWorkspaceId: row.active_workspace_id,
    user: { id: row.uid, email: row.email, name: row.name, email_verified_at: row.email_verified_at, avatar_url: row.avatar_url, created_at: row.created_at },
  };
}

/** Populates req.session/req.user when a valid session cookie is present. */
export function loadSession(req: Request, _res: Response, next: NextFunction) {
  const token = req.cookies?.[SESSION_COOKIE];
  if (token) {
    const s = resolveSession(token);
    if (s) {
      req.session = s;
      req.user = s.user;
    }
  }
  next();
}

export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  if (!req.user) return next(unauthorized());
  next();
}

/**
 * Resolves the workspace for this request (X-Workspace-Id header, else the session's active workspace)
 * and verifies membership. Tenant isolation hinges on this middleware.
 */
export function requireWorkspace(req: Request, _res: Response, next: NextFunction) {
  if (!req.user) return next(unauthorized());
  const wsId = (req.headers["x-workspace-id"] as string | undefined) || req.session?.activeWorkspaceId;
  if (!wsId) return next(badRequest("No workspace selected. Create or select a workspace first.", { code: "no_workspace" }));
  const m = db().prepare(`SELECT role FROM memberships WHERE workspace_id = ? AND user_id = ?`).get(wsId, req.user.id) as { role: Role } | undefined;
  if (!m) return next(forbidden("You are not a member of this workspace"));
  req.workspaceId = wsId;
  req.role = m.role;
  next();
}

export const requirePerm = (perm: Permission) => (req: Request, _res: Response, next: NextFunction) => {
  if (!can(req.role, perm)) return next(forbidden(`Your role (${req.role ?? "none"}) cannot perform: ${perm}`));
  next();
};

/** CSRF defence: state-changing requests must carry a custom header that cross-site forms cannot set. */
export function csrfGuard(req: Request, _res: Response, next: NextFunction) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  if (req.path.startsWith("/api/auth/oauth/")) return next();
  if (req.headers["x-requested-with"] !== "devforge") return next(forbidden("Missing CSRF header"));
  const origin = req.headers.origin;
  if (origin) {
    const allowed = [new URL(config.appUrl).origin, `http://localhost:${config.port}`, `http://127.0.0.1:${config.port}`];
    if (!allowed.includes(origin)) return next(forbidden("Cross-origin request rejected"));
  }
  next();
}
