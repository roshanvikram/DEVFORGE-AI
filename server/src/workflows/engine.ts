import dns from "node:dns/promises";
import { db, now, json } from "../db/db.js";
import { newId } from "../lib/ids.js";
import { registerHandler, runInline, enqueue, type JobCtx } from "../jobs/queue.js";
import { getRepo, repoDir, analyzeSnapshot, PRESETS, type ScanKind } from "../services/analysis.js";
import { loadContext } from "../engine/indexer.js";
import { isPrivateAddress } from "../engine/ingest.js";
import { createRun } from "../agents/runner.js";
import { getSecret } from "../services/integrations.js";
import { publish } from "../lib/events.js";
import { audit, notify } from "../lib/audit.js";

export const NODE_TYPES = ["trigger", "repo_analyzer", "agent", "security_scan", "bug_scan", "test_generator", "test_runner", "code_review", "condition", "approval", "notification", "report", "end"] as const;
export interface WfNode { id: string; type: (typeof NODE_TYPES)[number]; position?: { x: number; y: number }; data: { label?: string; config?: Record<string, any> } }
export interface WfEdge { id: string; source: string; target: string; sourceHandle?: string | null }
export interface WfDef { nodes: WfNode[]; edges: WfEdge[] }

/** Validates structure: known types, one+ trigger, no cycles, edges reference nodes. */
export function validateDefinition(def: WfDef): string[] {
  const errs: string[] = [];
  const ids = new Set(def.nodes.map((n) => n.id));
  for (const n of def.nodes) if (!NODE_TYPES.includes(n.type)) errs.push(`Unknown node type ${n.type}`);
  if (!def.nodes.some((n) => n.type === "trigger")) errs.push("Workflow needs a Trigger node");
  for (const e of def.edges) if (!ids.has(e.source) || !ids.has(e.target)) errs.push(`Edge ${e.id} references a missing node`);
  // cycle check (Kahn)
  const indeg = new Map(def.nodes.map((n) => [n.id, 0]));
  for (const e of def.edges) indeg.set(e.target, (indeg.get(e.target) ?? 0) + 1);
  const q = [...indeg].filter(([, d]) => d === 0).map(([k]) => k);
  let seen = 0;
  while (q.length) {
    const v = q.shift()!;
    seen++;
    for (const e of def.edges.filter((x) => x.source === v)) {
      indeg.set(e.target, indeg.get(e.target)! - 1);
      if (indeg.get(e.target) === 0) q.push(e.target);
    }
  }
  if (seen !== def.nodes.length) errs.push("Workflow contains a cycle");
  return errs;
}

/** Safe condition evaluator: `a.b > 3 && c == "x" || d != true` — no code execution. */
export function evaluateCondition(expr: string, ctx: Record<string, any>): boolean {
  const get = (p: string) => p.split(".").reduce((o: any, k) => (o == null ? undefined : o[k]), ctx);
  const lit = (s: string) => {
    const t = s.trim();
    if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
    if (t === "true" || t === "false") return t === "true";
    if (t === "null") return null;
    const m = t.match(/^["'](.*)["']$/);
    return m ? m[1] : get(t);
  };
  return expr.split("||").some((or) =>
    or.split("&&").every((clause) => {
      const m = clause.trim().match(/^([\w.]+)\s*(==|!=|>=|<=|>|<)\s*(.+)$/);
      if (!m) return !!get(clause.trim());
      const a = get(m[1]);
      const b = lit(m[3]);
      switch (m[2]) {
        case "==": return a == b;
        case "!=": return a != b;
        case ">": return Number(a) > Number(b);
        case "<": return Number(a) < Number(b);
        case ">=": return Number(a) >= Number(b);
        default: return Number(a) <= Number(b);
      }
    }),
  );
}

async function postWebhook(url: string, payload: unknown) {
  const u = new URL(url);
  if (u.protocol !== "https:") throw new Error("Webhook must be https");
  const addrs = (await dns.lookup(u.hostname, { all: true })).map((a) => a.address);
  if (addrs.some(isPrivateAddress)) throw new Error("Webhook host resolves to a private address");
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload), signal: AbortSignal.timeout(10_000), redirect: "error" });
  if (!r.ok) throw new Error(`Webhook responded ${r.status}`);
}

