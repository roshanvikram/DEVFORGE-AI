import path from "node:path";
import { Router } from "express";
import { z } from "zod";
import { db, now, json } from "../db/db.js";
import { newId } from "../lib/ids.js";
import { parse } from "../lib/validate.js";
import { requireWorkspace, requirePerm } from "../auth/session.js";
import { badRequest, notFound, forbidden } from "../lib/errors.js";
import { audit } from "../lib/audit.js";
import { enqueue, cancelJob } from "../jobs/queue.js";
import { getRepo, repoDir } from "../services/analysis.js";
import { retrieveContext, formatContext, searchCode } from "../services/search.js";
import { providerFor, requireProvider, aiStatus, SUPPORTED_MODELS } from "../ai/provider.js";
import { listIntegrations, setIntegration, removeIntegration, getSettings, updateSettings, INTEGRATION_PROVIDERS, type Provider } from "../services/integrations.js";
import { gh, parseGithubSlug, githubConfigured } from "../services/github.js";
import { AGENTS, agentByKey } from "../agents/definitions.js";
import { createRun, agentConfig } from "../agents/runner.js";
import { validateDefinition, startExecution, resumeExecution, WORKFLOW_TEMPLATES, type WfDef } from "../workflows/engine.js";
import { detectFramework, analyzeFunction } from "../services/testforge.js";
import { can } from "../auth/rbac.js";
import "../agents/runner.js";

export const platformRouter = Router();
platformRouter.use(requireWorkspace);

const repoOr404 = (req: any, id: string) => {
  const r = getRepo(req.workspaceId, id);
  if (!r) throw notFound("Repository not found");
  return r;
};

// ======================= Investigations =======================
platformRouter.get("/investigations", (req, res) => {
  res.json(db().prepare(`SELECT i.id, i.title, i.status, i.created_at, i.updated_at, i.ai_used, i.repository_id, r.name AS repository, json_array_length(i.hypotheses) AS hypotheses FROM investigations i JOIN repositories r ON r.id = i.repository_id WHERE i.workspace_id = ? ORDER BY i.created_at DESC LIMIT 200`).all(req.workspaceId));
});
platformRouter.post("/investigations", requirePerm("investigations.create"), (req, res) => {
  const b = parse(z.object({ repositoryId: z.string(), title: z.string().trim().min(3).max(200), error: z.string().max(20_000).optional(), stackTrace: z.string().max(100_000).optional(), logs: z.string().max(200_000).optional(), failingTests: z.string().max(20_000).optional(), description: z.string().max(20_000).optional() }), req.body);
  const repo = repoOr404(req, b.repositoryId);
  if (!repo.current_snapshot_id) throw badRequest("Repository must be indexed before investigating");
  if (!b.error && !b.stackTrace && !b.logs && !b.failingTests && !b.description) throw badRequest("Provide an error, stack trace, logs, failing tests or a description");
  const id = newId("inv_");
  const { repositoryId: _r, title, ...input } = b;
  db().prepare(`INSERT INTO investigations (id, workspace_id, repository_id, title, status, input, created_by) VALUES (?,?,?,?, 'queued', ?, ?)`).run(id, req.workspaceId, repo.id, title, JSON.stringify(input), req.user!.id);
  const jobId = enqueue("investigation.run", req.workspaceId!, { investigationId: id }, { userId: req.user!.id });
  db().prepare(`UPDATE investigations SET job_id = ? WHERE id = ?`).run(jobId, id);
  audit({ workspaceId: req.workspaceId, actorId: req.user!.id, action: "investigation.created", entityType: "investigation", entityId: id });
  res.status(201).json({ id, jobId });
});
platformRouter.get("/investigations/:id", (req, res) => {
  const i = db().prepare(`SELECT i.*, r.name AS repository FROM investigations i JOIN repositories r ON r.id = i.repository_id WHERE i.id = ? AND i.workspace_id = ?`).get(req.params.id, req.workspaceId) as any;
  if (!i) throw notFound();
  const fields = ["input", "parsed", "affected", "hypotheses", "evidence", "timeline", "proposed_fix", "verification"];
  for (const f of fields) i[f] = json(i[f], null);
  res.json(i);
});
platformRouter.post("/investigations/:id/rerun", requirePerm("investigations.create"), (req, res) => {
  const i = db().prepare(`SELECT id FROM investigations WHERE id = ? AND workspace_id = ?`).get(req.params.id, req.workspaceId) as any;
  if (!i) throw notFound();
  db().prepare(`UPDATE investigations SET status = 'queued', timeline = '[]', error = NULL WHERE id = ?`).run(i.id);
  res.json({ jobId: enqueue("investigation.run", req.workspaceId!, { investigationId: i.id }, { userId: req.user!.id }) });
});

