import { Router } from "express";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { db, json } from "../db/db.js";
import { newId } from "../lib/ids.js";
import { parse } from "../lib/validate.js";
import { requireWorkspace, requirePerm } from "../auth/session.js";
import { badRequest, notFound } from "../lib/errors.js";
import { audit } from "../lib/audit.js";
import { enqueue } from "../jobs/queue.js";
import { validateGitUrl, validateLocalPath, gitCommits } from "../engine/ingest.js";
import { getRepo, repoDir, PRESETS, SCAN_KINDS } from "../services/analysis.js";
import { searchCode, searchSymbols } from "../services/search.js";
import { architectureSummary, healthScore } from "../services/metrics.js";
import { shortestPath } from "../engine/graph.js";

export const reposRouter = Router();
reposRouter.use(requireWorkspace);

function repoOr404(req: any) {
  const r = getRepo(req.workspaceId, String(req.params.id));
  if (!r) throw notFound("Repository not found");
  return r;
}
function snapshotOr400(repo: any) {
  if (!repo.current_snapshot_id) throw badRequest("Repository has not been indexed yet", { code: "not_indexed" });
  return repo.current_snapshot_id as string;
}

reposRouter.get("/", (req, res) => {
  const rows = db().prepare(`SELECT r.*, s.stats, s.commit_sha FROM repositories r LEFT JOIN snapshots s ON s.id = r.current_snapshot_id WHERE r.workspace_id = ? ORDER BY r.created_at DESC`).all(req.workspaceId) as any[];
  res.json(rows.map((r) => ({ id: r.id, name: r.name, source_type: r.source_type, source_url: r.source_type === "local" ? null : r.source_url, default_branch: r.default_branch, status: r.status, error: r.error, languages: json(r.languages, {}), frameworks: json(r.frameworks, []), last_analyzed_at: r.last_analyzed_at, created_at: r.created_at, commit: r.commit_sha, stats: json(r.stats, null), health: healthScore(r.id) })));
});

reposRouter.post("/", requirePerm("repo.create"), async (req, res) => {
  const body = parse(z.object({
    source: z.enum(["git", "github", "local"]),
    url: z.string().max(500).optional(),
    path: z.string().max(1000).optional(),
    name: z.string().trim().min(1).max(100).optional(),
    branch: z.string().regex(/^[\w./-]{1,100}$/).optional(),
    preset: z.enum(["quick", "full", "security", "architecture"]).default("quick"),
  }), req.body);
  let sourceUrl: string;
  let name: string;
  if (body.source === "local") {
    if (!body.path) throw badRequest("path is required for local import");
    sourceUrl = validateLocalPath(body.path);
    name = body.name ?? path.basename(sourceUrl);
  } else {
    if (!body.url) throw badRequest("url is required");
    const u = await validateGitUrl(body.url);
    if (body.source === "github" && u.hostname !== "github.com") throw badRequest("GitHub source must be a github.com URL");
    sourceUrl = u.toString().replace(/\/$/, "");
    name = body.name ?? u.pathname.split("/").filter(Boolean).slice(-2).join("/").replace(/\.git$/, "");
  }
  const id = newId("rep_");
  db().prepare(`INSERT INTO repositories (id, workspace_id, name, source_type, source_url, default_branch, local_path, status, created_by) VALUES (?,?,?,?,?,?,?, 'pending', ?)`)
    .run(id, req.workspaceId, name, body.source, sourceUrl, body.branch ?? null, repoDir(id), req.user!.id);
  const jobId = enqueue("repo.import", req.workspaceId!, { repositoryId: id, kinds: PRESETS[body.preset] }, { userId: req.user!.id });
  audit({ workspaceId: req.workspaceId, actorId: req.user!.id, action: "repository.connected", entityType: "repository", entityId: id, data: { source: body.source, preset: body.preset }, ip: req.ip });
  res.status(201).json({ id, jobId });
});

