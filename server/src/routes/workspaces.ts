import { Router } from "express";
import { z } from "zod";
import { db, now, json } from "../db/db.js";
import { newId, randomToken, sha256 } from "../lib/ids.js";
import { parse, slugify, email } from "../lib/validate.js";
import { requireAuth, requireWorkspace, requirePerm } from "../auth/session.js";
import { audit } from "../lib/audit.js";
import { badRequest, notFound, forbidden, conflict } from "../lib/errors.js";
import { permissionsFor, type Role } from "../auth/rbac.js";
import { sendMail } from "../lib/mailer.js";
import { config } from "../config.js";

export const workspacesRouter = Router();

workspacesRouter.post("/workspaces", requireAuth, (req, res) => {
  const body = parse(z.object({ name: z.string().trim().min(2).max(60), orgName: z.string().trim().min(2).max(80).optional() }), req.body);
  const orgId = newId("org_");
  const wsId = newId("wsp_");
  const orgName = body.orgName ?? body.name;
  let slug = slugify(orgName);
  if (db().prepare(`SELECT 1 FROM organizations WHERE slug = ?`).get(slug)) slug = `${slug}-${randomToken(3).toLowerCase().replace(/[^a-z0-9]/g, "")}`;
  db().transaction(() => {
    db().prepare(`INSERT INTO organizations (id, name, slug, owner_id) VALUES (?,?,?,?)`).run(orgId, orgName, slug, req.user!.id);
    db().prepare(`INSERT INTO workspaces (id, org_id, name, slug) VALUES (?,?,?,?)`).run(wsId, orgId, body.name, slugify(body.name));
    db().prepare(`INSERT INTO memberships (id, workspace_id, user_id, role) VALUES (?,?,?, 'owner')`).run(newId("mem_"), wsId, req.user!.id);
    db().prepare(`UPDATE sessions SET active_workspace_id = ? WHERE id = ?`).run(wsId, req.session!.id);
  })();
  audit({ workspaceId: wsId, actorId: req.user!.id, action: "workspace.created", entityType: "workspace", entityId: wsId, ip: req.ip });
  res.status(201).json({ id: wsId, name: body.name, orgId });
});

workspacesRouter.get("/workspace", requireWorkspace, (req, res) => {
  const w = db().prepare(`SELECT w.id, w.name, w.slug, w.created_at, o.id AS org_id, o.name AS org_name FROM workspaces w JOIN organizations o ON o.id = w.org_id WHERE w.id = ?`).get(req.workspaceId) as any;
  const counts = db().prepare(`SELECT (SELECT COUNT(*) FROM memberships WHERE workspace_id = ?) AS members, (SELECT COUNT(*) FROM repositories WHERE workspace_id = ?) AS repositories`).get(req.workspaceId, req.workspaceId);
  res.json({ ...w, role: req.role, permissions: permissionsFor(req.role!), counts });
});

workspacesRouter.patch("/workspace", requireWorkspace, requirePerm("workspace.manage"), (req, res) => {
  const body = parse(z.object({ name: z.string().trim().min(2).max(60) }), req.body);
  db().prepare(`UPDATE workspaces SET name = ? WHERE id = ?`).run(body.name, req.workspaceId);
  audit({ workspaceId: req.workspaceId, actorId: req.user!.id, action: "workspace.updated", entityType: "workspace", entityId: req.workspaceId, data: body });
  res.json({ ok: true });
});

workspacesRouter.delete("/workspace", requireWorkspace, requirePerm("workspace.delete"), (req, res) => {
  const body = parse(z.object({ confirm: z.string() }), req.body);
  const w = db().prepare(`SELECT name FROM workspaces WHERE id = ?`).get(req.workspaceId) as any;
  if (body.confirm !== w.name) throw badRequest("Type the workspace name to confirm deletion");
  db().prepare(`DELETE FROM workspaces WHERE id = ?`).run(req.workspaceId);
  audit({ actorId: req.user!.id, action: "workspace.deleted", entityType: "workspace", entityId: req.workspaceId, data: { name: w.name } });
  res.json({ ok: true });
});

// ---------- members & invitations ----------
workspacesRouter.get("/members", requireWorkspace, (req, res) => {
  const members = db().prepare(`SELECT m.id, m.role, m.created_at, u.id AS user_id, u.name, u.email, u.avatar_url FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ? ORDER BY m.created_at`).all(req.workspaceId);
  const invitations = db().prepare(`SELECT id, email, role, created_at, expires_at FROM invitations WHERE workspace_id = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ? ORDER BY created_at DESC`).all(req.workspaceId, now());
  res.json({ members, invitations });
});

