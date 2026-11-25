import { db } from "../db/db.js";
import { newId } from "./ids.js";
import { publish, publishToUser } from "./events.js";

export function audit(params: {
  workspaceId?: string | null;
  actorId?: string | null;
  actorType?: "user" | "agent" | "system" | "workflow";
  action: string;
  entityType?: string;
  entityId?: string;
  data?: Record<string, unknown>;
  ip?: string;
}) {
  const info = db()
    .prepare(`INSERT INTO activity_logs (workspace_id, actor_id, actor_type, action, entity_type, entity_id, data, ip) VALUES (?,?,?,?,?,?,?,?)`)
    .run(params.workspaceId ?? null, params.actorId ?? null, params.actorType ?? "user", params.action, params.entityType ?? null, params.entityId ?? null, JSON.stringify(params.data ?? {}), params.ip ?? null);
  if (params.workspaceId) publish(params.workspaceId, { type: "activity", id: Number(info.lastInsertRowid), action: params.action });
}

/** Record an in-app notification for one user (or every member of a workspace when userId is omitted). */
export function notify(params: { workspaceId: string; userId?: string; kind: string; title: string; body?: string; link?: string; roles?: string[] }) {
  const recipients: string[] = params.userId
    ? [params.userId]
    : (db()
        .prepare(`SELECT user_id FROM memberships WHERE workspace_id = ?${params.roles ? ` AND role IN (${params.roles.map(() => "?").join(",")})` : ""}`)
        .all(params.workspaceId, ...(params.roles ?? [])) as { user_id: string }[]).map((r) => r.user_id);
  const stmt = db().prepare(`INSERT INTO notifications (id, workspace_id, user_id, kind, title, body, link) VALUES (?,?,?,?,?,?,?)`);
  for (const uid of recipients) {
    const id = newId("ntf_");
    stmt.run(id, params.workspaceId, uid, params.kind, params.title, params.body ?? null, params.link ?? null);
    publishToUser(uid, { type: "notification", id, title: params.title, kind: params.kind, link: params.link });
  }
}
