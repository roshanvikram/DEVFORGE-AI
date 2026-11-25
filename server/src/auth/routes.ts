import { Router, type Request } from "express";
import { z } from "zod";
import { db, now } from "../db/db.js";
import { newId, randomToken, sha256 } from "../lib/ids.js";
import { hashPassword, verifyPassword, encryptSecret } from "../lib/crypto.js";
import { parse, email, password } from "../lib/validate.js";
import { badRequest, conflict, unauthorized, tooMany, notFound } from "../lib/errors.js";
import { hit } from "../lib/ratelimit.js";
import { createSession, setSessionCookie, requireAuth, SESSION_COOKIE } from "./session.js";
import { sendMail } from "../lib/mailer.js";
import { config } from "../config.js";
import { audit } from "../lib/audit.js";
import { permissionsFor, type Role } from "./rbac.js";

export const authRouter = Router();

const MAX_FAILED = 8;
const LOCK_MINUTES = 15;

function issueToken(userId: string, kind: "verify_email" | "reset_password" | "oauth_state", ttlMinutes: number) {
  const token = randomToken(32);
  db()
    .prepare(`INSERT INTO auth_tokens (id, user_id, kind, token_hash, expires_at) VALUES (?,?,?,?,?)`)
    .run(newId("tok_"), userId, kind, sha256(token), new Date(Date.now() + ttlMinutes * 60_000).toISOString());
  return token;
}

function consumeToken(token: string, kind: string): string | null {
  const row = db().prepare(`SELECT id, user_id, expires_at, used_at FROM auth_tokens WHERE token_hash = ? AND kind = ?`).get(sha256(token), kind) as any;
  if (!row || row.used_at || row.expires_at < now()) return null;
  db().prepare(`UPDATE auth_tokens SET used_at = ? WHERE id = ?`).run(now(), row.id);
  return row.user_id;
}

async function sendVerification(userId: string, to: string) {
  const token = issueToken(userId, "verify_email", 60 * 24);
  const link = `${config.appUrl}/verify-email?token=${token}`;
  return sendMail(to, "Verify your DevForge AI email", `Welcome to DevForge AI.\n\nConfirm your email address:\n${link}\n\nThis link expires in 24 hours.`);
}

export function userPayload(userId: string) {
  const u = db().prepare(`SELECT id, email, name, email_verified_at, avatar_url, created_at, password_hash IS NOT NULL AS has_password FROM users WHERE id = ?`).get(userId) as any;
  const workspaces = db()
    .prepare(
      `SELECT w.id, w.name, w.slug, m.role, o.name AS org_name, o.id AS org_id FROM memberships m JOIN workspaces w ON w.id = m.workspace_id JOIN organizations o ON o.id = w.org_id WHERE m.user_id = ? ORDER BY m.created_at`,
    )
    .all(userId) as any[];
  const onboarding = db().prepare(`SELECT step, data, completed_at FROM onboarding WHERE user_id = ?`).get(userId) as any;
  const providers = db().prepare(`SELECT provider FROM oauth_accounts WHERE user_id = ?`).all(userId).map((r: any) => r.provider);
  return {
    user: { ...u, has_password: !!u.has_password, providers },
    workspaces: workspaces.map((w) => ({ ...w, permissions: permissionsFor(w.role as Role) })),
    onboarding: onboarding ? { step: onboarding.step, data: JSON.parse(onboarding.data), completed: !!onboarding.completed_at } : { step: 1, data: {}, completed: false },
  };
}

authRouter.get("/providers", (_req, res) => {
  res.json({ email: true, github: !!config.oauth.github, google: !!config.oauth.google, smtp: !!config.smtp });
});

authRouter.post("/register", async (req, res) => {
  if (!hit(`register:${req.ip}`, 10, 3600_000)) throw tooMany();
  const body = parse(z.object({ name: z.string().trim().min(1).max(80), email, password, inviteToken: z.string().optional() }), req.body);
  const exists = db().prepare(`SELECT 1 FROM users WHERE email = ?`).get(body.email);
  if (exists) throw conflict("An account with this email already exists");
  const id = newId("usr_");
  db().prepare(`INSERT INTO users (id, email, name, password_hash) VALUES (?,?,?,?)`).run(id, body.email, body.name, await hashPassword(body.password));
  db().prepare(`INSERT INTO onboarding (user_id, step) VALUES (?, 1)`).run(id);
  if (body.inviteToken) acceptInvitation(body.inviteToken, id, body.email);
  const mail = await sendVerification(id, body.email);
  const s = createSession(id, req);
  setSessionCookie(res, s.token, s.expiresAt);
  audit({ actorId: id, action: "auth.register", entityType: "user", entityId: id, ip: req.ip });
  res.status(201).json({ ...userPayload(id), emailDelivery: mail.delivered });
});