reposRouter.get("/:id", (req, res) => {
  const r = repoOr404(req);
  const snap = r.current_snapshot_id ? (db().prepare(`SELECT * FROM snapshots WHERE id = ?`).get(r.current_snapshot_id) as any) : null;
  const activeJob = db().prepare(`SELECT id, type, status, progress, message FROM jobs WHERE workspace_id = ? AND status IN ('queued','running') AND json_extract(payload,'$.repositoryId') = ? ORDER BY created_at DESC LIMIT 1`).get(req.workspaceId, r.id);
  res.json({ ...r, local_path: undefined, source_url: r.source_type === "local" ? null : r.source_url, languages: json(r.languages, {}), frameworks: json(r.frameworks, []), snapshot: snap ? { ...snap, stats: json(snap.stats, {}) } : null, health: healthScore(r.id), activeJob });
});

reposRouter.delete("/:id", requirePerm("repo.delete"), (req, res) => {
  const r = repoOr404(req);
  db().prepare(`DELETE FROM code_fts WHERE snapshot_id IN (SELECT id FROM snapshots WHERE repository_id = ?)`).run(r.id);
  db().prepare(`DELETE FROM repositories WHERE id = ?`).run(r.id);
  fs.rmSync(repoDir(r.id), { recursive: true, force: true });
  audit({ workspaceId: req.workspaceId, actorId: req.user!.id, action: "repository.deleted", entityType: "repository", entityId: r.id, data: { name: r.name } });
  res.json({ ok: true });
});

reposRouter.post("/:id/analyze", requirePerm("analysis.run"), (req, res) => {
  const r = repoOr404(req);
  const body = parse(z.object({ kinds: z.array(z.enum(SCAN_KINDS)).min(1).optional(), preset: z.enum(["quick", "full", "security", "architecture"]).optional() }), req.body);
  const kinds = body.kinds ?? PRESETS[body.preset ?? "full"];
  const type = r.current_snapshot_id ? "repo.analyze" : "repo.import";
  const jobId = enqueue(type, req.workspaceId!, { repositoryId: r.id, kinds }, { userId: req.user!.id });
  audit({ workspaceId: req.workspaceId, actorId: req.user!.id, action: "analysis.started", entityType: "repository", entityId: r.id, data: { kinds } });
  res.status(202).json({ jobId, kinds });
});

reposRouter.post("/:id/refresh", requirePerm("analysis.run"), (req, res) => {
  const r = repoOr404(req);
  const body = parse(z.object({ preset: z.enum(["quick", "full", "security", "architecture"]).default("quick") }), req.body ?? {});
  const jobId = enqueue("repo.import", req.workspaceId!, { repositoryId: r.id, kinds: PRESETS[body.preset], refresh: true }, { userId: req.user!.id });
  audit({ workspaceId: req.workspaceId, actorId: req.user!.id, action: "repository.refreshed", entityType: "repository", entityId: r.id });
  res.status(202).json({ jobId });
});

reposRouter.get("/:id/tree", (req, res) => {
  const snap = snapshotOr400(repoOr404(req));
  const files = db().prepare(`SELECT f.id, f.path, f.language, f.loc, f.size, f.complexity, f.is_test, (SELECT COUNT(*) FROM findings x JOIN repositories r ON r.id = x.repository_id WHERE r.current_snapshot_id = f.snapshot_id AND x.file_path = f.path AND x.review_id IS NULL AND x.status IN ('open','triaged','in_progress')) AS findings FROM files f WHERE f.snapshot_id = ? ORDER BY f.path`).all(snap);
  res.json(files);
});