function findingCounts(repoId: string, sources?: string[]) {
  const rows = db().prepare(`SELECT severity, COUNT(*) AS n FROM findings WHERE repository_id = ? AND review_id IS NULL AND status IN ('open','triaged','in_progress') ${sources ? `AND source IN (${sources.map(() => "?").join(",")})` : ""} GROUP BY severity`).all(repoId, ...(sources ?? [])) as any[];
  const c: Record<string, number> = { critical: 0, high: 0, medium: 0, low: 0, info: 0, total: 0 };
  for (const r of rows) { c[r.severity] = r.n; c.total += r.n; }
  return c;
}

async function execNode(n: WfNode, repo: any, ctx: JobCtx, wctx: Record<string, any>, exec: any): Promise<{ output: any; handle?: string; wait?: boolean }> {
  const cfg = n.data?.config ?? {};
  const scan = async (kinds: ScanKind[]) => {
    if (!repo.current_snapshot_id) throw new Error("Repository is not indexed");
    const r = await analyzeSnapshot(repo, loadContext(repo.current_snapshot_id, repoDir(repo.id)), kinds, ctx);
    const counts = findingCounts(repo.id, kinds.flatMap((k) => (k === "security" ? ["security", "secret"] : [k])));
    return { scans: r.scans.map((s: any) => ({ kind: s.kind, findings: s.findings, created: s.created, error: s.error })), ...counts };
  };
  switch (n.type) {
    case "trigger":
    case "end":
      return { output: { at: now() } };
    case "repo_analyzer": {
      if (cfg.refresh) {
        await runInline("repo.import", ctx, { repositoryId: repo.id, kinds: PRESETS[cfg.preset ?? "quick"], refresh: true });
        Object.assign(repo, getRepo(repo.workspace_id, repo.id));
        return { output: findingCounts(repo.id) };
      }
      return { output: await scan(PRESETS[cfg.preset ?? "quick"]) };
    }
    case "security_scan": { const o = await scan(["security", "dependency"]); wctx.security = o; return { output: o }; }
    case "bug_scan": { const o = await scan(["bug"]); wctx.bugs = o; return { output: o }; }
    case "agent": {
      const { id } = createRun({ workspaceId: repo.workspace_id, repositoryId: repo.id, agentKey: cfg.agent ?? "repository_analyst", task: cfg.task, userId: ctx.userId, workflowExecutionId: exec.id, inline: true });
      await runInline("agent.run", ctx, { runId: id });
      const r = db().prepare(`SELECT status, output FROM agent_runs WHERE id = ?`).get(id) as any;
      wctx.agent = { status: r.status, runId: id };
      return { output: { runId: id, status: r.status, excerpt: String(r.output ?? "").slice(0, 600) } };
    }
    case "test_generator": {
      if (!cfg.path) throw new Error("Test Generator needs a target file path");
      const id = newId("tst_");
      db().prepare(`INSERT INTO test_runs (id, workspace_id, repository_id, kind, target, status, created_by) VALUES (?,?,?, 'generate', ?, 'queued', ?)`).run(id, repo.workspace_id, repo.id, JSON.stringify({ path: cfg.path, symbol: cfg.symbol ?? null }), ctx.userId);
      await runInline("tests.generate", ctx, { runId: id });
      const t = db().prepare(`SELECT status, passed, failed FROM test_runs WHERE id = ?`).get(id) as any;
      wctx.tests = t;
      return { output: { testRunId: id, ...t } };
    }
    case "test_runner": {
      const id = newId("tst_");
      db().prepare(`INSERT INTO test_runs (id, workspace_id, repository_id, kind, target, status, created_by) VALUES (?,?,?, 'suite', ?, 'queued', ?)`).run(id, repo.workspace_id, repo.id, JSON.stringify({ installDependencies: !!cfg.installDependencies }), ctx.userId);
      await runInline("tests.suite", ctx, { runId: id });
      const t = db().prepare(`SELECT status, passed, failed FROM test_runs WHERE id = ?`).get(id) as any;
      wctx.tests = t;
      return { output: { testRunId: id, ...t } };
    }
    case "code_review": {
      const sha = cfg.sha || "HEAD";
      const id = newId("rev_");
      const resolved = sha === "HEAD" ? ((db().prepare(`SELECT commit_sha FROM snapshots WHERE id = ?`).get(repo.current_snapshot_id) as any)?.commit_sha ?? null) : sha;
      if (!resolved) throw new Error("No commit available to review");
      db().prepare(`INSERT INTO reviews (id, workspace_id, repository_id, kind, ref, title, created_by) VALUES (?,?,?, 'commit', ?, ?, ?)`).run(id, repo.workspace_id, repo.id, JSON.stringify({ sha: resolved }), `Workflow review of ${resolved.slice(0, 8)}`, ctx.userId);
      await runInline("review.run", ctx, { reviewId: id });
      const r = db().prepare(`SELECT status, risk_score FROM reviews WHERE id = ?`).get(id) as any;
      wctx.review = { risk: r.risk_score, status: r.status, id };
      return { output: wctx.review };
    }
    case "condition": {
      const expr = String(cfg.expression ?? "true");
      const result = evaluateCondition(expr, { ...wctx, findings: findingCounts(repo.id) });
      return { output: { expression: expr, result }, handle: result ? "true" : "false" };
    }
    case "approval": {
      const existing = db().prepare(`SELECT * FROM approvals WHERE execution_id = ? AND node_id = ?`).get(exec.id, n.id) as any;
      if (existing?.status === "approved") return { output: { decision: "approved", by: existing.decided_by, note: existing.note }, handle: "approved" };
      if (existing?.status === "rejected") return { output: { decision: "rejected", note: existing.note }, handle: "rejected" };
      if (!existing) {
        db().prepare(`INSERT INTO approvals (id, workspace_id, execution_id, node_id, title) VALUES (?,?,?,?,?)`).run(newId("apr_"), repo.workspace_id, exec.id, n.id, n.data?.label ?? "Approval required");
        notify({ workspaceId: repo.workspace_id, kind: "approval", title: `Approval needed: ${n.data?.label ?? "workflow step"}`, link: `/app/workflows?execution=${exec.id}`, roles: ["owner", "admin", "security"] });
      }
      return { output: { decision: "pending" }, wait: true };
    }
    case "notification": {
      const msg = String(cfg.message ?? `Workflow step reached`).replace(/\{\{([\w.]+)\}\}/g, (_m, p) => String(p.split(".").reduce((o: any, k: string) => o?.[k], { ...wctx, findings: findingCounts(repo.id) }) ?? ""));
      notify({ workspaceId: repo.workspace_id, kind: "workflow", title: msg.slice(0, 200), link: `/app/workflows?execution=${exec.id}` });
      const channels: string[] = ["in-app"];
      for (const p of ["slack", "webhook"] as const) {
        if (cfg.channel !== p) continue;
        const url = getSecret(repo.workspace_id, p);
        if (!url) throw new Error(`${p} integration is not connected`);
        await postWebhook(url, p === "slack" ? { text: `DevForge AI: ${msg}` } : { source: "devforge", message: msg, executionId: exec.id });
        channels.push(p);
      }
      return { output: { message: msg, channels } };
    }
    case "report": {
      const counts = findingCounts(repo.id);
      const id = newId("rpt_");
      const content = `# ${cfg.title ?? "Workflow report"} — ${repo.name}\n\n_Generated ${now()} by workflow execution ${exec.id}_\n\n## Open findings\n| Severity | Count |\n|---|---|\n${["critical", "high", "medium", "low", "info"].map((s) => `| ${s} | ${counts[s]} |`).join("\n")}\n\n## Step results\n${Object.entries(json<any>(exec.node_states, {})).map(([k, v]: any) => `- **${k}** (${v.status}): ${JSON.stringify(v.output ?? {}).slice(0, 300)}`).join("\n")}\n`;
      db().prepare(`INSERT INTO reports (id, workspace_id, repository_id, kind, title, content, data, created_by) VALUES (?,?,?, 'workflow', ?, ?, ?, ?)`).run(id, repo.workspace_id, repo.id, cfg.title ?? "Workflow report", content, JSON.stringify({ executionId: exec.id, counts }), ctx.userId);
      return { output: { reportId: id } };
    }
  }
}

