import type { Server } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { resolveSession } from "../auth/session.js";
import { db } from "../db/db.js";

/**
 * Workspace-scoped realtime event hub over WebSocket.
 * Clients connect to /api/events?workspace=<id> with their session cookie.
 */
type Client = { ws: WebSocket; userId: string; workspaceId: string; name: string; avatar: string | null; path: string; since: string; lastActive: string };
const clients = new Set<Client>();

export type AppEvent = { type: string; [k: string]: unknown };

const counters = { published: 0, delivered: 0, startedAt: Date.now() };
const recent: number[] = []; // publish timestamps over the last minute (events/min)

export function publish(workspaceId: string, event: AppEvent) {
  const msg = JSON.stringify({ ...event, at: new Date().toISOString() });
  counters.published++;
  const t = Date.now();
  recent.push(t);
  while (recent.length && recent[0] < t - 60_000) recent.shift();
  for (const c of clients) {
    if (c.workspaceId === workspaceId && c.ws.readyState === WebSocket.OPEN) {
      c.ws.send(msg);
      counters.delivered++;
    }
  }
}

/** Who is online in a workspace right now (one entry per user; most recent tab wins). */
export function presence(workspaceId: string) {
  const byUser = new Map<string, { userId: string; name: string; avatar: string | null; path: string; since: string; lastActive: string; tabs: number }>();
  for (const c of clients) {
    if (c.workspaceId !== workspaceId || c.ws.readyState !== WebSocket.OPEN) continue;
    const e = byUser.get(c.userId);
    if (!e) byUser.set(c.userId, { userId: c.userId, name: c.name, avatar: c.avatar, path: c.path, since: c.since, lastActive: c.lastActive, tabs: 1 });
    else {
      e.tabs++;
      if (c.lastActive > e.lastActive) Object.assign(e, { path: c.path, lastActive: c.lastActive });
      if (c.since < e.since) e.since = c.since;
    }
  }
  return [...byUser.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function broadcastPresence(workspaceId: string) {
  publish(workspaceId, { type: "presence", users: presence(workspaceId) });
}

export function hubStats(workspaceId?: string) {
  const t = Date.now();
  while (recent.length && recent[0] < t - 60_000) recent.shift();
  return {
    connections: [...clients].filter((c) => !workspaceId || c.workspaceId === workspaceId).length,
    totalConnections: clients.size,
    eventsPublished: counters.published,
    eventsDelivered: counters.delivered,
    eventsPerMinute: recent.length,
  };
}

export function publishToUser(userId: string, event: AppEvent) {
  const msg = JSON.stringify({ ...event, at: new Date().toISOString() });
  for (const c of clients) if (c.userId === userId && c.ws.readyState === WebSocket.OPEN) c.ws.send(msg);
}

function cookieValue(header: string | undefined, name: string): string | undefined {
  if (!header) return;
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
}

export function attachEvents(server: Server) {
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname !== "/api/events") return socket.destroy();
    const token = cookieValue(req.headers.cookie, "df_session");
    const sess = token ? resolveSession(token) : null;
    const workspaceId = url.searchParams.get("workspace") ?? "";
    if (!sess) return socket.destroy();
    const member = db().prepare(`SELECT 1 FROM memberships WHERE workspace_id = ? AND user_id = ?`).get(workspaceId, sess.user.id);
    if (!member) return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => {
      const ts = new Date().toISOString();
      const c: Client = { ws, userId: sess.user.id, workspaceId, name: sess.user.name || sess.user.email.split("@")[0], avatar: sess.user.avatar_url ?? null, path: "/app", since: ts, lastActive: ts };
      clients.add(c);
      const drop = () => {
        if (clients.delete(c)) broadcastPresence(workspaceId);
      };
      ws.on("close", drop);
      ws.on("error", drop);
      // Clients report the page they are viewing; only a sanitized in-app path is accepted.
      ws.on("message", (data) => {
        if ((data as Buffer).length > 512) return;
        try {
          const m = JSON.parse(String(data));
          if (m?.type === "presence" && typeof m.path === "string" && /^\/app[\w\-/]*$/.test(m.path)) {
            c.path = m.path.slice(0, 80);
            c.lastActive = new Date().toISOString();
            broadcastPresence(workspaceId);
          }
        } catch {
          /* ignore malformed client messages */
        }
      });
      ws.send(JSON.stringify({ type: "hello", at: ts }));
      broadcastPresence(workspaceId);
    });
  });
  const ping = setInterval(() => {
    for (const c of clients) if (c.ws.readyState === WebSocket.OPEN) c.ws.ping();
  }, 25_000);
  ping.unref();
}