authRouter.post("/login", async (req, res) => {
  const body = parse(z.object({ email, password: z.string().min(1).max(200) }), req.body);
  if (!hit(`login-ip:${req.ip}`, 30, 15 * 60_000)) throw tooMany("Too many login attempts. Try again in a few minutes.");
  if (!hit(`login-email:${body.email}`, 10, 15 * 60_000)) throw tooMany("Too many login attempts for this account. Try again later.");
  const u = db().prepare(`SELECT id, password_hash, failed_logins, locked_until FROM users WHERE email = ?`).get(body.email) as any;
  if (u?.locked_until && u.locked_until > now()) throw tooMany("Account temporarily locked after repeated failed logins. Try again later or reset your password.");
  const ok = await verifyPassword(body.password, u?.password_hash);
  if (!u || !ok) {
    if (u) {
      const failed = u.failed_logins + 1;
      const lock = failed >= MAX_FAILED ? new Date(Date.now() + LOCK_MINUTES * 60_000).toISOString() : null;
      db().prepare(`UPDATE users SET failed_logins = ?, locked_until = ? WHERE id = ?`).run(lock ? 0 : failed, lock, u.id);
      audit({ actorId: u.id, action: "auth.login_failed", entityType: "user", entityId: u.id, ip: req.ip });
    }
    throw unauthorized("Invalid email or password");
  }
  db().prepare(`UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = ?`).run(u.id);
  const s = createSession(u.id, req);
  setSessionCookie(res, s.token, s.expiresAt);
  audit({ actorId: u.id, action: "auth.login", entityType: "user", entityId: u.id, ip: req.ip });
  res.json(userPayload(u.id));
});

authRouter.post("/logout", (req, res) => {
  const token = req.cookies?.[SESSION_COOKIE];
  if (token) db().prepare(`DELETE FROM sessions WHERE token_hash = ?`).run(sha256(token));
  res.clearCookie(SESSION_COOKIE, { path: "/" });
  if (req.user) audit({ actorId: req.user.id, action: "auth.logout", ip: req.ip });
  res.json({ ok: true });
});

authRouter.get("/me", requireAuth, (req, res) => {
  res.json({ ...userPayload(req.user!.id), activeWorkspaceId: req.session!.activeWorkspaceId, sessionExpiresAt: req.session!.expiresAt });
});

authRouter.post("/verify-email/request", requireAuth, async (req, res) => {
  if (!hit(`verify:${req.user!.id}`, 5, 3600_000)) throw tooMany();
  if (req.user!.email_verified_at) return res.json({ ok: true, alreadyVerified: true });
  const r = await sendVerification(req.user!.id, req.user!.email);
  res.json({ ok: true, delivery: r.delivered });
});

authRouter.post("/verify-email/confirm", (req, res) => {
  const { token } = parse(z.object({ token: z.string().min(10).max(200) }), req.body);
  const userId = consumeToken(token, "verify_email");
  if (!userId) throw badRequest("This verification link is invalid or has expired");
  db().prepare(`UPDATE users SET email_verified_at = ?, updated_at = ? WHERE id = ?`).run(now(), now(), userId);
  audit({ actorId: userId, action: "auth.email_verified", entityType: "user", entityId: userId });
  res.json({ ok: true });
});

authRouter.post("/forgot-password", async (req, res) => {
  const body = parse(z.object({ email }), req.body);
  if (!hit(`forgot:${req.ip}`, 5, 3600_000) || !hit(`forgot-email:${body.email}`, 3, 3600_000)) throw tooMany();
  const u = db().prepare(`SELECT id FROM users WHERE email = ?`).get(body.email) as any;
  if (u) {
    const token = issueToken(u.id, "reset_password", 60);
    await sendMail(body.email, "Reset your DevForge AI password", `A password reset was requested for your account.\n\nReset it here (valid for 1 hour):\n${config.appUrl}/reset-password?token=${token}\n\nIf you didn't request this, ignore this email.`);
    audit({ actorId: u.id, action: "auth.password_reset_requested", ip: req.ip });
  }
  // Same response whether or not the account exists (no user enumeration).
  res.json({ ok: true });
});

authRouter.post("/reset-password", async (req, res) => {
  const body = parse(z.object({ token: z.string().min(10).max(200), password }), req.body);
  const userId = consumeToken(body.token, "reset_password");
  if (!userId) throw badRequest("This reset link is invalid or has expired");
  db().prepare(`UPDATE users SET password_hash = ?, failed_logins = 0, locked_until = NULL, updated_at = ? WHERE id = ?`).run(await hashPassword(body.password), now(), userId);
  db().prepare(`DELETE FROM sessions WHERE user_id = ?`).run(userId);
  audit({ actorId: userId, action: "auth.password_reset", entityType: "user", entityId: userId, ip: req.ip });
  res.json({ ok: true });
});