async function runWorkflow(ctx: JobCtx) {
  const { executionId } = ctx.payload as { executionId: string };
  const exec = db().prepare(`SELECT * FROM workflow_executions WHERE id = ?`).get(executionId) as any;
  const def = json<WfDef>(exec.definition, { nodes: [], edges: [] });
  const repo = getRepo(exec.workspace_id, exec.repository_id);
  if (!repo) throw new Error("Workflow repository not found");
  const states = json<Record<string, any>>(exec.node_states, {});
  const wctx = json<Record<string, any>>(exec.context, {});
  const logs = json<any[]>(exec.logs, []);
  const save = (status: string, extra: Record<string, unknown> = {}) => {
    exec.node_states = JSON.stringify(states);
    const cols = ["status = ?", "node_states = ?", "context = ?", "logs = ?", ...Object.keys(extra).map((k) => `${k} = ?`)];
    db().prepare(`UPDATE workflow_executions SET ${cols.join(", ")} WHERE id = ?`).run(status, JSON.stringify(states), JSON.stringify(wctx), JSON.stringify(logs.slice(-500)), ...(Object.values(extra) as any[]), executionId);
    publish(exec.workspace_id, { type: "workflow_execution", id: executionId, status, nodes: Object.fromEntries(Object.entries(states).map(([k, v]: any) => [k, v.status])) });
  };
  const log = (node: string | null, level: string, message: string) => { logs.push({ at: now(), node, level, message }); ctx.log(`${node ? `[${node}] ` : ""}${message}`, level as any); };
  save("running");
  const incoming = (id: string) => def.edges.filter((e) => e.target === id);
  const activated = new Set<string>(json<string[]>(wctx.__activated ? JSON.stringify(wctx.__activated) : "[]", []));
  const final = (s?: string) => s === "completed" || s === "skipped" || s === "failed";
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const n of def.nodes) {
      if (ctx.signal.aborted) throw new Error("cancelled");
      const st = states[n.id];
      if (final(st?.status)) continue;
      const inc = incoming(n.id);
      if (!inc.every((e) => final(states[e.source]?.status))) continue;
      const active = n.type === "trigger" || inc.some((e) => activated.has(e.id));
      if (!active) { states[n.id] = { status: "skipped" }; progressed = true; continue; }
      const retries = Math.min(Number(n.data?.config?.retries ?? 0), 3);
      states[n.id] = { ...(st ?? {}), status: "running", startedAt: st?.startedAt ?? now() };
      save("running");
      log(n.id, "info", `▶ ${n.data?.label ?? n.type}`);
      let attempt = 0;
      for (;;) {
        try {
          const r = await execNode(n, repo, ctx, wctx, exec);
          if (r.wait) {
            states[n.id] = { ...states[n.id], status: "waiting", output: r.output };
            wctx.__activated = [...activated];
            log(n.id, "info", "⏸ waiting for approval");
            save("waiting_approval");
            return { status: "waiting_approval" };
          }
          states[n.id] = { ...states[n.id], status: "completed", output: r.output, finishedAt: now(), attempts: attempt + 1 };
          for (const e of def.edges.filter((x) => x.source === n.id)) {
            const follow = !r.handle ? true : e.sourceHandle ? e.sourceHandle === r.handle : r.handle !== "rejected" && r.handle !== "false";
            if (follow) activated.add(e.id);
          }
          if (r.handle === "rejected" && !def.edges.some((e) => e.source === n.id && e.sourceHandle === "rejected")) log(n.id, "warn", "Rejected — downstream steps skipped");
          log(n.id, "info", `✔ ${JSON.stringify(r.output).slice(0, 200)}`);
          break;
        } catch (e: any) {
          if (ctx.signal.aborted) throw e;
          attempt++;
          if (attempt <= retries) { log(n.id, "warn", `Attempt ${attempt} failed: ${e.message}; retrying`); continue; }
          states[n.id] = { ...states[n.id], status: "failed", error: String(e.message).slice(0, 500), finishedAt: now(), attempts: attempt };
          log(n.id, "error", `✖ ${e.message}`);
          if (n.data?.config?.onError === "continue") {
            for (const e2 of def.edges.filter((x) => x.source === n.id)) activated.add(e2.id);
            break;
          }
          for (const other of def.nodes) if (!final(states[other.id]?.status)) states[other.id] = { status: "skipped" };
          save("failed", { error: `Step "${n.data?.label ?? n.id}" failed: ${e.message}`, finished_at: now() });
          notify({ workspaceId: exec.workspace_id, userId: exec.created_by ?? undefined, kind: "workflow", title: `Workflow failed at ${n.data?.label ?? n.type}`, link: `/app/workflows?execution=${executionId}` });
          return { status: "failed" };
        }
      }
      wctx.__activated = [...activated];
      save("running");
      progressed = true;
    }
  }
  save("completed", { finished_at: now() });
  audit({ workspaceId: exec.workspace_id, actorId: exec.created_by, actorType: "workflow", action: "workflow.completed", entityType: "workflow_execution", entityId: executionId });
  notify({ workspaceId: exec.workspace_id, userId: exec.created_by ?? undefined, kind: "workflow", title: "Workflow completed", link: `/app/workflows?execution=${executionId}` });
  return { status: "completed" };
}