// ======================= Reviews =======================
platformRouter.get("/reviews", (req, res) => {
  res.json(db().prepare(`SELECT v.id, v.kind, v.title, v.status, v.risk_score, v.ai_used, v.created_at, v.finished_at, r.name AS repository, v.repository_id, (SELECT COUNT(*) FROM findings f WHERE f.review_id = v.id) AS findings FROM reviews v JOIN repositories r ON r.id = v.repository_id WHERE v.workspace_id = ? ORDER BY v.created_at DESC LIMIT 200`).all(req.workspaceId));
});
platformRouter.post("/reviews", requirePerm("reviews.create"), (req, res) => {
  const b = parse(z.object({ repositoryId: z.string(), kind: z.enum(["commit", "range", "pull_request", "snippet"]), sha: z.string().optional(), base: z.string().optional(), head: z.string().optional(), number: z.number().int().positive().optional(), code: z.string().max(200_000).optional(), path: z.string().max(300).optional(), title: z.string().max(200).optional() }), req.body);
  const repo = repoOr404(req, b.repositoryId);
  let ref: any = {};
  let title = b.title;
  if (b.kind === "commit") { if (!b.sha || !/^[0-9a-f]{7,40}$/i.test(b.sha)) throw badRequest("A valid commit SHA is required"); ref = { sha: b.sha }; title ??= `Commit ${b.sha.slice(0, 8)}`; }
  if (b.kind === "range") { if (!b.base || !b.head) throw badRequest("base and head are required"); ref = { base: b.base, head: b.head }; title ??= `${b.base}..${b.head}`; }
  if (b.kind === "pull_request") { if (!b.number) throw badRequest("PR number required"); if (!parseGithubSlug(repo.source_url)) throw badRequest("Repository is not a GitHub repository"); ref = { number: b.number }; title ??= `PR #${b.number}`; }
  if (b.kind === "snippet") { if (!b.code?.trim()) throw badRequest("Code is required"); ref = { path: b.path ?? null }; title ??= `Snippet${b.path ? ` (${b.path})` : ""}`; }
  const id = newId("rev_");
  db().prepare(`INSERT INTO reviews (id, workspace_id, repository_id, kind, ref, title, diff, created_by) VALUES (?,?,?,?,?,?,?,?)`).run(id, req.workspaceId, repo.id, b.kind, JSON.stringify(ref), title, b.kind === "snippet" ? b.code : null, req.user!.id);
  const jobId = enqueue("review.run", req.workspaceId!, { reviewId: id }, { userId: req.user!.id });
  if (b.kind === "pull_request") db().prepare(`UPDATE pull_requests SET review_id = ? WHERE repository_id = ? AND number = ?`).run(id, repo.id, b.number);
  audit({ workspaceId: req.workspaceId, actorId: req.user!.id, action: "review.created", entityType: "review", entityId: id, data: { kind: b.kind } });
  res.status(201).json({ id, jobId });
});
platformRouter.get("/reviews/:id", (req, res) => {
  const v = db().prepare(`SELECT v.*, r.name AS repository FROM reviews v JOIN repositories r ON r.id = v.repository_id WHERE v.id = ? AND v.workspace_id = ?`).get(req.params.id, req.workspaceId) as any;
  if (!v) throw notFound();
  const findings = db().prepare(`SELECT id, title, category, severity, confidence, origin, tool, file_path, line, evidence, explanation, impact, recommendation, suggested_patch, status FROM findings WHERE review_id = ? ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END`).all(v.id);
  res.json({ ...v, ref: json(v.ref, {}), summary: json(v.summary, {}), findings });
});
platformRouter.get("/reviews/:id/export", (req, res) => {
  const v = db().prepare(`SELECT * FROM reviews WHERE id = ? AND workspace_id = ?`).get(req.params.id, req.workspaceId) as any;
  if (!v) throw notFound();
  const s = json<any>(v.summary, {});
  const f = db().prepare(`SELECT * FROM findings WHERE review_id = ?`).all(v.id) as any[];
  const md = `# Code review: ${v.title}\n\nRisk score: **${v.risk_score ?? "n/a"}/100** · Status: ${v.status}\n\n${s.text ?? ""}\n\n## Findings (${f.length})\n\n${f.map((x) => `### [${x.severity}] ${x.title}${x.origin === "ai_hypothesis" ? " _(AI)_" : ""}\n\`${x.file_path ?? ""}${x.line ? `:${x.line}` : ""}\` — ${x.category}\n\n**Evidence:** ${x.evidence}\n\n**Impact:** ${x.impact}\n\n**Fix:** ${x.recommendation}\n${x.suggested_patch ? `\n\`\`\`diff\n${x.suggested_patch}\n\`\`\`\n` : ""}`).join("\n")}`;
  res.setHeader("Content-Type", "text/markdown; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="review-${v.id}.md"`);
  res.send(md);
});

// ======================= Pull requests (GitHub) =======================
platformRouter.get("/repositories/:id/pulls", async (req, res) => {
  const repo = repoOr404(req, String(req.params.id));
  const slug = parseGithubSlug(repo.source_url);
  if (!slug) return res.json({ connected: false, reason: "not_github", items: [] });
  const cached = db().prepare(`SELECT * FROM pull_requests WHERE repository_id = ? ORDER BY number DESC`).all(repo.id) as any[];
  if (req.query.sync !== "1") return res.json({ connected: githubConfigured(req.workspaceId!), items: cached.map((p) => ({ ...p, data: json(p.data, {}) })) });
  const list = (await gh(req.workspaceId!, `/repos/${slug.owner}/${slug.repo}/pulls?state=${req.query.state === "closed" ? "closed" : "open"}&per_page=30`)) as any[];
  const up = db().prepare(`INSERT INTO pull_requests (id, workspace_id, repository_id, number, title, author, state, head_ref, base_ref, head_sha, url, data, updated_at, synced_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(repository_id, number) DO UPDATE SET title = excluded.title, state = excluded.state, head_sha = excluded.head_sha, data = excluded.data, updated_at = excluded.updated_at, synced_at = excluded.synced_at`);
  for (const p of list) up.run(newId("pr_"), req.workspaceId, repo.id, p.number, p.title, p.user?.login ?? null, p.state, p.head?.ref, p.base?.ref, p.head?.sha, p.html_url, JSON.stringify({ draft: p.draft, labels: (p.labels ?? []).map((l: any) => l.name), body: String(p.body ?? "").slice(0, 4000), created_at: p.created_at }), p.updated_at, now());
  const items = db().prepare(`SELECT * FROM pull_requests WHERE repository_id = ? ORDER BY number DESC`).all(repo.id) as any[];
  res.json({ connected: githubConfigured(req.workspaceId!), items: items.map((p) => ({ ...p, data: json(p.data, {}) })) });
});
platformRouter.get("/repositories/:id/pulls/:number/files", async (req, res) => {
  const repo = repoOr404(req, String(req.params.id));
  const slug = parseGithubSlug(repo.source_url);
  if (!slug) throw badRequest("Not a GitHub repository");
  const files = (await gh(req.workspaceId!, `/repos/${slug.owner}/${slug.repo}/pulls/${Number(req.params.number)}/files?per_page=100`)) as any[];
  res.json(files.map((f) => ({ filename: f.filename, status: f.status, additions: f.additions, deletions: f.deletions, patch: f.patch ?? null })));
});
platformRouter.post("/reviews/:id/post-comment", requirePerm("reviews.create"), async (req, res) => {
  const v = db().prepare(`SELECT * FROM reviews WHERE id = ? AND workspace_id = ? AND kind = 'pull_request' AND status = 'completed'`).get(req.params.id, req.workspaceId) as any;
  if (!v) throw notFound("Completed pull-request review not found");
  if (!githubConfigured(req.workspaceId!)) throw badRequest("Connect GitHub to post comments");
  const repo = repoOr404(req, v.repository_id);
  const slug = parseGithubSlug(repo.source_url)!;
  const ref = json<any>(v.ref, {});
  const s = json<any>(v.summary, {});
  const f = db().prepare(`SELECT severity, title, file_path, line, origin FROM findings WHERE review_id = ? AND severity IN ('critical','high','medium') LIMIT 20`).all(v.id) as any[];
  const body = `### DevForge AI review — risk ${v.risk_score}/100\n\n${String(s.text ?? "").slice(0, 3000)}\n\n${f.map((x) => `- **${x.severity}** ${x.title} (\`${x.file_path ?? ""}${x.line ? `:${x.line}` : ""}\`)${x.origin === "ai_hypothesis" ? " _AI_" : ""}`).join("\n")}`;
  const r = await gh(req.workspaceId!, `/repos/${slug.owner}/${slug.repo}/issues/${ref.number}/comments`, { method: "POST", body: JSON.stringify({ body }), headers: { "Content-Type": "application/json" } });
  audit({ workspaceId: req.workspaceId, actorId: req.user!.id, action: "review.comment_posted", entityType: "review", entityId: v.id, data: { pr: ref.number } });
  res.json({ ok: true, url: r.html_url });
});

// ======================= Test Forge =======================
platformRouter.get("/tests", (req, res) => {
  res.json(db().prepare(`SELECT t.id, t.kind, t.framework, t.target, t.status, t.passed, t.failed, t.skipped, t.duration_ms, t.ai_used, t.sandbox, t.created_at, t.finished_at, r.name AS repository, t.repository_id FROM test_runs t JOIN repositories r ON r.id = t.repository_id WHERE t.workspace_id = ? ORDER BY t.created_at DESC LIMIT 200`).all(req.workspaceId).map((t: any) => ({ ...t, target: json(t.target, {}) })));
});
platformRouter.get("/tests/:id", (req, res) => {
  const t = db().prepare(`SELECT * FROM test_runs WHERE id = ? AND workspace_id = ?`).get(req.params.id, req.workspaceId) as any;
  if (!t) throw notFound();
  const logs = t.job_id ? db().prepare(`SELECT level, message, created_at FROM job_logs WHERE job_id = ? ORDER BY id`).all(t.job_id) : [];
  res.json({ ...t, target: json(t.target, {}), scenarios: json(t.scenarios, {}), generated_files: json(t.generated_files, []), logs });
});
platformRouter.post("/tests/preview", (req, res) => {
  const b = parse(z.object({ repositoryId: z.string(), path: z.string(), symbol: z.string().optional() }), req.body);
  const repo = repoOr404(req, b.repositoryId);
  const sym = b.symbol ? (db().prepare(`SELECT s.line, s.end_line FROM symbols s JOIN files f ON f.id = s.file_id WHERE s.snapshot_id = ? AND f.path = ? AND s.name = ?`).get(repo.current_snapshot_id, b.path, b.symbol) as any) : null;
  const fs = fsMod;
  const abs = path.resolve(repoDir(repo.id), b.path);
  if (!abs.startsWith(repoDir(repo.id))) throw badRequest("Invalid path");
  const lines = fs.readFileSync(abs, "utf8").split("\n");
  const src = sym ? lines.slice(sym.line - 1, sym.end_line).join("\n") : lines.join("\n");
  const fw = detectFramework(repoDir(repo.id), b.path);
  res.json({ framework: fw, analysis: analyzeFunction(src, fw.language) });
});
platformRouter.post("/tests", requirePerm("tests.run"), (req, res) => {
  const b = parse(z.object({ repositoryId: z.string(), kind: z.enum(["generate", "suite"]), path: z.string().max(500).optional(), symbol: z.string().max(200).optional(), instructions: z.string().max(4000).optional(), installDependencies: z.boolean().default(false) }), req.body);
  const repo = repoOr404(req, b.repositoryId);
  if (b.kind === "generate" && !b.path) throw badRequest("Select a file to generate tests for");
  const id = newId("tst_");
  db().prepare(`INSERT INTO test_runs (id, workspace_id, repository_id, kind, target, status, created_by) VALUES (?,?,?,?,?, 'queued', ?)`).run(id, req.workspaceId, repo.id, b.kind, JSON.stringify({ path: b.path, symbol: b.symbol, instructions: b.instructions, installDependencies: b.installDependencies }), req.user!.id);
  const jobId = enqueue(b.kind === "generate" ? "tests.generate" : "tests.suite", req.workspaceId!, { runId: id }, { userId: req.user!.id });
  db().prepare(`UPDATE test_runs SET job_id = ? WHERE id = ?`).run(jobId, id);
  audit({ workspaceId: req.workspaceId, actorId: req.user!.id, action: "tests.started", entityType: "test_run", entityId: id, data: { kind: b.kind } });
  res.status(201).json({ id, jobId });
});

// ======================= Agents =======================
platformRouter.get("/agents", (req, res) => {
  const stats = db().prepare(`SELECT agent_key, status, COUNT(*) AS n, AVG((julianday(finished_at) - julianday(started_at)) * 86400) AS avg_sec FROM agent_runs WHERE workspace_id = ? GROUP BY agent_key, status`).all(req.workspaceId) as any[];
  const last = db().prepare(`SELECT agent_key, MAX(created_at) AS last FROM agent_runs WHERE workspace_id = ? GROUP BY agent_key`).all(req.workspaceId) as any[];
  const active = db().prepare(`SELECT agent_key, status FROM agent_runs WHERE workspace_id = ? AND status IN ('queued','planning','running','waiting')`).all(req.workspaceId) as any[];
  res.json({
    aiConfigured: !!providerFor(req.workspaceId!, req.user!.id),
    agents: AGENTS.map((a) => {
      const s = stats.filter((x) => x.agent_key === a.key);
      const cur = active.find((x) => x.agent_key === a.key);
      return { key: a.key, name: a.name, role: a.role, responsibilities: a.responsibilities, tools: a.tools, limits: a.limits, outputs: a.outputs, instructions: a.instructions, config: agentConfig(req.workspaceId!, a.key), status: cur?.status ?? "idle",
        runs: Object.fromEntries(s.map((x) => [x.status, x.n])), avgDurationSec: s.find((x) => x.status === "completed")?.avg_sec ?? null, lastRunAt: last.find((x) => x.agent_key === a.key)?.last ?? null };
    }),
  });
});
platformRouter.patch("/agents/:key", requirePerm("agents.configure"), (req, res) => {
  const a = agentByKey(String(req.params.key));
  if (!a) throw notFound();
  const b = parse(z.object({ enabled: z.boolean().optional(), maxSteps: z.number().int().min(1).max(40).optional(), disabledTools: z.array(z.string()).optional(), extraInstructions: z.string().max(4000).optional() }), req.body);
  const cur = agentConfig(req.workspaceId!, a.key);
  const { enabled, ...rest } = { ...cur, ...b };
  db().prepare(`INSERT INTO agent_configs (workspace_id, agent_key, enabled, config, updated_at) VALUES (?,?,?,?,?) ON CONFLICT(workspace_id, agent_key) DO UPDATE SET enabled = excluded.enabled, config = excluded.config, updated_at = excluded.updated_at`).run(req.workspaceId, a.key, enabled ? 1 : 0, JSON.stringify(rest), now());
  audit({ workspaceId: req.workspaceId, actorId: req.user!.id, action: "agent.configured", entityType: "agent", entityId: a.key, data: b });
  res.json({ ok: true });
});
platformRouter.get("/agent-runs", (req, res) => {
  const where = ["a.workspace_id = ?"];
  const args: any[] = [req.workspaceId];
  if (req.query.agent) { where.push("a.agent_key = ?"); args.push(String(req.query.agent)); }
  res.json(db().prepare(`SELECT a.id, a.agent_key, a.task, a.status, a.steps, a.input_tokens, a.output_tokens, a.cost_usd, a.ai_used, a.parent_run_id, a.workflow_execution_id, a.created_at, a.started_at, a.finished_at, a.error, r.name AS repository FROM agent_runs a LEFT JOIN repositories r ON r.id = a.repository_id WHERE ${where.join(" AND ")} ORDER BY a.created_at DESC LIMIT 200`).all(...args));
});
platformRouter.post("/agent-runs", requirePerm("agents.run"), (req, res) => {
  const b = parse(z.object({ repositoryId: z.string(), agent: z.string(), task: z.string().max(4000).optional() }), req.body);
  const repo = repoOr404(req, b.repositoryId);
  if (!repo.current_snapshot_id) throw badRequest("Repository must be indexed first");
  if (!agentByKey(b.agent)) throw badRequest("Unknown agent");
  const r = createRun({ workspaceId: req.workspaceId!, repositoryId: repo.id, agentKey: b.agent, task: b.task, userId: req.user!.id });
  audit({ workspaceId: req.workspaceId, actorId: req.user!.id, action: "agent.run_started", entityType: "agent_run", entityId: r.id, data: { agent: b.agent } });
  res.status(201).json(r);
});
platformRouter.get("/agent-runs/:id", (req, res) => {
  const r = db().prepare(`SELECT a.*, r.name AS repository FROM agent_runs a LEFT JOIN repositories r ON r.id = a.repository_id WHERE a.id = ? AND a.workspace_id = ?`).get(req.params.id, req.workspaceId) as any;
  if (!r) throw notFound();
  const steps = db().prepare(`SELECT seq, kind, name, content, duration_ms, created_at FROM agent_steps WHERE run_id = ? ORDER BY seq`).all(r.id);
  const children = db().prepare(`SELECT id, agent_key, status, task FROM agent_runs WHERE parent_run_id = ?`).all(r.id);
  res.json({ ...r, stepLog: steps, children });
});
platformRouter.post("/agent-runs/:id/cancel", requirePerm("agents.run"), (req, res) => {
  const r = db().prepare(`SELECT job_id, status FROM agent_runs WHERE id = ? AND workspace_id = ?`).get(req.params.id, req.workspaceId) as any;
  if (!r) throw notFound();
  if (!r.job_id || !cancelJob(r.job_id)) throw badRequest("Run is not active");
  res.json({ ok: true });
});

// ======================= Workflows =======================
const defSchema = z.object({ nodes: z.array(z.object({ id: z.string().max(60), type: z.string(), position: z.object({ x: z.number(), y: z.number() }).optional(), data: z.object({ label: z.string().max(120).optional(), config: z.record(z.string(), z.any()).optional() }).default({}) })).max(60), edges: z.array(z.object({ id: z.string().max(80), source: z.string(), target: z.string(), sourceHandle: z.string().nullable().optional() })).max(200) });
platformRouter.get("/workflows", (req, res) => {
  const rows = db().prepare(`SELECT w.id, w.name, w.description, w.definition, w.updated_at, w.created_at, (SELECT status FROM workflow_executions x WHERE x.workflow_id = w.id ORDER BY started_at DESC LIMIT 1) AS last_status, (SELECT COUNT(*) FROM workflow_executions x WHERE x.workflow_id = w.id) AS executions FROM workflows w WHERE w.workspace_id = ? ORDER BY w.updated_at DESC`).all(req.workspaceId) as any[];
  res.json({ workflows: rows.map((w) => ({ ...w, definition: json(w.definition, {}) })), templates: WORKFLOW_TEMPLATES });
});
platformRouter.post("/workflows", requirePerm("workflows.edit"), (req, res) => {
  const b = parse(z.object({ name: z.string().trim().min(1).max(100), description: z.string().max(500).optional(), definition: defSchema }), req.body);
  const errs = validateDefinition(b.definition as WfDef);
  if (errs.length) throw badRequest(errs[0], errs);
  const id = newId("wf_");
  db().prepare(`INSERT INTO workflows (id, workspace_id, name, description, definition, created_by) VALUES (?,?,?,?,?,?)`).run(id, req.workspaceId, b.name, b.description ?? null, JSON.stringify(b.definition), req.user!.id);
  audit({ workspaceId: req.workspaceId, actorId: req.user!.id, action: "workflow.created", entityType: "workflow", entityId: id });
  res.status(201).json({ id });
});
platformRouter.get("/workflows/:id", (req, res) => {
  const w = db().prepare(`SELECT * FROM workflows WHERE id = ? AND workspace_id = ?`).get(req.params.id, req.workspaceId) as any;
  if (!w) throw notFound();
  const executions = db().prepare(`SELECT id, status, started_at, finished_at, error, repository_id FROM workflow_executions WHERE workflow_id = ? ORDER BY started_at DESC LIMIT 50`).all(w.id);
  res.json({ ...w, definition: json(w.definition, {}), executions });
});
platformRouter.put("/workflows/:id", requirePerm("workflows.edit"), (req, res) => {
  const b = parse(z.object({ name: z.string().trim().min(1).max(100), description: z.string().max(500).nullable().optional(), definition: defSchema }), req.body);
  const errs = validateDefinition(b.definition as WfDef);
  if (errs.length) throw badRequest(errs[0], errs);
  const r = db().prepare(`UPDATE workflows SET name = ?, description = ?, definition = ?, updated_at = ? WHERE id = ? AND workspace_id = ?`).run(b.name, b.description ?? null, JSON.stringify(b.definition), now(), req.params.id, req.workspaceId);
  if (!r.changes) throw notFound();
  audit({ workspaceId: req.workspaceId, actorId: req.user!.id, action: "workflow.updated", entityType: "workflow", entityId: String(req.params.id) });
  res.json({ ok: true });
});
platformRouter.post("/workflows/:id/duplicate", requirePerm("workflows.edit"), (req, res) => {
  const w = db().prepare(`SELECT * FROM workflows WHERE id = ? AND workspace_id = ?`).get(req.params.id, req.workspaceId) as any;
  if (!w) throw notFound();
  const id = newId("wf_");
  db().prepare(`INSERT INTO workflows (id, workspace_id, name, description, definition, created_by) VALUES (?,?,?,?,?,?)`).run(id, req.workspaceId, `${w.name} (copy)`, w.description, w.definition, req.user!.id);
  res.status(201).json({ id });
});
platformRouter.delete("/workflows/:id", requirePerm("workflows.edit"), (req, res) => {
  const r = db().prepare(`DELETE FROM workflows WHERE id = ? AND workspace_id = ?`).run(req.params.id, req.workspaceId);
  if (!r.changes) throw notFound();
  audit({ workspaceId: req.workspaceId, actorId: req.user!.id, action: "workflow.deleted", entityType: "workflow", entityId: String(req.params.id) });
  res.json({ ok: true });
});
platformRouter.post("/workflows/:id/run", requirePerm("workflows.run"), (req, res) => {
  const b = parse(z.object({ repositoryId: z.string() }), req.body);
  const w = db().prepare(`SELECT * FROM workflows WHERE id = ? AND workspace_id = ?`).get(req.params.id, req.workspaceId) as any;
  if (!w) throw notFound();
  const repo = repoOr404(req, b.repositoryId);
  if (!repo.current_snapshot_id) throw badRequest("Repository must be indexed first");
  const errs = validateDefinition(json(w.definition, { nodes: [], edges: [] }));
  if (errs.length) throw badRequest(errs[0]);
  const r = startExecution(w, repo.id, req.user!.id);
  audit({ workspaceId: req.workspaceId, actorId: req.user!.id, action: "workflow.executed", entityType: "workflow_execution", entityId: r.id });
  res.status(202).json(r);
});
platformRouter.get("/workflow-executions/:id", (req, res) => {
  const x = db().prepare(`SELECT * FROM workflow_executions WHERE id = ? AND workspace_id = ?`).get(req.params.id, req.workspaceId) as any;
  if (!x) throw notFound();
  const approvals = db().prepare(`SELECT a.*, u.name AS decided_by_name FROM approvals a LEFT JOIN users u ON u.id = a.decided_by WHERE execution_id = ?`).all(x.id);
  res.json({ ...x, definition: json(x.definition, {}), node_states: json(x.node_states, {}), context: json(x.context, {}), logs: json(x.logs, []), approvals });
});
platformRouter.post("/workflow-executions/:id/cancel", requirePerm("workflows.run"), (req, res) => {
  const x = db().prepare(`SELECT * FROM workflow_executions WHERE id = ? AND workspace_id = ?`).get(req.params.id, req.workspaceId) as any;
  if (!x) throw notFound();
  if (x.job_id) cancelJob(x.job_id);
  db().prepare(`UPDATE workflow_executions SET status = 'cancelled', finished_at = ? WHERE id = ? AND status IN ('queued','running','waiting_approval')`).run(now(), x.id);
  res.json({ ok: true });
});
platformRouter.get("/approvals", (req, res) => {
  res.json(db().prepare(`SELECT a.*, w.name AS workflow FROM approvals a JOIN workflow_executions x ON x.id = a.execution_id JOIN workflows w ON w.id = x.workflow_id WHERE a.workspace_id = ? ORDER BY a.status = 'pending' DESC, a.created_at DESC LIMIT 100`).all(req.workspaceId));
});
platformRouter.post("/approvals/:id/decide", requirePerm("approvals.decide"), (req, res) => {
  const b = parse(z.object({ decision: z.enum(["approved", "rejected"]), note: z.string().max(1000).optional() }), req.body);
  const a = db().prepare(`SELECT * FROM approvals WHERE id = ? AND workspace_id = ? AND status = 'pending'`).get(req.params.id, req.workspaceId) as any;
  if (!a) throw notFound("Pending approval not found");
  db().prepare(`UPDATE approvals SET status = ?, decided_by = ?, decided_at = ?, note = ? WHERE id = ?`).run(b.decision, req.user!.id, now(), b.note ?? null, a.id);
  const jobId = resumeExecution(a.execution_id, req.workspaceId!, req.user!.id);
  db().prepare(`UPDATE workflow_executions SET job_id = ? WHERE id = ?`).run(jobId, a.execution_id);
  audit({ workspaceId: req.workspaceId, actorId: req.user!.id, action: `approval.${b.decision}`, entityType: "approval", entityId: a.id, data: { note: b.note } });
  res.json({ ok: true });
});

// ======================= Knowledge base & repository Q&A =======================
platformRouter.get("/kb", (req, res) => {
  const q = String(req.query.q ?? "").trim();
  if (q) {
    const terms = q.split(/\s+/).filter((t) => t.length > 1).map((t) => `"${t.replace(/"/g, "")}"*`).join(" OR ");
    const rows = terms ? (db().prepare(`SELECT d.id, d.title, d.kind, d.repository_id, d.updated_at, snippet(kb_fts, 1, '[', ']', '…', 18) AS snippet FROM kb_fts JOIN knowledge_docs d ON d.id = kb_fts.doc_id WHERE kb_fts MATCH ? AND kb_fts.workspace_id = ? ORDER BY bm25(kb_fts) LIMIT 40`).all(terms, req.workspaceId)) : [];
    return res.json(rows);
  }
  res.json(db().prepare(`SELECT d.id, d.title, d.kind, d.repository_id, d.source_path, d.created_at, d.updated_at, length(d.content) AS size, u.name AS author FROM knowledge_docs d LEFT JOIN users u ON u.id = d.created_by WHERE d.workspace_id = ? ORDER BY d.updated_at DESC`).all(req.workspaceId));
});
platformRouter.get("/kb/:id", (req, res) => {
  const d = db().prepare(`SELECT * FROM knowledge_docs WHERE id = ? AND workspace_id = ?`).get(req.params.id, req.workspaceId);
  if (!d) throw notFound();
  res.json(d);
});
platformRouter.post("/kb", requirePerm("kb.write"), (req, res) => {
  const b = parse(z.object({ title: z.string().trim().min(1).max(200), content: z.string().max(500_000), repositoryId: z.string().optional(), kind: z.enum(["upload", "note"]).default("note") }), req.body);
  if (b.repositoryId) repoOr404(req, b.repositoryId);
  const id = newId("kb_");
  db().prepare(`INSERT INTO knowledge_docs (id, workspace_id, repository_id, title, kind, content, created_by) VALUES (?,?,?,?,?,?,?)`).run(id, req.workspaceId, b.repositoryId ?? null, b.title, b.kind, b.content, req.user!.id);
  db().prepare(`INSERT INTO kb_fts (title, content, doc_id, workspace_id) VALUES (?,?,?,?)`).run(b.title, b.content, id, req.workspaceId);
  audit({ workspaceId: req.workspaceId, actorId: req.user!.id, action: "kb.created", entityType: "knowledge_doc", entityId: id });
  res.status(201).json({ id });
});
platformRouter.delete("/kb/:id", requirePerm("kb.write"), (req, res) => {
  const r = db().prepare(`DELETE FROM knowledge_docs WHERE id = ? AND workspace_id = ?`).run(req.params.id, req.workspaceId);
  if (!r.changes) throw notFound();
  db().prepare(`DELETE FROM kb_fts WHERE doc_id = ?`).run(req.params.id);
  res.json({ ok: true });
});
platformRouter.post("/kb/import-repo-docs", requirePerm("kb.write"), (req, res) => {
  const b = parse(z.object({ repositoryId: z.string() }), req.body);
  const repo = repoOr404(req, b.repositoryId);
  const files = db().prepare(`SELECT path FROM files WHERE snapshot_id = ? AND language = 'markdown' ORDER BY length(path) LIMIT 60`).all(repo.current_snapshot_id) as any[];
  const fs = fsMod;
  let n = 0;
  for (const f of files) {
    const abs = path.resolve(repoDir(repo.id), f.path);
    if (!abs.startsWith(repoDir(repo.id)) || !fs.existsSync(abs)) continue;
    const content = fs.readFileSync(abs, "utf8").slice(0, 300_000);
    db().prepare(`DELETE FROM kb_fts WHERE doc_id IN (SELECT id FROM knowledge_docs WHERE workspace_id = ? AND repository_id = ? AND source_path = ?)`).run(req.workspaceId, repo.id, f.path);
    db().prepare(`DELETE FROM knowledge_docs WHERE workspace_id = ? AND repository_id = ? AND source_path = ?`).run(req.workspaceId, repo.id, f.path);
    const id = newId("kb_");
    db().prepare(`INSERT INTO knowledge_docs (id, workspace_id, repository_id, title, kind, source_path, content, created_by) VALUES (?,?,?,?, 'repo_doc', ?, ?, ?)`).run(id, req.workspaceId, repo.id, `${repo.name}/${f.path}`, f.path, content, req.user!.id);
    db().prepare(`INSERT INTO kb_fts (title, content, doc_id, workspace_id) VALUES (?,?,?,?)`).run(f.path, content, id, req.workspaceId);
    n++;
  }
  res.json({ imported: n });
});