reposRouter.get("/:id/file", (req, res) => {
  const r = repoOr404(req);
  const snap = snapshotOr400(r);
  const p = String(req.query.path ?? "");
  const f = db().prepare(`SELECT * FROM files WHERE snapshot_id = ? AND path = ?`).get(snap, p) as any;
  if (!f) throw notFound("File not found in index");
  const root = repoDir(r.id);
  const abs = path.resolve(root, f.path);
  if (!abs.startsWith(root + path.sep)) throw badRequest("Invalid path");
  const content = fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : "";
  const symbols = db().prepare(`SELECT id, name, kind, parent, line, end_line, signature, exported, complexity FROM symbols WHERE file_id = ? ORDER BY line`).all(f.id);
  const findings = db().prepare(`SELECT id, title, severity, source, origin, line, rule_id, status FROM findings WHERE repository_id = ? AND file_path = ? AND review_id IS NULL AND status IN ('open','triaged','in_progress') ORDER BY line`).all(r.id, f.path);
  const imports = db().prepare(`SELECT COALESCE(tf.path, e.target_external) AS target, tf.path IS NOT NULL AS internal, e.target_symbol AS names, e.line FROM edges e LEFT JOIN files tf ON tf.id = e.target_file_id WHERE e.snapshot_id = ? AND e.kind = 'import' AND e.source_file_id = ?`).all(snap, f.id);
  const importedBy = db().prepare(`SELECT DISTINCT sf.path FROM edges e JOIN files sf ON sf.id = e.source_file_id WHERE e.snapshot_id = ? AND e.kind = 'import' AND e.target_file_id = ?`).all(snap, f.id);
  res.json({ file: f, content: content.length > 1_000_000 ? content.slice(0, 1_000_000) : content, symbols, findings, imports, importedBy });
});

reposRouter.get("/:id/symbols", (req, res) => {
  const snap = snapshotOr400(repoOr404(req));
  const q = String(req.query.q ?? "");
  const kind = req.query.kind ? String(req.query.kind) : null;
  if (q) return res.json(searchSymbols(snap, q, 100));
  res.json(db().prepare(`SELECT s.id, s.name, s.kind, s.parent, s.line, s.end_line, s.signature, s.exported, s.complexity, s.meta, f.path FROM symbols s JOIN files f ON f.id = s.file_id WHERE s.snapshot_id = ? ${kind ? "AND s.kind = ?" : ""} ORDER BY f.path, s.line LIMIT 2000`).all(snap, ...(kind ? [kind] : [])).map((s: any) => ({ ...s, meta: json(s.meta, {}) })));
});

reposRouter.get("/:id/references", (req, res) => {
  const snap = snapshotOr400(repoOr404(req));
  const name = String(req.query.symbol ?? "");
  if (!name) throw badRequest("symbol is required");
  const callers = db().prepare(`SELECT sf.path, e.source_symbol AS caller, e.line, tf.path AS defined_in FROM edges e JOIN files sf ON sf.id = e.source_file_id JOIN files tf ON tf.id = e.target_file_id WHERE e.snapshot_id = ? AND e.kind = 'call' AND e.target_symbol = ? LIMIT 200`).all(snap, name);
  const textual = searchCode(snap, name, { exact: true, limit: 50 });
  res.json({ callers, textual });
});

reposRouter.get("/:id/search", (req, res) => {
  const snap = snapshotOr400(repoOr404(req));
  const q = String(req.query.q ?? "").slice(0, 200);
  if (!q.trim()) return res.json({ code: [], symbols: [] });
  res.json({ code: searchCode(snap, q, { exact: req.query.exact === "1", limit: 40, pathFilter: req.query.path ? String(req.query.path) : undefined }), symbols: searchSymbols(snap, q, 20) });
});

reposRouter.get("/:id/commits", async (req, res) => {
  const r = repoOr404(req);
  res.json(await gitCommits(repoDir(r.id), 50));
});

