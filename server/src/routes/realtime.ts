import { Router, type Request } from "express";
import fs from "node:fs";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { z } from "zod";
import { db } from "../db/db.js";
import { config } from "../config.js";
import { parse } from "../lib/validate.js";
import { requireWorkspace, requirePerm } from "../auth/session.js";
import { badRequest, notFound, tooMany } from "../lib/errors.js";
import { audit } from "../lib/audit.js";
import { hit } from "../lib/ratelimit.js";
import { presence, hubStats } from "../lib/events.js";
import { workerState } from "../jobs/queue.js";
import { getRepo } from "../services/analysis.js";
import { healthScore } from "../services/metrics.js";
import { healthHistory, getGate, setGate, evaluateGate, gateResults, checkRemote, rotateWebhookSecret, handleWebhook } from "../services/realtime.js";

/* ───────────── Public, signature-verified webhook receiver (mounted before CSRF guard) ───────────── */
export const hooksRouter = Router();
hooksRouter.post("/github/:repoId", (req: Request & { rawBody?: Buffer }, res) => {
  const repoId = String(req.params.repoId);
  if (!/^[A-Za-z0-9_]{3,64}$/.test(repoId)) return res.status(404).json({ error: { code: "not_found", message: "Webhook not configured" } });
  if (!hit(`webhook:${repoId}`, 60, 60_000)) throw tooMany();
  const r = handleWebhook(repoId, req.rawBody, req.headers, req.body);
  res.status(r.status).json({ message: r.message, jobId: r.jobId });
});

/* ───────────── Workspace-scoped realtime APIs ───────────── */
export const realtimeRouter = Router();
realtimeRouter.use(requireWorkspace);

const LOOP_RES_MS = 20;
const loop = monitorEventLoopDelay({ resolution: LOOP_RES_MS });
loop.enable();

function repoOr404(req: Request) {
  const r = getRepo(req.workspaceId!, String(req.params.id));
  if (!r) throw notFound("Repository not found");
  return r;
}

// 1 ─ Health score history + live breakdown
realtimeRouter.get("/repositories/:id/health", (req, res) => {
  const repo = repoOr404(req);
  const history = healthHistory(repo.id, Math.min(200, Number(req.query.limit) || 60));
  const current = healthScore(repo.id);
  const prev = history.length > 1 ? history[history.length - 2] : null;
  res.json({ current, history, delta: current.score != null && prev ? current.score - prev.score : null });
});

// 2 ─ Quality gates
const gateSchema = z.object({
  enabled: z.boolean(),
  min_score: z.number().int().min(0).max(100).nullable(),
  max_critical: z.number().int().min(0).max(100000).nullable(),
  max_high: z.number().int().min(0).max(100000).nullable(),
  max_secrets: z.number().int().min(0).max(100000).nullable(),
  max_vulnerable_deps: z.number().int().min(0).max(100000).nullable(),
});
realtimeRouter.get("/quality-gate", (req, res) => {
  res.json({ gate: getGate(req.workspaceId!), results: gateResults(req.workspaceId!, req.query.repo ? String(req.query.repo) : null) });
});
realtimeRouter.put("/quality-gate", requirePerm("settings.manage"), (req, res) => {
  const body = parse(gateSchema, req.body);
  const gate = setGate(req.workspaceId!, req.user!.id, body);
  audit({ workspaceId: req.workspaceId, actorId: req.user!.id, action: "quality_gate.updated", entityType: "workspace", entityId: req.workspaceId!, data: body });
  res.json({ gate });
});
realtimeRouter.post("/quality-gate/evaluate", requirePerm("analysis.run"), (req, res) => {
  const { repositoryId } = parse(z.object({ repositoryId: z.string().min(3).max(64) }), req.body);
  if (!getRepo(req.workspaceId!, repositoryId)) throw notFound("Repository not found");
  if (!getGate(req.workspaceId!)?.enabled) throw badRequest("No enabled quality gate. Configure thresholds first.");
  const r = evaluateGate(repositoryId, "manual");
  if (!r) throw badRequest("Nothing to evaluate: the repository is not indexed yet, or the gate has no thresholds set.");
  res.json(r);
});

