import type Anthropic from "@anthropic-ai/sdk";
import { db, now, json } from "../db/db.js";
import { newId } from "../lib/ids.js";
import { registerHandler, enqueue, type JobCtx } from "../jobs/queue.js";
import { getRepo } from "../services/analysis.js";
import { providerFor, type AIMessage } from "../ai/provider.js";
import { publish } from "../lib/events.js";
import { audit, notify } from "../lib/audit.js";
import { redact } from "../lib/logger.js";
import { AGENTS, agentByKey, type AgentDef } from "./definitions.js";
import { TOOLS, toolDefs, type ToolEnv } from "./tools.js";

export function agentConfig(workspaceId: string, key: string) {
  const r = db().prepare(`SELECT enabled, config FROM agent_configs WHERE workspace_id = ? AND agent_key = ?`).get(workspaceId, key) as any;
  return { enabled: r ? !!r.enabled : true, ...json<{ maxSteps?: number; disabledTools?: string[]; extraInstructions?: string }>(r?.config, {}) };
}

export function createRun(p: { workspaceId: string; repositoryId: string; agentKey: string; task?: string; userId: string | null; parentRunId?: string | null; workflowExecutionId?: string | null; inline?: boolean }) {
  const def = agentByKey(p.agentKey);
  if (!def) throw new Error(`Unknown agent ${p.agentKey}`);
  if (!agentConfig(p.workspaceId, def.key).enabled) throw new Error(`${def.name} is disabled in this workspace`);
  const id = newId("run_");
  db().prepare(`INSERT INTO agent_runs (id, workspace_id, repository_id, agent_key, task, status, parent_run_id, workflow_execution_id, created_by) VALUES (?,?,?,?,?, 'queued', ?,?,?)`)
    .run(id, p.workspaceId, p.repositoryId, def.key, (p.task || def.defaultTask).slice(0, 4000), p.parentRunId ?? null, p.workflowExecutionId ?? null, p.userId);
  let jobId: string | null = null;
  if (!p.inline) {
    jobId = enqueue("agent.run", p.workspaceId, { runId: id }, { userId: p.userId });
    db().prepare(`UPDATE agent_runs SET job_id = ? WHERE id = ?`).run(jobId, id);
  }
  publish(p.workspaceId, { type: "agent_run", id, agent: def.key, status: "queued" });
  return { id, jobId };
}

function truncate(v: unknown, max = 15_000): string {
  const s = typeof v === "string" ? v : JSON.stringify(v, null, 1);
  return s.length > max ? s.slice(0, max) + `\n…[truncated ${s.length - max} chars]` : s;
}

/** Deterministic Markdown report from playbook tool results (used without an AI provider). */
function playbookReport(def: AgentDef, task: string, results: { tool: string; output: any; error?: string }[]): string {
  const out: string[] = [`## Summary`, `${def.name} executed its deterministic playbook (${results.length} tool calls). No AI provider is configured, so this report contains tool output only — no AI interpretation.`, `\n**Task:** ${task}`];
  for (const r of results) {
    if (r.error) { out.push(`\n### ${r.tool}\nFailed: ${r.error}`); continue; }
    const o = r.output;
    if (r.tool === "run_scan") {
      out.push(`\n### Scan results`, `| Scan | Findings | New | Auto-resolved | Tools |`, `|---|---|---|---|---|`);
      for (const s of o) out.push(`| ${s.kind} | ${s.findings ?? "—"} | ${s.created ?? "—"} | ${s.autoResolved ?? "—"} | ${Object.entries(s.tools ?? {}).map(([k, v]) => `${k}: ${v}`).join(", ")} |`);
    } else if (r.tool === "list_findings") {
      out.push(`\n### Open findings (${o.length})`);
      for (const f of o.slice(0, 20)) out.push(`- **[${f.severity}]** ${f.title} — \`${f.file_path ?? "repository"}${f.line ? `:${f.line}` : ""}\`${f.origin === "ai_hypothesis" ? " _(AI hypothesis)_" : ""}`);
      if (!o.length) out.push("No open findings of this kind.");
    } else if (r.tool === "repository_overview") {
      const st = o.stats ?? {};
      out.push(`\n### Repository overview`, `- Files: ${st.files ?? "?"} (${st.codeFiles ?? "?"} code, ${st.testFiles ?? "?"} test)`, `- Lines of code: ${st.loc ?? "?"}`, `- Frameworks: ${(o.frameworks ?? []).join(", ") || "none detected"}`,
        `- Languages: ${Object.entries(st.languages ?? {}).sort((a: any, b: any) => b[1].loc - a[1].loc).slice(0, 6).map(([k, v]: any) => `${k} (${v.loc} LOC)`).join(", ")}`,
        `- API routes: ${o.routes?.length ?? 0}${o.routes?.length ? ` — e.g. ${o.routes.slice(0, 5).map((x: any) => `\`${x.name}\``).join(", ")}` : ""}`,
        `- Data models: ${o.models?.length ?? 0}${o.models?.length ? ` — ${o.models.slice(0, 8).map((x: any) => x.name).join(", ")}` : ""}`);
    } else if (r.tool === "architecture_summary") {
      out.push(`\n### Architecture`, `- ${o.files} code files, ${o.importEdges} internal import edges`, `- Circular dependencies: ${o.cycles.length}${o.cycles.length ? "\n" + o.cycles.slice(0, 5).map((c: any) => `  - ${c.path.join(" → ")}`).join("\n") : ""}`,
        `- Most depended-on modules:\n${o.hotspots.slice(0, 6).map((h: any) => `  - \`${h.path}\` — imported by ${h.fanIn}`).join("\n") || "  - none"}`,
        `- Highest-risk files (complexity × dependents × findings):\n${o.highRisk.slice(0, 6).map((h: any) => `  - \`${h.path}\` (complexity ${h.complexity}, ${h.findings} findings)`).join("\n") || "  - none"}`,
        `- Isolated modules: ${o.isolated.length}`);
    } else if (r.tool === "dependency_report") {
      const vulnerable = o.filter((d: any) => d.vulns.length);
      out.push(`\n### Dependencies (${o.length})`, `- Vulnerable: ${vulnerable.length}${vulnerable.length ? "\n" + vulnerable.slice(0, 10).map((d: any) => `  - ${d.name}@${d.resolved_version ?? d.version_spec}: ${d.vulns.join(", ")}`).join("\n") : ""}`,
        `- Behind latest: ${o.filter((d: any) => d.latest_version && d.resolved_version && d.latest_version !== d.resolved_version).length}`);
    } else if (r.tool === "search_code") {
      out.push(`\n### Code matches`, ...o.slice(0, 8).map((h: any) => `- \`${h.path}\` (lines ${h.matches.map((m: any) => m.line).slice(0, 5).join(", ")})`));
    }
  }
  out.push(`\n## Limitations`, `Configure an AI provider (Settings → AI Providers) for interpretation, prioritisation and recommendations. Tool output above is exact.`);
  return out.join("\n");
}

