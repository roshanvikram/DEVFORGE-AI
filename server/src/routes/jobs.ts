import { Router } from "express";
import { db, json } from "../db/db.js";
import { requireWorkspace, requirePerm } from "../auth/session.js";
import { notFound, badRequest } from "../lib/errors.js";
import { cancelJob, retryJob } from "../jobs/queue.js";
import { audit } from "../lib/audit.js";
import { dashboard } from "../services/metrics.js";
import { detectTools } from "../engine/external.js";
import { sandboxMode } from "../sandbox/runner.js";
import { aiStatus } from "../ai/provider.js";

export const jobsRouter = Router();
jobsRouter.use(requireWorkspace);

jobsRouter.get("/jobs", (req, res) => {
  const status = req.query.status ? String(req.query.status).split(",") : null;
  const rows = db().prepare(`SELECT id, type, status, progress, message, error, attempts, created_at, started_at, finished_at, payload FROM jobs WHERE workspace_id = ? ${status ? `AND status IN (${status.map(() => "?").join(",")})` : ""} ORDER BY created_at DESC LIMIT 100`).all(req.workspaceId, ...(status ?? [])) as any[];
  res.json(rows.map((r) => ({ ...r, payload: json(r.payload, {}) })));
});

jobsRouter.get("/jobs/:id", (req, res) => {
  const j = db().prepare(`SELECT * FROM jobs WHERE id = ? AND workspace_id = ?`).get(req.params.id, req.workspaceId) as any;
  if (!j) throw notFound();
  const logs = db().prepare(`SELECT level, message, created_at FROM job_logs WHERE job_id = ? ORDER BY id LIMIT 2000`).all(j.id);
  res.json({ ...j, payload: json(j.payload, {}), result: json(j.result, null), logs });
});

jobsRouter.post("/jobs/:id/cancel", requirePerm("analysis.run"), (req, res) => {
  const j = db().prepare(`SELECT id FROM jobs WHERE id = ? AND workspace_id = ?`).get(req.params.id, req.workspaceId);
  if (!j) throw notFound();
  if (!cancelJob(String(req.params.id))) throw badRequest("Job is not running or queued");
  audit({ workspaceId: req.workspaceId, actorId: req.user!.id, action: "job.cancelled", entityType: "job", entityId: String(req.params.id) });
  res.json({ ok: true });
});

jobsRouter.post("/jobs/:id/retry", requirePerm("analysis.run"), (req, res) => {
  const j = db().prepare(`SELECT id FROM jobs WHERE id = ? AND workspace_id = ?`).get(req.params.id, req.workspaceId);
  if (!j) throw notFound();
  const id = retryJob(String(req.params.id));
  if (!id) throw badRequest("Only failed or cancelled jobs can be retried");
  audit({ workspaceId: req.workspaceId, actorId: req.user!.id, action: "job.retried", entityType: "job", entityId: id });
  res.status(202).json({ jobId: id });
});

jobsRouter.get("/dashboard", (req, res) => {
  res.json(dashboard(req.workspaceId!, req.query.repo ? String(req.query.repo) : null));
});

let toolCache: { at: number; v: any } | null = null;
jobsRouter.get("/system/capabilities", async (req, res) => {
  if (!toolCache || Date.now() - toolCache.at > 60_000) toolCache = { at: Date.now(), v: { tools: await detectTools(), sandbox: await sandboxMode() } };
  res.json({ ...toolCache.v, ai: aiStatus(req.workspaceId!) });
});
