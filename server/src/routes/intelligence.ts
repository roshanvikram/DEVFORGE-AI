import { Router, type Request } from "express";
import { z } from "zod";
import { db, json } from "../db/db.js";
import { newId } from "../lib/ids.js";
import { parse } from "../lib/validate.js";
import { requireWorkspace, requirePerm } from "../auth/session.js";
import { badRequest, notFound, tooMany } from "../lib/errors.js";
import { hit } from "../lib/ratelimit.js";
import { audit } from "../lib/audit.js";
import { enqueue } from "../jobs/queue.js";
import { getRepo } from "../services/analysis.js";
import { getSettings, updateSettings } from "../services/integrations.js";
import { ask, getQuery, indexStatus } from "../services/rag.js";
import { DEFAULT_EFFORT, loadItems } from "../services/quantum.js";
import { advisoryHistory, enqueueAdvisoryCheck } from "../services/advisories.js";
import { config } from "../config.js";

export const intelligenceRouter = Router();
intelligenceRouter.use(requireWorkspace);

function repoOr404(req: Request) {
  const r = getRepo(req.workspaceId!, String(req.params.id));
  if (!r) throw notFound("Repository not found");
  if (!r.current_snapshot_id) throw badRequest("Repository has not been indexed yet", { code: "not_indexed" });
  return r;
}

/* ─────────── 1. RAG copilot ─────────── */
intelligenceRouter.get("/repositories/:id/rag", (req, res) => {
  const r = repoOr404(req);
  const history = db().prepare(`SELECT id, question, status, provider, model, total_ms, created_at FROM rag_queries WHERE repository_id = ? AND user_id = ? ORDER BY created_at DESC LIMIT 20`).all(r.id, req.user!.id);
  res.json({ index: indexStatus(r.id), history });
});
intelligenceRouter.post("/repositories/:id/rag/index", requirePerm("analysis.run"), (req, res) => {
  const r = repoOr404(req);
  res.status(202).json({ jobId: enqueue("rag.index", req.workspaceId!, { repositoryId: r.id }, { userId: req.user!.id }) });
});
intelligenceRouter.post("/repositories/:id/rag/ask", requirePerm("ai.use"), async (req, res) => {
  const r = repoOr404(req);
  const { question } = parse(z.object({ question: z.string().trim().min(3).max(2000) }), req.body);
  if (!hit(`rag:${req.user!.id}`, 20, 60_000)) throw tooMany();
  const id = await ask({ workspaceId: req.workspaceId!, repositoryId: r.id, userId: req.user!.id, question });
  res.status(202).json({ id });
});
intelligenceRouter.get("/rag/queries/:qid", (req, res) => {
  const q = getQuery(String(req.params.qid), req.workspaceId!);
  if (!q || q.user_id !== req.user!.id) throw notFound();
  res.json(q);
});

/* ─────────── 2. Quantum-inspired fix-plan optimiser ─────────── */
const effortSchema = z.record(z.enum(["secret", "dependency", "security", "bug", "performance", "debt"]), z.number().min(0.1).max(80));
intelligenceRouter.get("/repositories/:id/optimizer", (req, res) => {
  const r = repoOr404(req);
  const items = loadItems(r.id, {});
  const plans = (db().prepare(`SELECT id, status, params, result, error, created_at, finished_at FROM fix_plans WHERE repository_id = ? ORDER BY created_at DESC LIMIT 10`).all(r.id) as any[]).map((p) => {
    const result = json<any>(p.result, null);
    return { ...p, params: json(p.params, {}), result: result ? { ...result, trace: undefined, skipped: undefined, selected: undefined, selectedCount: result.selected?.length } : null };
  });
  res.json({ candidates: items.length, totalHours: Math.round(items.reduce((a, i) => a + i.cost, 0) * 10) / 10, defaultEffort: DEFAULT_EFFORT, plans });
});
intelligenceRouter.post("/repositories/:id/optimizer", requirePerm("analysis.run"), (req, res) => {
  const r = repoOr404(req);
  const b = parse(z.object({ budgetHours: z.number().min(0.5).max(2000), effort: effortSchema.optional(), sweeps: z.number().int().min(50).max(5000).optional(), replicas: z.number().int().min(2).max(64).optional(), seed: z.number().int().min(0).max(2 ** 31).optional() }), req.body);
  const id = newId("plan_");
  db().prepare(`INSERT INTO fix_plans (id, workspace_id, repository_id, params, created_by) VALUES (?,?,?,?,?)`).run(id, req.workspaceId, r.id, JSON.stringify(b), req.user!.id);
  const jobId = enqueue("quantum.optimize", req.workspaceId!, { planId: id, repositoryId: r.id }, { userId: req.user!.id });
  audit({ workspaceId: req.workspaceId, actorId: req.user!.id, action: "optimizer.started", entityType: "fix_plan", entityId: id, data: { budgetHours: b.budgetHours } });
  res.status(202).json({ id, jobId });
});
intelligenceRouter.get("/fix-plans/:pid", (req, res) => {
  const p = db().prepare(`SELECT * FROM fix_plans WHERE id = ? AND workspace_id = ?`).get(req.params.pid, req.workspaceId) as any;
  if (!p) throw notFound();
  res.json({ ...p, params: json(p.params, {}), result: json(p.result, null) });
});

/* ─────────── 3. Advisory watch ─────────── */
intelligenceRouter.get("/repositories/:id/advisories", (req, res) => {
  const r = repoOr404(req);
  const deps = db().prepare(`SELECT COUNT(*) AS n, SUM(vulns != '[]') AS vulnerable FROM dependencies WHERE snapshot_id = ?`).get(r.current_snapshot_id) as any;
  res.json({
    enabled: (getSettings(req.workspaceId!).analysis as any).advisoryWatch !== false,
    osvEnabled: config.osvEnabled,
    intervalHours: Number(process.env.ADVISORY_WATCH_HOURS ?? 12),
    packages: deps.n ?? 0,
    vulnerablePackages: deps.vulnerable ?? 0,
    history: advisoryHistory(r.id),
  });
});
intelligenceRouter.post("/repositories/:id/advisories/check", requirePerm("analysis.run"), (req, res) => {
  const r = repoOr404(req);
  if (!hit(`advcheck:${r.id}`, 4, 60_000)) throw tooMany();
  res.status(202).json(enqueueAdvisoryCheck(req.workspaceId!, r.id, "manual", req.user!.id));
});
intelligenceRouter.put("/advisory-watch", requirePerm("settings.manage"), (req, res) => {
  const { enabled } = parse(z.object({ enabled: z.boolean() }), req.body);
  updateSettings(req.workspaceId!, { analysis: { ...(getSettings(req.workspaceId!).analysis as any), advisoryWatch: enabled } } as any);
  audit({ workspaceId: req.workspaceId, actorId: req.user!.id, action: "advisory_watch.updated", data: { enabled } });
  res.json({ enabled });
});