registerHandler("workflow.run", async (ctx) => {
  try {
    return await runWorkflow(ctx);
  } catch (e: any) {
    db().prepare(`UPDATE workflow_executions SET status = ?, error = ?, finished_at = ? WHERE id = ?`).run(ctx.signal.aborted ? "cancelled" : "failed", String(e.message).slice(0, 500), now(), ctx.payload.executionId);
    throw e;
  }
});

export function startExecution(wf: any, repositoryId: string, userId: string | null, trigger = "manual") {
  const id = newId("wfx_");
  db().prepare(`INSERT INTO workflow_executions (id, workflow_id, workspace_id, repository_id, status, definition, context, created_by) VALUES (?,?,?,?, 'queued', ?, ?, ?)`).run(id, wf.id, wf.workspace_id, repositoryId, wf.definition, JSON.stringify({ trigger }), userId);
  const jobId = enqueue("workflow.run", wf.workspace_id, { executionId: id }, { userId });
  db().prepare(`UPDATE workflow_executions SET job_id = ? WHERE id = ?`).run(jobId, id);
  return { id, jobId };
}

export function resumeExecution(executionId: string, workspaceId: string, userId: string | null) {
  return enqueue("workflow.run", workspaceId, { executionId }, { userId });
}

export const WORKFLOW_TEMPLATES: { name: string; description: string; definition: WfDef }[] = [
  {
    name: "Security gate",
    description: "Scan security and dependencies; if critical/high issues exist, require approval and notify; always produce a report.",
    definition: {
      nodes: [
        { id: "t", type: "trigger", position: { x: 0, y: 120 }, data: { label: "Manual trigger" } },
        { id: "s", type: "security_scan", position: { x: 240, y: 120 }, data: { label: "Security scan" } },
        { id: "c", type: "condition", position: { x: 480, y: 120 }, data: { label: "Critical or high?", config: { expression: "security.critical > 0 || security.high > 0" } } },
        { id: "a", type: "approval", position: { x: 720, y: 40 }, data: { label: "Security lead sign-off" } },
        { id: "n", type: "notification", position: { x: 960, y: 40 }, data: { label: "Notify team", config: { message: "Security gate: {{security.critical}} critical, {{security.high}} high findings" } } },
        { id: "r", type: "report", position: { x: 960, y: 200 }, data: { label: "Security report", config: { title: "Security gate report" } } },
      ],
      edges: [
        { id: "e1", source: "t", target: "s" }, { id: "e2", source: "s", target: "c" },
        { id: "e3", source: "c", target: "a", sourceHandle: "true" }, { id: "e4", source: "a", target: "n", sourceHandle: "approved" },
        { id: "e5", source: "c", target: "r", sourceHandle: "false" }, { id: "e6", source: "n", target: "r" },
      ],
    },
  },
  {
    name: "Full health check",
    description: "Re-analyse the repository, run the Architecture Analyst agent, then publish a report.",
    definition: {
      nodes: [
        { id: "t", type: "trigger", position: { x: 0, y: 100 }, data: { label: "Manual trigger" } },
        { id: "an", type: "repo_analyzer", position: { x: 240, y: 100 }, data: { label: "Full analysis", config: { preset: "full" } } },
        { id: "ag", type: "agent", position: { x: 480, y: 100 }, data: { label: "Architecture Analyst", config: { agent: "architecture_analyst" } } },
        { id: "r", type: "report", position: { x: 720, y: 100 }, data: { label: "Health report", config: { title: "Repository health report" } } },
      ],
      edges: [{ id: "e1", source: "t", target: "an" }, { id: "e2", source: "an", target: "ag" }, { id: "e3", source: "ag", target: "r" }],
    },
  },
];