platformRouter.get("/repositories/:id/chat", (req, res) => {
  const repo = repoOr404(req, String(req.params.id));
  res.json(db().prepare(`SELECT id, role, content, citations, created_at FROM chat_messages WHERE repository_id = ? AND (user_id = ? OR role = 'assistant') ORDER BY created_at LIMIT 200`).all(repo.id, req.user!.id).map((m: any) => ({ ...m, citations: json(m.citations, []) })));
});
platformRouter.post("/repositories/:id/chat", requirePerm("ai.use"), async (req, res) => {
  const repo = repoOr404(req, String(req.params.id));
  if (!repo.current_snapshot_id) throw badRequest("Repository must be indexed first");
  const b = parse(z.object({ question: z.string().trim().min(2).max(4000) }), req.body);
  const sources = retrieveContext(repo.current_snapshot_id, repoDir(repo.id), b.question, { budgetChars: 36_000 });
  const citations = sources.map((s) => ({ path: s.path, startLine: s.startLine, endLine: s.endLine, reason: s.reason }));
  const ai = providerFor(req.workspaceId!, req.user!.id);
  db().prepare(`INSERT INTO chat_messages (id, workspace_id, repository_id, user_id, role, content) VALUES (?,?,?,?, 'user', ?)`).run(newId("msg_"), req.workspaceId, repo.id, req.user!.id, b.question);
  if (!ai) return res.json({ aiConfigured: false, answer: null, citations, note: "No AI provider configured — showing the most relevant code locations only." });
  if (!getSettings(req.workspaceId!).ai.allowCodeSnippetsToAI) throw forbidden("Sending code to the AI provider is disabled in workspace settings");
  requireProvider(req.workspaceId!, req.user!.id);
  const history = (db().prepare(`SELECT role, content FROM chat_messages WHERE repository_id = ? AND user_id IS ? ORDER BY created_at DESC LIMIT 7`).all(repo.id, null) as any[]).reverse();
  void history;
  const resp = await ai.complete({
    feature: "repository_chat",
    maxTokens: 8000,
    system: `You answer questions about the repository "${repo.name}" using ONLY the provided code excerpts. Cite sources inline as \`path:line\`. If the excerpts don't contain the answer, say so and suggest where to look. Use Markdown.`,
    messages: [{ role: "user", content: `Question: ${b.question}\n\nCode excerpts:\n${formatContext(sources)}` }],
  });
  db().prepare(`INSERT INTO chat_messages (id, workspace_id, repository_id, user_id, role, content, citations) VALUES (?,?,?,?, 'assistant', ?, ?)`).run(newId("msg_"), req.workspaceId, repo.id, req.user!.id, resp.text, JSON.stringify(citations));
  res.json({ aiConfigured: true, answer: resp.text, citations, usage: resp.usage });
});

