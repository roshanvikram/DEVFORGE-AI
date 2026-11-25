import type { Server } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { resolveSession } from "../auth/session.js";
import { db } from "../db/db.js";

/**
 * Workspace-scoped realtime event hub over WebSocket.
 * Clients connect to /api/events?workspace=<id> with their session cookie.
 */
type Client = { ws: WebSocket; userId: string; workspaceId: string };
const clients = new Set<Client>();

export type AppEvent = { type: string; [k: string]: unknown };

export function publish(workspaceId: string, event: AppEvent) {
  const msg = JSON.stringify({ ...event, at: new Date().toISOString() });
  for (const c of clients) {
    if (c.workspaceId === workspaceId && c.ws.readyState === WebSocket.OPEN) c.ws.send(msg);
  }
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
      const c: Client = { ws, userId: sess.user.id, workspaceId };
      clients.add(c);
      ws.on("close", () => clients.delete(c));
      ws.on("error", () => clients.delete(c));
      ws.send(JSON.stringify({ type: "hello", at: new Date().toISOString() }));
    });
  });
  const ping = setInterval(() => {
    for (const c of clients) if (c.ws.readyState === WebSocket.OPEN) c.ws.ping();
  }, 25_000);
  ping.unref();
}