authRouter.patch("/profile", requireAuth, (req, res) => {
  const body = parse(z.object({ name: z.string().trim().min(1).max(80).optional(), avatar_url: z.string().url().max(500).nullable().optional() }), req.body);
  if (body.name !== undefined) db().prepare(`UPDATE users SET name = ?, updated_at = ? WHERE id = ?`).run(body.name, now(), req.user!.id);
  if (body.avatar_url !== undefined) db().prepare(`UPDATE users SET avatar_url = ?, updated_at = ? WHERE id = ?`).run(body.avatar_url, now(), req.user!.id);
  audit({ actorId: req.user!.id, action: "user.profile_updated", entityType: "user", entityId: req.user!.id });
  res.json(userPayload(req.user!.id));
});

authRouter.post("/change-password", requireAuth, async (req, res) => {
  const body = parse(z.object({ current: z.string().max(200).optional(), next: password }), req.body);
  const u = db().prepare(`SELECT password_hash FROM users WHERE id = ?`).get(req.user!.id) as any;
  if (u.password_hash && !(await verifyPassword(body.current ?? "", u.password_hash))) throw unauthorized("Current password is incorrect");
  db().prepare(`UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?`).run(await hashPassword(body.next), now(), req.user!.id);
  db().prepare(`DELETE FROM sessions WHERE user_id = ? AND id != ?`).run(req.user!.id, req.session!.id);
  audit({ actorId: req.user!.id, action: "auth.password_changed", ip: req.ip });
  res.json({ ok: true });
});

authRouter.get("/sessions", requireAuth, (req, res) => {
  const rows = db().prepare(`SELECT id, ip, user_agent, created_at, last_seen_at, expires_at FROM sessions WHERE user_id = ? ORDER BY last_seen_at DESC`).all(req.user!.id) as any[];
  res.json(rows.map((r) => ({ ...r, current: r.id === req.session!.id })));
});

authRouter.delete("/sessions/:id", requireAuth, (req, res) => {
  const r = db().prepare(`DELETE FROM sessions WHERE id = ? AND user_id = ?`).run(req.params.id, req.user!.id);
  if (!r.changes) throw notFound();
  audit({ actorId: req.user!.id, action: "auth.session_revoked", ip: req.ip });
  res.json({ ok: true });
});

authRouter.post("/active-workspace", requireAuth, (req, res) => {
  const { workspaceId } = parse(z.object({ workspaceId: z.string() }), req.body);
  const m = db().prepare(`SELECT 1 FROM memberships WHERE workspace_id = ? AND user_id = ?`).get(workspaceId, req.user!.id);
  if (!m) throw notFound("Workspace not found");
  db().prepare(`UPDATE sessions SET active_workspace_id = ? WHERE id = ?`).run(workspaceId, req.session!.id);
  res.json({ ok: true });
});

export function acceptInvitation(token: string, userId: string, userEmail: string) {
  const inv = db().prepare(`SELECT * FROM invitations WHERE token_hash = ?`).get(sha256(token)) as any;
  if (!inv || inv.accepted_at || inv.revoked_at || inv.expires_at < now()) throw badRequest("Invitation is invalid or expired");
  if (inv.email.toLowerCase() !== userEmail.toLowerCase()) throw badRequest("This invitation was sent to a different email address");
  db().transaction(() => {
    db().prepare(`INSERT OR IGNORE INTO memberships (id, workspace_id, user_id, role) VALUES (?,?,?,?)`).run(newId("mem_"), inv.workspace_id, userId, inv.role);
    db().prepare(`UPDATE invitations SET accepted_at = ? WHERE id = ?`).run(now(), inv.id);
  })();
  audit({ workspaceId: inv.workspace_id, actorId: userId, action: "member.joined", entityType: "invitation", entityId: inv.id, data: { role: inv.role } });
  return inv.workspace_id as string;
}

authRouter.post("/invitations/accept", requireAuth, (req, res) => {
  const { token } = parse(z.object({ token: z.string().min(10) }), req.body);
  const wsId = acceptInvitation(token, req.user!.id, req.user!.email);
  db().prepare(`UPDATE sessions SET active_workspace_id = ? WHERE id = ?`).run(wsId, req.session!.id);
  res.json({ ok: true, workspaceId: wsId });
});

// ---------------- OAuth (GitHub / Google) ----------------
const oauthStates = new Map<string, { provider: string; exp: number; linkUserId?: string }>();