workspacesRouter.post("/invitations", requireWorkspace, requirePerm("members.manage"), async (req, res) => {
  const body = parse(z.object({ email, role: z.enum(["admin", "engineer", "security", "viewer"]) }), req.body);
  if (body.role === "admin" && req.role !== "owner") throw forbidden("Only owners can invite admins");
  const existing = db().prepare(`SELECT 1 FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ? AND u.email = ?`).get(req.workspaceId, body.email);
  if (existing) throw conflict("This person is already a member");
  const token = randomToken(32);
  const id = newId("inv_");
  db().prepare(`INSERT INTO invitations (id, workspace_id, email, role, token_hash, invited_by, expires_at) VALUES (?,?,?,?,?,?,?)`).run(id, req.workspaceId, body.email, body.role, sha256(token), req.user!.id, new Date(Date.now() + 7 * 86400_000).toISOString());
  const ws = db().prepare(`SELECT name FROM workspaces WHERE id = ?`).get(req.workspaceId) as any;
  const mail = await sendMail(body.email, `You're invited to ${ws.name} on DevForge AI`, `${req.user!.name} invited you to join "${ws.name}" as ${body.role}.\n\nAccept: ${config.appUrl}/accept-invite?token=${token}\n\nThis invitation expires in 7 days.`);
  audit({ workspaceId: req.workspaceId, actorId: req.user!.id, action: "member.invited", entityType: "invitation", entityId: id, data: { email: body.email, role: body.role } });
  res.status(201).json({ id, delivery: mail.delivered });
});

workspacesRouter.delete("/invitations/:id", requireWorkspace, requirePerm("members.manage"), (req, res) => {
  const r = db().prepare(`UPDATE invitations SET revoked_at = ? WHERE id = ? AND workspace_id = ?`).run(now(), req.params.id, req.workspaceId);
  if (!r.changes) throw notFound();
  audit({ workspaceId: req.workspaceId, actorId: req.user!.id, action: "member.invitation_revoked", entityType: "invitation", entityId: String(req.params.id) });
  res.json({ ok: true });
});

workspacesRouter.patch("/members/:id", requireWorkspace, requirePerm("members.manage"), (req, res) => {
  const body = parse(z.object({ role: z.enum(["owner", "admin", "engineer", "security", "viewer"]) }), req.body);
  const m = db().prepare(`SELECT * FROM memberships WHERE id = ? AND workspace_id = ?`).get(req.params.id, req.workspaceId) as any;
  if (!m) throw notFound();
  if ((m.role === "owner" || body.role === "owner") && req.role !== "owner") throw forbidden("Only owners can change ownership");
  if (m.role === "owner" && body.role !== "owner") {
    const owners = (db().prepare(`SELECT COUNT(*) AS n FROM memberships WHERE workspace_id = ? AND role = 'owner'`).get(req.workspaceId) as any).n;
    if (owners <= 1) throw badRequest("A workspace must keep at least one owner");
  }
  db().prepare(`UPDATE memberships SET role = ? WHERE id = ?`).run(body.role, m.id);
  audit({ workspaceId: req.workspaceId, actorId: req.user!.id, action: "member.role_changed", entityType: "membership", entityId: m.id, data: { from: m.role, to: body.role } });
  res.json({ ok: true });
});

workspacesRouter.delete("/members/:id", requireWorkspace, (req, res) => {
  const m = db().prepare(`SELECT * FROM memberships WHERE id = ? AND workspace_id = ?`).get(req.params.id, req.workspaceId) as any;
  if (!m) throw notFound();
  const self = m.user_id === req.user!.id;
  if (!self && !["owner", "admin"].includes(req.role!)) throw forbidden();
  if (m.role === "owner") {
    const owners = (db().prepare(`SELECT COUNT(*) AS n FROM memberships WHERE workspace_id = ? AND role = 'owner'`).get(req.workspaceId) as any).n;
    if (owners <= 1) throw badRequest("The last owner cannot be removed");
    if (!self && req.role !== "owner") throw forbidden("Only owners can remove owners");
  }
  db().prepare(`DELETE FROM memberships WHERE id = ?`).run(m.id);
  audit({ workspaceId: req.workspaceId, actorId: req.user!.id, action: self ? "member.left" : "member.removed", entityType: "membership", entityId: m.id });
  res.json({ ok: true });
});

// ---------- onboarding (persisted, resumable) ----------
workspacesRouter.get("/onboarding", requireAuth, (req, res) => {
  const o = db().prepare(`SELECT step, data, completed_at FROM onboarding WHERE user_id = ?`).get(req.user!.id) as any;
  res.json(o ? { step: o.step, data: json(o.data, {}), completed: !!o.completed_at } : { step: 1, data: {}, completed: false });
});

workspacesRouter.put("/onboarding", requireAuth, (req, res) => {
  const body = parse(z.object({ step: z.number().int().min(1).max(9), data: z.record(z.string(), z.unknown()).default({}), completed: z.boolean().optional() }), req.body);
  db().prepare(`INSERT INTO onboarding (user_id, step, data, completed_at, updated_at) VALUES (?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET step = excluded.step, data = excluded.data, completed_at = COALESCE(excluded.completed_at, onboarding.completed_at), updated_at = excluded.updated_at`)
    .run(req.user!.id, body.step, JSON.stringify(body.data).slice(0, 20_000), body.completed ? now() : null, now());
  res.json({ ok: true });
});

export function roleOf(workspaceId: string, userId: string): Role | null {
  return ((db().prepare(`SELECT role FROM memberships WHERE workspace_id = ? AND user_id = ?`).get(workspaceId, userId) as any)?.role ?? null) as Role | null;
}
