import { Router } from "express";
import { z } from "zod";
import { db, now, json } from "../db/db.js";
import { newId } from "../lib/ids.js";
import { parse } from "../lib/validate.js";
import { requireWorkspace, requirePerm } from "../auth/session.js";
import { notFound, badRequest } from "../lib/errors.js";
import { audit, notify } from "../lib/audit.js";

export const findingsRouter = Router();
findingsRouter.use(requireWorkspace);

const listQuery = z.object({
  repo: z.string().optional(),
  source: z.string().optional(), // comma separated
  severity: z.string().optional(),
  status: z.string().optional(),
  origin: z.enum(["detected", "ai_hypothesis"]).optional(),
  category: z.string().optional(),
  tool: z.string().optional(),
  file: z.string().optional(),
  assignee: z.string().optional(),
  review: z.string().optional(),
  q: z.string().max(200).optional(),
  sort: z.enum(["severity", "newest", "oldest", "file"]).default("severity"),
  limit: z.coerce.number().int().min(1).max(1000).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

function buildWhere(workspaceId: string, q: z.infer<typeof listQuery>) {
  const where = ["f.workspace_id = ?"];
  const args: any[] = [workspaceId];
  const multi = (col: string, v?: string) => {
    if (!v) return;
    const vals = v.split(",").filter(Boolean);
    where.push(`${col} IN (${vals.map(() => "?").join(",")})`);
    args.push(...vals);
  };
  if (q.repo) { where.push("f.repository_id = ?"); args.push(q.repo); }
  if (q.review) { where.push("f.review_id = ?"); args.push(q.review); } else where.push("f.review_id IS NULL");
  multi("f.source", q.source);
  multi("f.severity", q.severity);
  multi("f.status", q.status ?? (q.review ? undefined : "open,triaged,in_progress"));
  multi("f.category", q.category);
  multi("f.tool", q.tool);
  if (q.origin) { where.push("f.origin = ?"); args.push(q.origin); }
  if (q.file) { where.push("f.file_path LIKE ?"); args.push(`%${q.file}%`); }
  if (q.assignee) { if (q.assignee === "none") where.push("f.assignee_id IS NULL"); else { where.push("f.assignee_id = ?"); args.push(q.assignee); } }
  if (q.q) { where.push("(f.title LIKE ? OR f.file_path LIKE ? OR f.rule_id LIKE ? OR f.evidence LIKE ?)"); const like = `%${q.q}%`; args.push(like, like, like, like); }
  return { where: where.join(" AND "), args };
}
const SEV_SQL = "CASE f.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END";

findingsRouter.get("/", (req, res) => {
  const q = parse(listQuery, req.query);
  const { where, args } = buildWhere(req.workspaceId!, q);
  const order = q.sort === "newest" ? "f.first_seen_at DESC" : q.sort === "oldest" ? "f.first_seen_at" : q.sort === "file" ? "f.file_path, f.line" : `${SEV_SQL}, f.first_seen_at DESC`;
  const items = db().prepare(`SELECT f.id, f.repository_id, r.name AS repository, f.source, f.origin, f.tool, f.rule_id, f.title, f.category, f.severity, f.confidence, f.file_path, f.line, f.status, f.assignee_id, u.name AS assignee, f.first_seen_at, f.last_seen_at, f.review_id
    FROM findings f JOIN repositories r ON r.id = f.repository_id LEFT JOIN users u ON u.id = f.assignee_id WHERE ${where} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...args, q.limit, q.offset);
  const total = (db().prepare(`SELECT COUNT(*) AS n FROM findings f WHERE ${where}`).get(...args) as any).n;
  const facet = (col: string) => db().prepare(`SELECT ${col} AS k, COUNT(*) AS n FROM findings f WHERE ${where} GROUP BY ${col} ORDER BY n DESC LIMIT 40`).all(...args);
  res.json({ items, total, facets: { severity: facet("f.severity"), source: facet("f.source"), category: facet("f.category"), tool: facet("f.tool"), origin: facet("f.origin") } });
});

findingsRouter.get("/export", (req, res) => {
  const q = parse(listQuery.extend({ format: z.enum(["csv", "json"]).default("csv") }), { ...req.query, limit: 1000 });
  const { where, args } = buildWhere(req.workspaceId!, q);
  const rows = db().prepare(`SELECT f.id, r.name AS repository, f.source, f.origin, f.tool, f.rule_id, f.severity, f.confidence, f.category, f.title, f.file_path, f.line, f.status, f.evidence, f.recommendation, f.first_seen_at FROM findings f JOIN repositories r ON r.id = f.repository_id WHERE ${where} ORDER BY ${SEV_SQL} LIMIT 10000`).all(...args) as any[];
  audit({ workspaceId: req.workspaceId, actorId: req.user!.id, action: "findings.exported", data: { count: rows.length, format: q.format } });
  if (q.format === "json") {
    res.setHeader("Content-Disposition", `attachment; filename="devforge-findings.json"`);
    return res.json(rows);
  }
  const cols = Object.keys(rows[0] ?? { id: 1 });
  const esc = (v: unknown) => {
    const s = v == null ? "" : String(v);
    // Neutralise spreadsheet formula injection.
    const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
    return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="devforge-findings.csv"`);
  res.send([cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n"));
});

findingsRouter.get("/:id", (req, res) => {
  const f = db().prepare(`SELECT f.*, r.name AS repository, u.name AS assignee FROM findings f JOIN repositories r ON r.id = f.repository_id LEFT JOIN users u ON u.id = f.assignee_id WHERE f.id = ? AND f.workspace_id = ?`).get(req.params.id, req.workspaceId) as any;
  if (!f) throw notFound("Finding not found");
  const events = db().prepare(`SELECT e.kind, e.data, e.created_at, u.name AS actor FROM finding_events e LEFT JOIN users u ON u.id = e.actor_id WHERE e.finding_id = ? ORDER BY e.id`).all(f.id).map((e: any) => ({ ...e, data: json(e.data, {}) }));
  const comments = db().prepare(`SELECT c.id, c.body, c.created_at, u.name AS author, u.id AS author_id FROM comments c JOIN users u ON u.id = c.user_id WHERE c.entity_type = 'finding' AND c.entity_id = ? ORDER BY c.created_at`).all(f.id);
  const relatedFiles = f.file_path
    ? db().prepare(`SELECT DISTINCT sf.path FROM edges e JOIN files sf ON sf.id = e.source_file_id JOIN files tf ON tf.id = e.target_file_id JOIN repositories r ON r.current_snapshot_id = e.snapshot_id WHERE r.id = ? AND e.kind = 'import' AND tf.path = ? LIMIT 20`).all(f.repository_id, f.file_path).map((r: any) => r.path)
    : [];
  res.json({ ...f, related: json(f.related, []), events, comments, relatedFiles });
});

findingsRouter.patch("/:id", requirePerm("findings.update"), (req, res) => {
  const body = parse(z.object({ status: z.enum(["open", "triaged", "in_progress", "resolved", "ignored", "false_positive"]).optional(), assignee_id: z.string().nullable().optional(), note: z.string().max(2000).optional() }), req.body);
  const f = db().prepare(`SELECT * FROM findings WHERE id = ? AND workspace_id = ?`).get(req.params.id, req.workspaceId) as any;
  if (!f) throw notFound();
  if (body.assignee_id) {
    const m = db().prepare(`SELECT 1 FROM memberships WHERE workspace_id = ? AND user_id = ?`).get(req.workspaceId, body.assignee_id);
    if (!m) throw badRequest("Assignee must be a workspace member");
  }
  const t = now();
  if (body.status && body.status !== f.status) {
    db().prepare(`UPDATE findings SET status = ?, resolved_at = ?, updated_at = ? WHERE id = ?`).run(body.status, body.status === "resolved" ? t : null, t, f.id);
    db().prepare(`INSERT INTO finding_events (finding_id, actor_id, kind, data) VALUES (?,?,?,?)`).run(f.id, req.user!.id, "status_changed", JSON.stringify({ from: f.status, to: body.status, note: body.note }));
  }
  if (body.assignee_id !== undefined && body.assignee_id !== f.assignee_id) {
    db().prepare(`UPDATE findings SET assignee_id = ?, updated_at = ? WHERE id = ?`).run(body.assignee_id, t, f.id);
    db().prepare(`INSERT INTO finding_events (finding_id, actor_id, kind, data) VALUES (?,?,?,?)`).run(f.id, req.user!.id, "assigned", JSON.stringify({ to: body.assignee_id }));
    if (body.assignee_id && body.assignee_id !== req.user!.id) notify({ workspaceId: req.workspaceId!, userId: body.assignee_id, kind: "assignment", title: `Assigned: ${f.title}`, link: `/app/findings/${f.id}` });
  }
  audit({ workspaceId: req.workspaceId, actorId: req.user!.id, action: "finding.updated", entityType: "finding", entityId: f.id, data: body });
  res.json({ ok: true });
});

findingsRouter.post("/bulk", requirePerm("findings.update"), (req, res) => {
  const body = parse(z.object({ ids: z.array(z.string()).min(1).max(500), status: z.enum(["open", "triaged", "in_progress", "resolved", "ignored", "false_positive"]) }), req.body);
  const t = now();
  let n = 0;
  db().transaction(() => {
    for (const id of body.ids) {
      const f = db().prepare(`SELECT status FROM findings WHERE id = ? AND workspace_id = ?`).get(id, req.workspaceId) as any;
      if (!f || f.status === body.status) continue;
      db().prepare(`UPDATE findings SET status = ?, resolved_at = ?, updated_at = ? WHERE id = ?`).run(body.status, body.status === "resolved" ? t : null, t, id);
      db().prepare(`INSERT INTO finding_events (finding_id, actor_id, kind, data) VALUES (?,?,?,?)`).run(id, req.user!.id, "status_changed", JSON.stringify({ from: f.status, to: body.status, bulk: true }));
      n++;
    }
  })();
  audit({ workspaceId: req.workspaceId, actorId: req.user!.id, action: "finding.bulk_updated", data: { count: n, status: body.status } });
  res.json({ updated: n });
});

findingsRouter.post("/:id/comments", requirePerm("comments.create"), (req, res) => {
  const body = parse(z.object({ body: z.string().trim().min(1).max(5000) }), req.body);
  const f = db().prepare(`SELECT id, title FROM findings WHERE id = ? AND workspace_id = ?`).get(req.params.id, req.workspaceId) as any;
  if (!f) throw notFound();
  const id = newId("cmt_");
  db().prepare(`INSERT INTO comments (id, workspace_id, entity_type, entity_id, user_id, body) VALUES (?,?, 'finding', ?,?,?)`).run(id, req.workspaceId, f.id, req.user!.id, body.body);
  audit({ workspaceId: req.workspaceId, actorId: req.user!.id, action: "comment.created", entityType: "finding", entityId: f.id });
  res.status(201).json({ id });
});