async function runAgent(ctx: JobCtx) {
  const { runId } = ctx.payload as { runId: string };
  const run = db().prepare(`SELECT * FROM agent_runs WHERE id = ?`).get(runId) as any;
  const def = agentByKey(run.agent_key)!;
  const cfg = agentConfig(ctx.workspaceId, def.key);
  const repo = getRepo(ctx.workspaceId, run.repository_id);
  if (!repo?.current_snapshot_id) throw new Error("Repository is not indexed yet");
  let seq = 0;
  let toolCalls = 0;
  const handoffs: { agent: string; task: string }[] = [];
  const setStatus = (status: string, extra: Record<string, unknown> = {}) => {
    const cols = ["status = ?", ...Object.keys(extra).map((k) => `${k} = ?`)];
    db().prepare(`UPDATE agent_runs SET ${cols.join(", ")} WHERE id = ?`).run(status, ...Object.values(extra) as any[], runId);
    publish(ctx.workspaceId, { type: "agent_run", id: runId, agent: def.key, status });
  };
  const step = (kind: string, name: string | null, content: unknown, ms?: number) => {
    db().prepare(`INSERT INTO agent_steps (run_id, seq, kind, name, content, duration_ms) VALUES (?,?,?,?,?,?)`).run(runId, seq++, kind, name, redact(truncate(content, 60_000)), ms ?? null);
    db().prepare(`UPDATE agent_runs SET steps = ? WHERE id = ?`).run(seq, runId);
    publish(ctx.workspaceId, { type: "agent_step", runId, kind, name });
  };
  const allowed = def.tools.filter((t) => !(cfg.disabledTools ?? []).includes(t));
  const env: ToolEnv = { workspaceId: ctx.workspaceId, userId: ctx.userId, repo, runId, agentKey: def.key, signal: ctx.signal, log: (m) => ctx.log(m) };
  const callTool = async (name: string, input: any) => {
    if (!allowed.includes(name)) return { error: `Tool ${name} is not permitted for ${def.name}` };
    if (++toolCalls > def.limits.maxToolCalls) return { error: "Tool-call limit reached; finish with what you have." };
    if (name === "handoff") {
      const target = agentByKey(String(input.agent));
      if (!target || target.key === def.key) return { error: "Unknown or invalid handoff target" };
      if (handoffs.length >= 2) return { error: "Handoff limit reached" };
      handoffs.push({ agent: target.key, task: String(input.task).slice(0, 2000) });
      step("handoff", target.key, { to: target.name, task: input.task });
      return { queued: true, agent: target.name, note: "Runs after you finish" };
    }
    const t0 = Date.now();
    step("tool_call", name, input);
    try {
      const out = await TOOLS[name].run(input, env);
      step("tool_result", name, out, Date.now() - t0);
      return out;
    } catch (e: any) {
      step("error", name, { error: e.message }, Date.now() - t0);
      return { error: e.message };
    }
  };

  db().prepare(`UPDATE agent_runs SET started_at = ? WHERE id = ?`).run(now(), runId);
  setStatus("planning");
  const timeout = setTimeout(() => ctx.log("Agent time limit reached", "warn"), def.limits.timeoutSec * 1000);
  const deadline = Date.now() + def.limits.timeoutSec * 1000;
  try {
    const ai = providerFor(ctx.workspaceId, ctx.userId);
    let output: string;
    if (!ai) {
      step("plan", null, { mode: "deterministic", reason: "No AI provider configured", steps: def.playbook.map((p) => p.tool) });
      setStatus("running");
      const results: { tool: string; output: any; error?: string }[] = [];
      for (const p of def.playbook) {
        if (ctx.signal.aborted) throw new Error("cancelled");
        const r: any = await callTool(p.tool, p.input(run.task));
        results.push({ tool: p.tool, output: r, error: r?.error });
      }
      output = playbookReport(def, run.task, results);
      if (def.key === "documentation_agent") {
        const saved: any = await callTool("save_document", { title: `${repo.name} — Architecture overview (generated)`, content: `# ${repo.name}\n\n_Generated deterministically by the Documentation Agent from repository analysis._\n\n${output.replace(/^## Summary[\s\S]*?\*\*Task:\*\*.*\n/, "")}` });
        output += `\n\nSaved to Knowledge Base (document ${saved.id}).`;
      }
    } else {
      setStatus("running");
      const tools = toolDefs(allowed);
      const messages: AIMessage[] = [{ role: "user", content: `Repository: ${repo.name}\nTask: ${run.task}\n\nStart with a one-paragraph plan, then use tools.` }];
      const system = def.instructions + (cfg.extraInstructions ? `\n\nWorkspace instructions:\n${cfg.extraInstructions}` : "") + `\n\nOther agents you may hand off to: ${AGENTS.filter((a) => a.key !== def.key).map((a) => `${a.key} (${a.role})`).join(", ")}.`;
      const maxSteps = Math.min(cfg.maxSteps ?? def.limits.maxSteps, 40);
      let final = "";
      let planned = false;
      for (let i = 0; i < maxSteps; i++) {
        if (ctx.signal.aborted) throw new Error("cancelled");
        if (Date.now() > deadline) { final += "\n\n_Stopped: time limit reached._"; break; }
        const resp = await ai.complete({ feature: `agent:${def.key}`, system, messages, tools, maxTokens: 16000, signal: ctx.signal });
        db().prepare(`UPDATE agent_runs SET input_tokens = input_tokens + ?, output_tokens = output_tokens + ?, cost_usd = cost_usd + ?, ai_used = 1 WHERE id = ?`).run(resp.usage.input, resp.usage.output, resp.usage.costUsd, runId);
        if (resp.text.trim()) step(planned ? "message" : "plan", null, resp.text);
        planned = true;
        messages.push({ role: "assistant", content: resp.content as any });
        const uses = resp.content.filter((b): b is Anthropic.Beta.Messages.BetaToolUseBlock => b.type === "tool_use");
        if (resp.stopReason === "pause_turn") continue;
        if (!uses.length) { final = resp.text; break; }
        const results: Anthropic.Beta.Messages.BetaToolResultBlockParam[] = [];
        for (const u of uses) {
          const out: any = await callTool(u.name, u.input ?? {});
          results.push({ type: "tool_result", tool_use_id: u.id, content: truncate(out), is_error: !!out?.error });
        }
        messages.push({ role: "user", content: results });
        if (i === maxSteps - 1) final = resp.text + "\n\n_Stopped: step limit reached._";
      }
      output = final || "The agent finished without a final report.";
    }
    step("message", "final", output);
    setStatus("completed", { output, finished_at: now() });
    for (const h of handoffs) createRun({ workspaceId: ctx.workspaceId, repositoryId: repo.id, agentKey: h.agent, task: h.task, userId: ctx.userId, parentRunId: runId, workflowExecutionId: run.workflow_execution_id });
    audit({ workspaceId: ctx.workspaceId, actorId: ctx.userId, actorType: "agent", action: "agent.run_completed", entityType: "agent_run", entityId: runId, data: { agent: def.key, steps: seq, toolCalls } });
    notify({ workspaceId: ctx.workspaceId, userId: ctx.userId ?? undefined, kind: "agent", title: `${def.name} finished`, body: run.task.slice(0, 120), link: `/app/agents/runs/${runId}` });
    return { status: "completed", steps: seq, handoffs: handoffs.length };
  } catch (e: any) {
    const cancelled = ctx.signal.aborted || e.message === "cancelled";
    step("error", null, { error: e.message });
    setStatus(cancelled ? "cancelled" : "failed", { error: String(e.message).slice(0, 1000), finished_at: now() });
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

registerHandler("agent.run", runAgent);