// ======================= Reports =======================
platformRouter.get("/reports", (req, res) => {
  res.json(db().prepare(`SELECT p.id, p.kind, p.title, p.created_at, p.repository_id, r.name AS repository, u.name AS author FROM reports p LEFT JOIN repositories r ON r.id = p.repository_id LEFT JOIN users u ON u.id = p.created_by WHERE p.workspace_id = ? ORDER BY p.created_at DESC LIMIT 200`).all(req.workspaceId));
});
platformRouter.get("/reports/:id", (req, res) => {
  const p = db().prepare(`SELECT * FROM reports WHERE id = ? AND workspace_id = ?`).get(req.params.id, req.workspaceId) as any;
  if (!p) throw notFound();
  if (req.query.download === "1") {
    res.setHeader("Content-Type", "text/markdown; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${p.title.replace(/[^\w.-]+/g, "_")}.md"`);
    return res.send(p.content);
  }
  res.json({ ...p, data: json(p.data, {}) });
});
platformRouter.post("/reports", requirePerm("reports.create"), (req, res) => {
  const b = parse(z.object({ repositoryId: z.string(), kind: z.enum(["security", "quality", "debt", "executive", "dependencies"]) }), req.body);
  const repo = repoOr404(req, b.repositoryId);
  const sources: Record<string, string[]> = { security: ["security", "secret", "dependency"], quality: ["bug", "performance"], debt: ["debt"], executive: ["bug", "security", "secret", "dependency", "performance", "debt"], dependencies: ["dependency"] };
  const src = sources[b.kind];
  const rows = db().prepare(`SELECT title, severity, source, origin, category, file_path, line, recommendation FROM findings WHERE repository_id = ? AND review_id IS NULL AND status IN ('open','triaged','in_progress') AND source IN (${src.map(() => "?").join(",")}) ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END LIMIT 300`).all(repo.id, ...src) as any[];
  const scans = db().prepare(`SELECT kind, status, tools, finished_at FROM scans WHERE repository_id = ? AND status = 'completed' ORDER BY finished_at DESC LIMIT 10`).all(repo.id) as any[];
  if (!scans.length) throw badRequest("No completed scans yet — run an analysis first");
  const counts: Record<string, number> = {};
  for (const r of rows) counts[r.severity] = (counts[r.severity] ?? 0) + 1;
  const byCat: Record<string, number> = {};
  for (const r of rows) byCat[r.category] = (byCat[r.category] ?? 0) + 1;
  const title = `${b.kind[0].toUpperCase()}${b.kind.slice(1)} report — ${repo.name}`;
  const content = `# ${title}\n\n_Generated ${new Date().toUTCString()} from recorded scan data._\n\n## Summary\n| Severity | Open |\n|---|---|\n${["critical", "high", "medium", "low", "info"].map((s) => `| ${s} | ${counts[s] ?? 0} |`).join("\n")}\n\n## By category\n${Object.entries(byCat).sort((a, b) => b[1] - a[1]).map(([k, v]) => `- ${k}: ${v}`).join("\n") || "- none"}\n\n## Scan coverage\n${scans.map((s) => `- **${s.kind}** (${s.finished_at}): ${Object.entries(json<any>(s.tools, {})).map(([k, v]: any) => `${k} ${v.status}`).join(", ")}`).join("\n")}\n\n## Findings\n${rows.slice(0, 150).map((r) => `- **[${r.severity}]** ${r.title}${r.origin === "ai_hypothesis" ? " _(AI hypothesis)_" : ""} — \`${r.file_path ?? "repository"}${r.line ? `:${r.line}` : ""}\`\n  - Fix: ${r.recommendation}`).join("\n") || "No open findings."}\n`;
  const id = newId("rpt_");
  db().prepare(`INSERT INTO reports (id, workspace_id, repository_id, kind, title, content, data, created_by) VALUES (?,?,?,?,?,?,?,?)`).run(id, req.workspaceId, repo.id, b.kind, title, content, JSON.stringify({ counts, byCat }), req.user!.id);
  audit({ workspaceId: req.workspaceId, actorId: req.user!.id, action: "report.created", entityType: "report", entityId: id, data: { kind: b.kind } });
  res.status(201).json({ id });
});

// ======================= Notifications & activity =======================
platformRouter.get("/notifications", (req, res) => {
  const items = db().prepare(`SELECT id, kind, title, body, link, read_at, created_at FROM notifications WHERE user_id = ? AND workspace_id = ? ORDER BY created_at DESC LIMIT 100`).all(req.user!.id, req.workspaceId);
  const unread = (db().prepare(`SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND workspace_id = ? AND read_at IS NULL`).get(req.user!.id, req.workspaceId) as any).n;
  res.json({ items, unread });
});
platformRouter.post("/notifications/read", (req, res) => {
  const b = parse(z.object({ ids: z.array(z.string()).optional() }), req.body ?? {});
  if (b.ids?.length) db().prepare(`UPDATE notifications SET read_at = ? WHERE user_id = ? AND id IN (${b.ids.map(() => "?").join(",")})`).run(now(), req.user!.id, ...b.ids);
  else db().prepare(`UPDATE notifications SET read_at = ? WHERE user_id = ? AND workspace_id = ? AND read_at IS NULL`).run(now(), req.user!.id, req.workspaceId);
  res.json({ ok: true });
});
platformRouter.get("/activity", (req, res) => {
  const q = parse(z.object({ actor: z.string().optional(), action: z.string().optional(), entity: z.string().optional(), from: z.string().optional(), to: z.string().optional(), q: z.string().max(100).optional(), limit: z.coerce.number().int().min(1).max(500).default(100), offset: z.coerce.number().int().min(0).default(0) }), req.query);
  const where = ["a.workspace_id = ?"];
  const args: any[] = [req.workspaceId];
  if (q.actor) { where.push("a.actor_id = ?"); args.push(q.actor); }
  if (q.action) { where.push("a.action LIKE ?"); args.push(`${q.action}%`); }
  if (q.entity) { where.push("a.entity_type = ?"); args.push(q.entity); }
  if (q.from) { where.push("a.created_at >= ?"); args.push(q.from); }
  if (q.to) { where.push("a.created_at <= ?"); args.push(q.to + "T23:59:59Z"); }
  if (q.q) { where.push("(a.action LIKE ? OR a.data LIKE ? OR a.entity_id LIKE ?)"); args.push(`%${q.q}%`, `%${q.q}%`, `%${q.q}%`); }
  const items = db().prepare(`SELECT a.id, a.action, a.actor_type, a.entity_type, a.entity_id, a.data, a.ip, a.created_at, u.name AS actor, a.actor_id FROM activity_logs a LEFT JOIN users u ON u.id = a.actor_id WHERE ${where.join(" AND ")} ORDER BY a.id DESC LIMIT ? OFFSET ?`).all(...args, q.limit, q.offset).map((r: any) => ({ ...r, data: json(r.data, {}), ip: can(req.role, "workspace.manage") ? r.ip : null }));
  const total = (db().prepare(`SELECT COUNT(*) AS n FROM activity_logs a WHERE ${where.join(" AND ")}`).get(...args) as any).n;
  const actions = db().prepare(`SELECT DISTINCT substr(action, 1, instr(action, '.') - 1) AS a FROM activity_logs WHERE workspace_id = ?`).all(req.workspaceId).map((r: any) => r.a);
  res.json({ items, total, actions });
});

// ======================= Analytics =======================
platformRouter.get("/analytics", (req, res) => {
  const days = Math.min(Number(req.query.days ?? 30), 365);
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  const repo = req.query.repo ? String(req.query.repo) : null;
  const rf = repo ? "AND repository_id = ?" : "";
  const ra = repo ? [repo] : [];
  const d = db();
  const ws = req.workspaceId;
  res.json({
    days,
    findingsOpened: d.prepare(`SELECT substr(first_seen_at,1,10) AS day, source, COUNT(*) AS n FROM findings WHERE workspace_id = ? AND review_id IS NULL AND first_seen_at >= ? ${rf} GROUP BY day, source ORDER BY day`).all(ws, since, ...ra),
    findingsResolved: d.prepare(`SELECT substr(resolved_at,1,10) AS day, COUNT(*) AS n FROM findings WHERE workspace_id = ? AND review_id IS NULL AND resolved_at >= ? ${rf} GROUP BY day ORDER BY day`).all(ws, since, ...ra),
    openBySeverity: d.prepare(`SELECT severity, source, COUNT(*) AS n FROM findings WHERE workspace_id = ? AND review_id IS NULL AND status IN ('open','triaged','in_progress') ${rf} GROUP BY severity, source`).all(ws, ...ra),
    riskMatrix: d.prepare(`SELECT severity, confidence, COUNT(*) AS n FROM findings WHERE workspace_id = ? AND review_id IS NULL AND status IN ('open','triaged','in_progress') ${rf} GROUP BY severity, confidence`).all(ws, ...ra),
    resolution: d.prepare(`SELECT source, COUNT(*) AS n, AVG(julianday(resolved_at) - julianday(first_seen_at)) AS avg_days FROM findings WHERE workspace_id = ? AND review_id IS NULL AND resolved_at IS NOT NULL ${rf} GROUP BY source`).all(ws, ...ra),
    scans: d.prepare(`SELECT kind, status, COUNT(*) AS n, AVG((julianday(finished_at) - julianday(started_at)) * 86400) AS avg_sec FROM scans WHERE workspace_id = ? AND created_at >= ? ${rf} GROUP BY kind, status`).all(ws, since, ...ra),
    scanTimeline: d.prepare(`SELECT substr(created_at,1,10) AS day, COUNT(*) AS n FROM scans WHERE workspace_id = ? AND created_at >= ? ${rf} GROUP BY day ORDER BY day`).all(ws, since, ...ra),
    agents: d.prepare(`SELECT agent_key, status, COUNT(*) AS n, SUM(cost_usd) AS cost, SUM(input_tokens + output_tokens) AS tokens FROM agent_runs WHERE workspace_id = ? AND created_at >= ? ${rf} GROUP BY agent_key, status`).all(ws, since, ...ra),
    tests: d.prepare(`SELECT substr(created_at,1,10) AS day, SUM(COALESCE(passed,0)) AS passed, SUM(COALESCE(failed,0)) AS failed, COUNT(*) AS runs FROM test_runs WHERE workspace_id = ? AND created_at >= ? ${rf} GROUP BY day ORDER BY day`).all(ws, since, ...ra),
    reviews: d.prepare(`SELECT substr(created_at,1,10) AS day, COUNT(*) AS n, AVG(risk_score) AS risk FROM reviews WHERE workspace_id = ? AND created_at >= ? ${rf} GROUP BY day ORDER BY day`).all(ws, since, ...ra),
    ai: d.prepare(`SELECT feature, COUNT(*) AS n, SUM(input_tokens) AS input, SUM(output_tokens) AS output, SUM(cost_usd) AS cost, SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END) AS errors FROM ai_usage WHERE workspace_id = ? AND created_at >= ? GROUP BY feature`).all(ws, since),
    snapshots: d.prepare(`SELECT s.created_at, s.loc, s.file_count, r.name FROM snapshots s JOIN repositories r ON r.id = s.repository_id WHERE r.workspace_id = ? AND s.created_at >= ? ${repo ? "AND r.id = ?" : ""} ORDER BY s.created_at`).all(ws, since, ...ra),
  });
});

// ======================= Global search =======================
platformRouter.get("/search", (req, res) => {
  const q = String(req.query.q ?? "").trim().slice(0, 100);
  if (q.length < 2) return res.json({ findings: [], repositories: [], code: [], docs: [] });
  const like = `%${q}%`;
  const repos = db().prepare(`SELECT id, name, current_snapshot_id FROM repositories WHERE workspace_id = ?`).all(req.workspaceId) as any[];
  const code = repos.filter((r) => r.current_snapshot_id).flatMap((r) => searchCode(r.current_snapshot_id, q, { limit: 5 }).map((h) => ({ repositoryId: r.id, repository: r.name, path: h.path, line: h.matches[0]?.line ?? 1, text: h.matches[0]?.text ?? "" }))).slice(0, 10);
  res.json({
    repositories: repos.filter((r) => r.name.toLowerCase().includes(q.toLowerCase())).map((r) => ({ id: r.id, name: r.name })),
    findings: db().prepare(`SELECT id, title, severity, source, file_path FROM findings WHERE workspace_id = ? AND review_id IS NULL AND (title LIKE ? OR file_path LIKE ?) ORDER BY first_seen_at DESC LIMIT 8`).all(req.workspaceId, like, like),
    investigations: db().prepare(`SELECT id, title, status FROM investigations WHERE workspace_id = ? AND title LIKE ? LIMIT 5`).all(req.workspaceId, like),
    docs: db().prepare(`SELECT id, title FROM knowledge_docs WHERE workspace_id = ? AND title LIKE ? LIMIT 5`).all(req.workspaceId, like),
    code,
  });
});

// ======================= Settings & integrations =======================
platformRouter.get("/settings", (req, res) => {
  res.json({ settings: getSettings(req.workspaceId!), ai: aiStatus(req.workspaceId!), models: SUPPORTED_MODELS });
});
platformRouter.patch("/settings", requirePerm("settings.manage"), (req, res) => {
  const b = parse(z.object({
    ai: z.object({ model: z.enum(SUPPORTED_MODELS as [string, ...string[]]).optional(), effort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(), maxContextFiles: z.number().int().min(1).max(40).optional(), monthlyBudgetUsd: z.number().min(0).max(100000).optional(), allowCodeSnippetsToAI: z.boolean().optional() }).optional(),
    analysis: z.object({ defaultPreset: z.enum(["quick", "full", "security", "architecture"]).optional(), osv: z.boolean().optional() }).optional(),
    notifications: z.object({ analysisComplete: z.boolean().optional(), criticalFindings: z.boolean().optional(), workflowApprovals: z.boolean().optional(), email: z.boolean().optional() }).optional(),
    retention: z.object({ activityDays: z.number().int().min(30).max(3650).optional(), jobLogDays: z.number().int().min(7).max(3650).optional(), chatDays: z.number().int().min(1).max(3650).optional() }).optional(),
  }), req.body);
  const next = updateSettings(req.workspaceId!, b as any);
  audit({ workspaceId: req.workspaceId, actorId: req.user!.id, action: "settings.updated", data: b });
  res.json(next);
});
platformRouter.get("/integrations", (req, res) => res.json(listIntegrations(req.workspaceId!)));
platformRouter.put("/integrations/:provider", requirePerm("integrations.manage"), async (req, res) => {
  const provider = String(req.params.provider) as Provider;
  if (!(provider in INTEGRATION_PROVIDERS)) throw notFound("Unknown integration");
  const b = parse(z.object({ secret: z.string().trim().min(8).max(500), config: z.record(z.string(), z.any()).default({}) }), req.body);
  if ((provider === "slack" || provider === "webhook") && !/^https:\/\//.test(b.secret)) throw badRequest("Webhook URL must start with https://");
  // Verify credentials before saving (never echo the secret back).
  if (provider === "github") {
    const r = await fetch("https://api.github.com/user", { headers: { Authorization: `Bearer ${b.secret}`, "User-Agent": "DevForge-AI" }, signal: AbortSignal.timeout(10_000) }).catch(() => null);
    if (!r?.ok) throw badRequest("GitHub rejected this token");
    b.config.login = ((await r.json()) as any).login;
  }
  if (provider === "anthropic") {
    const r = await fetch(`${process.env.DEVFORGE_ANTHROPIC_BASE_URL ?? "https://api.anthropic.com"}/v1/models?limit=1`, { headers: { "x-api-key": b.secret, "anthropic-version": "2023-06-01" }, signal: AbortSignal.timeout(10_000) }).catch(() => null);
    if (!r) throw badRequest("Could not reach the Anthropic API to verify the key");
    if (r.status === 401 || r.status === 403) throw badRequest("Anthropic rejected this API key");
  }
  setIntegration(req.workspaceId!, provider, b.secret, b.config, req.user!.id);
  audit({ workspaceId: req.workspaceId, actorId: req.user!.id, action: "integration.connected", entityType: "integration", entityId: provider });
  res.json({ ok: true });
});
platformRouter.delete("/integrations/:provider", requirePerm("integrations.manage"), (req, res) => {
  removeIntegration(req.workspaceId!, String(req.params.provider) as Provider);
  audit({ workspaceId: req.workspaceId, actorId: req.user!.id, action: "integration.disconnected", entityType: "integration", entityId: String(req.params.provider) });
  res.json({ ok: true });
});
platformRouter.get("/github/repos", async (req, res) => {
  if (!githubConfigured(req.workspaceId!)) return res.json({ connected: false, items: [] });
  const items = (await gh(req.workspaceId!, `/user/repos?per_page=100&sort=updated`)) as any[];
  res.json({ connected: true, items: items.map((r) => ({ full_name: r.full_name, private: r.private, url: r.html_url, default_branch: r.default_branch, language: r.language, updated_at: r.updated_at, description: r.description })) });
});

import fsMod from "node:fs";