reposRouter.get("/:id/architecture", (req, res) => {
  const r = repoOr404(req);
  const snap = snapshotOr400(r);
  const summary = architectureSummary(snap, r.id);
  const files = db().prepare(`SELECT id, path, language, loc, complexity, is_test FROM files WHERE snapshot_id = ? AND language IN ('typescript','javascript','python','go','rust','java','ruby','php','vue','svelte','prisma','sql')`).all(snap) as any[];
  const edges = db().prepare(`SELECT source_file_id AS source, target_file_id AS target, COUNT(*) AS weight FROM edges WHERE snapshot_id = ? AND kind = 'import' AND target_file_id IS NOT NULL AND source_file_id != target_file_id GROUP BY source_file_id, target_file_id`).all(snap);
  const external = db().prepare(`SELECT target_external AS name, COUNT(DISTINCT source_file_id) AS files FROM edges WHERE snapshot_id = ? AND kind = 'import' AND target_external IS NOT NULL GROUP BY target_external ORDER BY files DESC LIMIT 40`).all(snap);
  const kinds = db().prepare(`SELECT f.id AS file_id, s.kind, COUNT(*) AS n FROM symbols s JOIN files f ON f.id = s.file_id WHERE s.snapshot_id = ? AND s.kind IN ('route','model','class','function','component') GROUP BY f.id, s.kind`).all(snap) as any[];
  const findings = db().prepare(`SELECT file_path, COUNT(*) AS n, MIN(CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END) AS worst FROM findings WHERE repository_id = ? AND review_id IS NULL AND status IN ('open','triaged','in_progress') GROUP BY file_path`).all(r.id) as any[];
  const fMap = new Map(findings.map((f) => [f.file_path, f]));
  const kMap = new Map<string, Record<string, number>>();
  for (const k of kinds) (kMap.get(k.file_id) ?? kMap.set(k.file_id, {}).get(k.file_id)!)[k.kind] = k.n;
  const nodes = files.map((f) => ({ ...f, symbols: kMap.get(f.id) ?? {}, findings: fMap.get(f.path)?.n ?? 0, worst: ["critical", "high", "medium", "low", "info"][fMap.get(f.path)?.worst ?? 5] ?? null }));
  res.json({ summary, nodes, edges, external });
});

reposRouter.get("/:id/path", (req, res) => {
  const snap = snapshotOr400(repoOr404(req));
  const from = String(req.query.from ?? "");
  const to = String(req.query.to ?? "");
  const edges = db().prepare(`SELECT sf.path AS s, tf.path AS t FROM edges e JOIN files sf ON sf.id = e.source_file_id JOIN files tf ON tf.id = e.target_file_id WHERE e.snapshot_id = ? AND e.kind = 'import'`).all(snap) as any[];
  const adj = new Map<string, string[]>();
  for (const e of edges) (adj.get(e.s) ?? adj.set(e.s, []).get(e.s)!).push(e.t);
  res.json({ path: shortestPath(from, to, adj) });
});

reposRouter.get("/:id/dependencies", (req, res) => {
  const r = repoOr404(req);
  const snap = snapshotOr400(r);
  const deps = (db().prepare(`SELECT * FROM dependencies WHERE snapshot_id = ? ORDER BY name`).all(snap) as any[]).map((d) => ({ ...d, vulns: json(d.vulns, []) }));
  const lastScan = db().prepare(`SELECT id, status, tools, summary, finished_at FROM scans WHERE repository_id = ? AND kind = 'dependency' ORDER BY created_at DESC LIMIT 1`).get(r.id) as any;
  const usage = db().prepare(`SELECT target_external AS name, COUNT(DISTINCT source_file_id) AS files FROM edges WHERE snapshot_id = ? AND kind = 'import' AND target_external IS NOT NULL GROUP BY target_external`).all(snap) as any[];
  const usageMap = new Map(usage.map((u) => [u.name, u.files]));
  res.json({ dependencies: deps.map((d) => ({ ...d, importedByFiles: usageMap.get(d.name) ?? 0 })), lastScan: lastScan ? { ...lastScan, tools: json(lastScan.tools, {}), summary: json(lastScan.summary, {}) } : null });
});

reposRouter.get("/:id/scans", (req, res) => {
  const r = repoOr404(req);
  const rows = db().prepare(`SELECT * FROM scans WHERE repository_id = ? ORDER BY created_at DESC LIMIT 100`).all(r.id) as any[];
  res.json(rows.map((s) => ({ ...s, tools: json(s.tools, {}), summary: json(s.summary, {}) })));
});