const PROVIDERS = {
  github: {
    authorize: "https://github.com/login/oauth/authorize",
    token: "https://github.com/login/oauth/access_token",
    scope: "read:user user:email repo",
  },
  google: {
    authorize: "https://accounts.google.com/o/oauth2/v2/auth",
    token: "https://oauth2.googleapis.com/token",
    scope: "openid email profile",
  },
} as const;

function callbackUrl(provider: string) {
  return `${config.appUrl}/api/auth/oauth/${provider}/callback`;
}

authRouter.get("/oauth/:provider/start", (req: Request, res) => {
  const provider = req.params.provider as "github" | "google";
  const creds = config.oauth[provider];
  if (!creds) return res.redirect(`${config.appUrl}/login?error=${provider}_not_configured`);
  const state = randomToken(24);
  oauthStates.set(state, { provider, exp: Date.now() + 10 * 60_000, linkUserId: req.user?.id });
  const p = PROVIDERS[provider];
  const url = new URL(p.authorize);
  url.searchParams.set("client_id", creds.clientId);
  url.searchParams.set("redirect_uri", callbackUrl(provider));
  url.searchParams.set("scope", p.scope);
  url.searchParams.set("state", state);
  if (provider === "google") url.searchParams.set("response_type", "code");
  res.redirect(url.toString());
});

authRouter.get("/oauth/:provider/callback", async (req, res) => {
  const provider = req.params.provider as "github" | "google";
  const creds = config.oauth[provider];
  const state = String(req.query.state ?? "");
  const st = oauthStates.get(state);
  oauthStates.delete(state);
  if (!creds || !st || st.exp < Date.now() || st.provider !== provider) return res.redirect(`${config.appUrl}/login?error=oauth_state`);
  try {
    const tokenRes = await fetch(PROVIDERS[provider].token, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: creds.clientId, client_secret: creds.clientSecret, code: String(req.query.code ?? ""), redirect_uri: callbackUrl(provider), grant_type: "authorization_code" }),
    });
    const tok = (await tokenRes.json()) as any;
    if (!tok.access_token) throw new Error("no access token");
    let profile: { id: string; email: string; name: string; avatar?: string };
    if (provider === "github") {
      const h = { Authorization: `Bearer ${tok.access_token}`, Accept: "application/vnd.github+json", "User-Agent": "DevForge-AI" };
      const u = (await (await fetch("https://api.github.com/user", { headers: h })).json()) as any;
      const emails = (await (await fetch("https://api.github.com/user/emails", { headers: h })).json()) as any[];
      const primary = Array.isArray(emails) ? emails.find((e) => e.primary && e.verified) : null;
      if (!primary) throw new Error("GitHub account has no verified primary email");
      profile = { id: String(u.id), email: primary.email, name: u.name || u.login, avatar: u.avatar_url };
    } else {
      const u = (await (await fetch("https://openidconnect.googleapis.com/v1/userinfo", { headers: { Authorization: `Bearer ${tok.access_token}` } })).json()) as any;
      if (!u.email_verified) throw new Error("Google email not verified");
      profile = { id: String(u.sub), email: u.email, name: u.name || u.email, avatar: u.picture };
    }
    const linked = db().prepare(`SELECT user_id FROM oauth_accounts WHERE provider = ? AND provider_account_id = ?`).get(provider, profile.id) as any;
    let userId: string = linked?.user_id ?? st.linkUserId;
    if (!userId) {
      const existing = db().prepare(`SELECT id FROM users WHERE email = ?`).get(profile.email.toLowerCase()) as any;
      if (existing) userId = existing.id;
      else {
        userId = newId("usr_");
        db().prepare(`INSERT INTO users (id, email, name, avatar_url, email_verified_at) VALUES (?,?,?,?,?)`).run(userId, profile.email.toLowerCase(), profile.name, profile.avatar ?? null, now());
        db().prepare(`INSERT INTO onboarding (user_id, step) VALUES (?, 1)`).run(userId);
      }
    }
    db()
      .prepare(
        `INSERT INTO oauth_accounts (id, user_id, provider, provider_account_id, access_token_enc, scope) VALUES (?,?,?,?,?,?)
         ON CONFLICT(provider, provider_account_id) DO UPDATE SET access_token_enc = excluded.access_token_enc, scope = excluded.scope`,
      )
      .run(newId("oa_"), userId, provider, profile.id, encryptSecret(tok.access_token), tok.scope ?? null);
    db().prepare(`UPDATE users SET email_verified_at = COALESCE(email_verified_at, ?) WHERE id = ?`).run(now(), userId);
    const s = createSession(userId, req);
    setSessionCookie(res, s.token, s.expiresAt);
    audit({ actorId: userId, action: `auth.oauth_login`, data: { provider }, ip: req.ip });
    res.redirect(`${config.appUrl}/app`);
  } catch (e) {
    res.redirect(`${config.appUrl}/login?error=oauth_failed`);
  }
});