// 3 ─ Auto-sync (remote watch)
realtimeRouter.get("/repositories/:id/watch", (req, res) => {
  const r = repoOr404(req);
  const deliveries = db().prepare(`SELECT event, status, detail, job_id, created_at FROM webhook_deliveries WHERE repository_id = ? ORDER BY created_at DESC LIMIT 20`).all(r.id);
  res.json({
    supported: r.source_type !== "local",
    enabled: !!r.watch_enabled, intervalMin: r.watch_interval_min, preset: r.watch_preset,
    lastCheckedAt: r.watch_last_checked_at, remoteSha: r.watch_remote_sha, lastError: r.watch_last_error,
    webhook: { configured: !!r.webhook_secret, url: `${config.appUrl.replace(/\/$/, "")}/api/hooks/github/${r.id}`, lastDeliveryAt: r.webhook_last_delivery_at },
    deliveries,
  });
});
realtimeRouter.put("/repositories/:id/watch", requirePerm("analysis.run"), (req, res) => {
  const r = repoOr404(req);
  const b = parse(z.object({ enabled: z.boolean(), intervalMin: z.number().int().min(5).max(1440), preset: z.enum(["quick", "full", "security"]) }), req.body);
  if (b.enabled && r.source_type === "local") throw badRequest("Auto-sync needs a git remote; local imports cannot be watched.");
  db().prepare(`UPDATE repositories SET watch_enabled = ?, watch_interval_min = ?, watch_preset = ? WHERE id = ?`).run(b.enabled ? 1 : 0, b.intervalMin, b.preset, r.id);
  audit({ workspaceId: req.workspaceId, actorId: req.user!.id, action: "repository.watch_updated", entityType: "repository", entityId: r.id, data: b });
  res.json({ ok: true });
});
realtimeRouter.post("/repositories/:id/watch/check", requirePerm("analysis.run"), async (req, res) => {
  const r = repoOr404(req);
  if (!hit(`watchcheck:${r.id}`, 6, 60_000)) throw tooMany();
  res.json(await checkRemote(r.id, "manual"));
});

// 4 ─ Push webhooks (secret shown exactly once)
realtimeRouter.post("/repositories/:id/webhook", requirePerm("integrations.manage"), (req, res) => {
  const r = repoOr404(req);
  if (r.source_type === "local") throw badRequest("Webhooks need a git remote; local imports cannot receive pushes.");
  const secret = rotateWebhookSecret(r.id);
  audit({ workspaceId: req.workspaceId, actorId: req.user!.id, action: "repository.webhook_secret_rotated", entityType: "repository", entityId: r.id });
  res.json({ secret, url: `${config.appUrl.replace(/\/$/, "")}/api/hooks/github/${r.id}`, note: "Copy this secret now; it will not be shown again." });
});
realtimeRouter.delete("/repositories/:id/webhook", requirePerm("integrations.manage"), (req, res) => {
  const r = repoOr404(req);
  db().prepare(`UPDATE repositories SET webhook_secret = NULL WHERE id = ?`).run(r.id);
  audit({ workspaceId: req.workspaceId, actorId: req.user!.id, action: "repository.webhook_disabled", entityType: "repository", entityId: r.id });
  res.json({ ok: true });
});

// 5 ─ Presence
realtimeRouter.get("/presence", (req, res) => res.json({ users: presence(req.workspaceId!) }));

// 6 ─ Live operations monitor (all values measured, nothing estimated)
realtimeRouter.get("/system/live", (req, res) => {
  const d = db();
  const ws = req.workspaceId!;
  const byStatus = d.prepare(`SELECT status, COUNT(*) AS n FROM jobs WHERE workspace_id = ? AND created_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 day') GROUP BY status`).all(ws);
  const throughput = d
    .prepare(`SELECT substr(finished_at,1,13) AS hour, SUM(status = 'completed') AS completed, SUM(status = 'failed') AS failed FROM jobs WHERE workspace_id = ? AND finished_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now','-12 hours') GROUP BY hour ORDER BY hour`)
    .all(ws);
  const durations = d
    .prepare(`SELECT type, COUNT(*) AS n, ROUND(AVG((julianday(finished_at) - julianday(started_at)) * 86400000)) AS avgMs, ROUND(MAX((julianday(finished_at) - julianday(started_at)) * 86400000)) AS maxMs FROM jobs WHERE workspace_id = ? AND status = 'completed' AND started_at IS NOT NULL AND finished_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now','-7 day') GROUP BY type ORDER BY n DESC`)
    .all(ws);
  const active = d.prepare(`SELECT id, type, status, progress, message, created_at, started_at FROM jobs WHERE workspace_id = ? AND status IN ('queued','running') ORDER BY created_at`).all(ws);
  const watched = d.prepare(`SELECT id, name, watch_interval_min, watch_last_checked_at, watch_remote_sha, watch_last_error FROM repositories WHERE workspace_id = ? AND watch_enabled = 1`).all(ws);
  const dbBytes = ["", "-wal", "-shm"].reduce((a, s) => a + (fs.existsSync(config.dbPath + s) ? fs.statSync(config.dbPath + s).size : 0), 0);
  const mem = process.memoryUsage();
  res.json({
    worker: workerState(),
    jobs: { byStatus, throughput, durations, active },
    realtime: hubStats(ws),
    watched,
    process: {
      uptimeSec: Math.round(process.uptime()),
      rssMb: Math.round(mem.rss / 1048576),
      heapUsedMb: Math.round(mem.heapUsed / 1048576),
      // The histogram records each sampling timer's full delay; subtract the sampling interval to get the lag itself.
      eventLoopLagMs: { mean: Math.max(0, Math.round((loop.mean / 1e6 - LOOP_RES_MS) * 100) / 100), p99: Math.max(0, Math.round((loop.percentile(99) / 1e6 - LOOP_RES_MS) * 100) / 100) },
      node: process.version,
    },
    database: { bytes: dbBytes },
    measuredAt: new Date().toISOString(),
  });
  loop.reset();
});
