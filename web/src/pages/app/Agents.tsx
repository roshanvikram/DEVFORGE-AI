import { useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { toast } from "sonner";
import { Bot, Network, Bug, FileSearch, ShieldCheck, GitPullRequest, FlaskConical, Gauge, Layers, Boxes, BookOpen, Play, Settings2, ArrowLeft, Wrench, MessageSquare, ArrowRightLeft, AlertTriangle, ListChecks, X, Sparkles } from "lucide-react";
import { get, post, patch } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { useRepo } from "../../lib/repo";
import { NeedsRepo } from "../../components/AppShell";
import { PageHeader, Panel, Button, Modal, Field, Textarea, Select, EmptyState, ErrorState, LoadingBlock, StatusBadge, Badge, Notice, Markdown, Table, Toggle, Input, Tabs, cx } from "../../components/ui";
import { timeAgo, usd, num, durationBetween, titleCase } from "../../lib/format";

const ICONS: Record<string, any> = { repository_analyst: Network, bug_investigator: Bug, root_cause_engineer: FileSearch, security_auditor: ShieldCheck, code_reviewer: GitPullRequest, test_engineer: FlaskConical, performance_engineer: Gauge, architecture_analyst: Layers, dependency_analyst: Boxes, documentation_agent: BookOpen };
const ACTIVE = ["queued", "planning", "running", "waiting"];

export function AgentsPage() {
  return <NeedsRepo>{(repo) => <AgentsView repo={repo} />}</NeedsRepo>;
}

function AgentsView({ repo }: { repo: any }) {
  const { can } = useAuth();
  const nav = useNavigate();
  const q = useQuery({ queryKey: ["agents"], queryFn: () => get("/agents"), refetchInterval: 5000 });
  const runs = useQuery({ queryKey: ["agent-runs"], queryFn: () => get("/agent-runs"), refetchInterval: (qq) => ((qq.state.data as any[])?.some((r) => ACTIVE.includes(r.status)) ? 2000 : 10000) });
  const [runFor, setRunFor] = useState<any>(null);
  const [cfgFor, setCfgFor] = useState<any>(null);
  const [tab, setTab] = useState<"agents" | "queue" | "history">("agents");
  if (q.isLoading) return <LoadingBlock rows={8} />;
  if (q.error) return <ErrorState error={q.error} />;
  const agents = q.data.agents;
  const active = (runs.data ?? []).filter((r: any) => ACTIVE.includes(r.status));
  return (
    <>
      <PageHeader eyebrow="AI Agent Control Center" icon={<Bot className="size-6 text-amber-deep" />} title="Specialist agents" description="Each agent has defined responsibilities, a tool allowlist, step/time limits and full execution logs. Agents hand off to each other when a task crosses specialities." />
      {!q.data.aiConfigured && <div className="mb-4"><Notice tone="info" icon={<Sparkles className="size-4 text-info" />}>No AI provider configured — agents execute their deterministic playbooks (real tool calls, exact output, no AI interpretation). <Link to="/app/integrations" className="font-medium text-amber-deep underline">Connect Claude</Link> for autonomous tool use and reasoning.</Notice></div>}
      <AgentNetwork agents={agents} runs={runs.data ?? []} />
      <Tabs className="my-5" value={tab} onChange={setTab} tabs={[{ id: "agents", label: "Agents", count: agents.length }, { id: "queue", label: "Active tasks", count: active.length }, { id: "history", label: "Execution history" }]} />
      {tab === "agents" && (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {agents.map((a: any) => {
            const I = ICONS[a.key] ?? Bot;
            const total = Object.values(a.runs).reduce((x: number, y: any) => x + y, 0) as number;
            return (
              <motion.div key={a.key} layout className="panel flex flex-col p-5">
                <div className="flex items-start gap-3">
                  <div className="relative grid size-11 shrink-0 place-items-center rounded-full bg-[radial-gradient(circle_at_32%_28%,#fff,#ebe8e0_55%,#cfcabf)] ring-1 ring-line"><I className="size-5 text-ink-2" />{ACTIVE.includes(a.status) && <span className="absolute -right-0.5 -top-0.5 size-3 animate-pulse rounded-full bg-amber ring-2 ring-white" />}</div>
                  <div className="min-w-0 flex-1"><h3 className="text-[15px] font-semibold text-ink">{a.name}</h3><p className="text-[12.5px] text-muted">{a.role}</p></div>
                  <StatusBadge status={a.config.enabled ? a.status : "disabled"} />
                </div>
                <ul className="mt-3 space-y-1 text-[12.5px] text-ink-2">{a.responsibilities.map((r: string) => <li key={r}>• {r}</li>)}</ul>
                <div className="mt-3 flex flex-wrap gap-1">{a.tools.slice(0, 6).map((t: string) => <Badge key={t} className="font-mono">{t}</Badge>)}{a.tools.length > 6 && <Badge>+{a.tools.length - 6}</Badge>}</div>
                <div className="mt-4 grid grid-cols-3 gap-2 text-center text-[11px]">
                  <div className="rounded-lg bg-ivory/70 py-1.5 ring-1 ring-line"><div className="text-[13px] font-semibold tabular-nums">{total}</div><div className="text-muted">runs</div></div>
                  <div className="rounded-lg bg-ivory/70 py-1.5 ring-1 ring-line"><div className="text-[13px] font-semibold tabular-nums">{total ? `${Math.round(((a.runs.completed ?? 0) / total) * 100)}%` : "—"}</div><div className="text-muted">success</div></div>
                  <div className="rounded-lg bg-ivory/70 py-1.5 ring-1 ring-line"><div className="text-[13px] font-semibold tabular-nums">{a.avgDurationSec != null ? `${Math.round(a.avgDurationSec)}s` : "—"}</div><div className="text-muted">avg time</div></div>
                </div>
                <div className="mt-auto flex gap-2 pt-4">
                  <Button variant="primary" size="sm" className="flex-1" icon={<Play className="size-3.5" />} disabled={!can("agents.run") || !a.config.enabled} onClick={() => setRunFor(a)}>Run</Button>
                  <Button size="sm" icon={<Settings2 className="size-3.5" />} onClick={() => setCfgFor(a)}>Configure</Button>
                </div>
                <div className="mt-2 text-[11px] text-faint">Limits: {a.limits.maxSteps} steps · {a.limits.maxToolCalls} tool calls · {Math.round(a.limits.timeoutSec / 60)} min{a.lastRunAt && ` · last run ${timeAgo(a.lastRunAt)}`}</div>
              </motion.div>
            );
          })}
        </div>
      )}
      {tab === "queue" && <RunsTable runs={active} empty="No agents are running right now." />}
      {tab === "history" && <RunsTable runs={runs.data ?? []} empty="No agent runs yet." />}
      <RunModal agent={runFor} repo={repo} onClose={() => setRunFor(null)} onStarted={(id) => nav(`/app/agents/runs/${id}`)} />
      <ConfigModal agent={cfgFor} onClose={() => setCfgFor(null)} canEdit={can("agents.configure")} />
    </>
  );
}

function AgentNetwork({ agents, runs }: { agents: any[]; runs: any[] }) {
  const W = 900, H = 340, cx0 = W / 2, cy0 = H / 2, R = 128;
  const pos = useMemo(() => Object.fromEntries(agents.map((a, i) => { const t = (i / agents.length) * Math.PI * 2 - Math.PI / 2; return [a.key, { x: cx0 + Math.cos(t) * R * 2.3, y: cy0 + Math.sin(t) * R }]; })), [agents]);
  const handoffs = runs.filter((r) => r.parent_run_id).map((r) => ({ from: runs.find((p) => p.id === r.parent_run_id)?.agent_key, to: r.agent_key, active: ACTIVE.includes(r.status) })).filter((h) => h.from);
  return (
    <Panel pad={false} className="overflow-hidden">
      <div className="flex items-center justify-between border-b border-line-2 px-5 py-3"><h3 className="text-[14px] font-semibold">Agent network</h3><div className="flex gap-3 text-[11.5px] text-muted"><span className="flex items-center gap-1"><span className="size-2 rounded-full bg-amber" />running</span><span className="flex items-center gap-1"><span className="h-0.5 w-4 bg-amber" />handoff</span></div></div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Agent network with live status and handoffs">
        <defs><radialGradient id="core" cx="35%" cy="30%"><stop offset="0" stopColor="#fff" /><stop offset=".6" stopColor="#e9e6de" /><stop offset="1" stopColor="#bdb8ac" /></radialGradient></defs>
        {agents.map((a) => <line key={a.key} x1={cx0} y1={cy0} x2={pos[a.key].x} y2={pos[a.key].y} stroke="#E7E3DA" strokeDasharray="3 4" />)}
        {handoffs.map((h, i) => <motion.line key={i} x1={pos[h.from]?.x} y1={pos[h.from]?.y} x2={pos[h.to]?.x} y2={pos[h.to]?.y} stroke="#D99A28" strokeWidth={h.active ? 2.5 : 1.5} strokeOpacity={h.active ? 1 : 0.5} initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: 1 }} />)}
        <circle cx={cx0} cy={cy0} r={30} fill="url(#core)" stroke="#D99A28" strokeOpacity={0.5} />
        <text x={cx0} y={cy0 + 48} textAnchor="middle" fontSize={11} fill="#77766F">orchestrator</text>
        {agents.map((a) => {
          const p = pos[a.key];
          const on = ACTIVE.includes(a.status);
          const I = ICONS[a.key] ?? Bot;
          return (
            <g key={a.key}>
              {on && <motion.circle cx={p.x} cy={p.y} r={22} fill="none" stroke="#D99A28" initial={{ r: 20, opacity: 0.8 }} animate={{ r: 34, opacity: 0 }} transition={{ repeat: Infinity, duration: 1.6 }} />}
              <circle cx={p.x} cy={p.y} r={20} fill="white" stroke={on ? "#D99A28" : "#E7E3DA"} strokeWidth={on ? 2 : 1} />
              <foreignObject x={p.x - 9} y={p.y - 9} width={18} height={18}><I className="size-[18px] text-ink-2" /></foreignObject>
              <text x={p.x} y={p.y + 36} textAnchor="middle" fontSize={11} fill="#242521">{a.name}</text>
            </g>
          );
        })}
      </svg>
    </Panel>
  );
}

function RunsTable({ runs, empty }: { runs: any[]; empty: string }) {
  if (!runs.length) return <Panel><EmptyState title={empty} /></Panel>;
  return (
    <Panel pad={false}>
      <Table head={["Agent", "Task", "Status", "Steps", "Tokens", "Cost", "Duration", "Started"]}>
        {runs.map((r) => (
          <tr key={r.id} className="hover:bg-ivory/50">
            <td className="px-4 py-2.5"><Link to={`/app/agents/runs/${r.id}`} className="font-medium text-ink hover:text-amber-deep">{titleCase(r.agent_key)}</Link>{r.parent_run_id && <div className="text-[11px] text-muted">handoff</div>}</td>
            <td className="max-w-xs truncate px-4 py-2.5 text-muted">{r.task}</td>
            <td className="px-4 py-2.5"><StatusBadge status={r.status} /></td>
            <td className="px-4 py-2.5 tabular-nums">{r.steps}</td>
            <td className="px-4 py-2.5 tabular-nums text-muted">{r.ai_used ? num(r.input_tokens + r.output_tokens) : "—"}</td>
            <td className="px-4 py-2.5 tabular-nums text-muted">{r.ai_used ? usd(r.cost_usd) : "—"}</td>
            <td className="px-4 py-2.5 text-muted">{durationBetween(r.started_at, r.finished_at)}</td>
            <td className="px-4 py-2.5 text-muted">{timeAgo(r.created_at)}</td>
          </tr>
        ))}
      </Table>
    </Panel>
  );
}

function RunModal({ agent, repo, onClose, onStarted }: { agent: any; repo: any; onClose: () => void; onStarted: (id: string) => void }) {
  const [task, setTask] = useState("");
  const [busy, setBusy] = useState(false);
  const { repos } = useRepo();
  const [repoId, setRepoId] = useState(repo.id);
  return (
    <Modal open={!!agent} onClose={onClose} title={`Run ${agent?.name}`} footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={async () => { setBusy(true); try { const r = await post("/agent-runs", { repositoryId: repoId, agent: agent.key, task: task || undefined }); onClose(); setTask(""); onStarted(r.id); } catch (e: any) { toast.error(e.message); } finally { setBusy(false); } }}>Start run</Button></>}>
      <div className="space-y-4">
        <Field label="Repository"><Select className="w-full" value={repoId} onChange={(e) => setRepoId(e.target.value)}>{repos?.filter((r) => r.stats).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</Select></Field>
        <Field label="Task" hint={`Leave empty for the default: “${agent?.instructions ? "" : ""}${AGENT_DEFAULTS[agent?.key] ?? ""}”`}><Textarea rows={4} value={task} onChange={(e) => setTask(e.target.value)} placeholder="Describe what you want this agent to do…" /></Field>
        <div className="text-[12px] text-muted">Permitted tools: <span className="font-mono">{agent?.tools.join(", ")}</span></div>
      </div>
    </Modal>
  );
}
const AGENT_DEFAULTS: Record<string, string> = {
  repository_analyst: "Produce an onboarding overview of this repository.", bug_investigator: "Scan for bugs and triage the most impactful ones.", root_cause_engineer: "Identify the riskiest code paths and their likely failure modes.",
  security_auditor: "Audit the repository's security posture and prioritise remediation.", code_reviewer: "Review the most complex modules for correctness risks.", test_engineer: "Find the riskiest untested code and propose tests.",
  performance_engineer: "Identify the most significant performance risks.", architecture_analyst: "Assess the architecture and recommend structural improvements.", dependency_analyst: "Review dependencies and produce an upgrade plan.", documentation_agent: "Write architecture documentation for this repository.",
};

function ConfigModal({ agent, onClose, canEdit }: { agent: any; onClose: () => void; canEdit: boolean }) {
  const qc = useQueryClient();
  const [cfg, setCfg] = useState<any>(null);
  const c = cfg ?? (agent ? { enabled: agent.config.enabled, maxSteps: agent.config.maxSteps ?? agent.limits.maxSteps, disabledTools: agent.config.disabledTools ?? [], extraInstructions: agent.config.extraInstructions ?? "" } : null);
  return (
    <Modal open={!!agent} onClose={() => { setCfg(null); onClose(); }} width={680} title={`Configure ${agent?.name}`} footer={canEdit && <Button variant="primary" onClick={async () => { try { await patch(`/agents/${agent.key}`, c); toast.success("Saved"); qc.invalidateQueries({ queryKey: ["agents"] }); setCfg(null); onClose(); } catch (e: any) { toast.error(e.message); } }}>Save</Button>}>
      {c && (
        <div className="space-y-4">
          {!canEdit && <Notice tone="info">Only owners and admins can change agent configuration.</Notice>}
          <Toggle checked={c.enabled} disabled={!canEdit} onChange={(v) => setCfg({ ...c, enabled: v })} label="Agent enabled" />
          <Field label="Max reasoning steps"><Input type="number" min={1} max={40} disabled={!canEdit} value={c.maxSteps} onChange={(e) => setCfg({ ...c, maxSteps: Number(e.target.value) })} /></Field>
          <Field label="Tool permissions"><div className="grid grid-cols-2 gap-2">{agent.tools.map((t: string) => <Toggle key={t} disabled={!canEdit} checked={!c.disabledTools.includes(t)} onChange={(v) => setCfg({ ...c, disabledTools: v ? c.disabledTools.filter((x: string) => x !== t) : [...c.disabledTools, t] })} label={t} />)}</div></Field>
          <Field label="Additional workspace instructions"><Textarea rows={3} disabled={!canEdit} value={c.extraInstructions} onChange={(e) => setCfg({ ...c, extraInstructions: e.target.value })} /></Field>
          <details><summary className="cursor-pointer text-[12.5px] text-muted">System instructions</summary><pre className="mt-2 whitespace-pre-wrap rounded-lg bg-ivory p-3 text-[11.5px] text-ink-2">{agent.instructions}</pre></details>
        </div>
      )}
    </Modal>
  );
}

export function AgentRunPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const { can } = useAuth();
  const q = useQuery({ queryKey: ["agent-run", id], queryFn: () => get(`/agent-runs/${id}`), refetchInterval: (qq) => (ACTIVE.includes((qq.state.data as any)?.status) ? 1200 : false) });
  if (q.isLoading) return <LoadingBlock rows={8} />;
  if (q.error) return <ErrorState error={q.error} />;
  const r = q.data;
  const final = r.stepLog.filter((s: any) => !(s.kind === "message" && s.name === "final"));
  return (
    <>
      <button onClick={() => nav("/app/agents")} className="mb-4 flex items-center gap-1.5 text-[13px] text-muted hover:text-ink"><ArrowLeft className="size-4" />Agents</button>
      <PageHeader eyebrow={`Agent run · ${r.repository ?? ""}`} title={titleCase(r.agent_key)} description={r.task}
        actions={<>{ACTIVE.includes(r.status) && can("agents.run") && <Button icon={<X className="size-4" />} onClick={async () => { try { await post(`/agent-runs/${r.id}/cancel`); toast("Cancelling…"); } catch (e: any) { toast.error(e.message); } }}>Cancel</Button>}<StatusBadge status={r.status} /></>} />
      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-5">
        {[["Steps", r.steps], ["Mode", r.ai_used ? "AI (Claude)" : "Deterministic playbook"], ["Tokens", r.ai_used ? num(r.input_tokens + r.output_tokens) : "—"], ["Cost", r.ai_used ? usd(r.cost_usd) : "—"], ["Duration", durationBetween(r.started_at, r.finished_at ?? (ACTIVE.includes(r.status) ? new Date().toISOString() : null))]].map(([k, v]) => <div key={k as string} className="panel p-3"><div className="text-[11.5px] text-muted">{k}</div><div className="mt-1 text-[15px] font-semibold text-ink">{v}</div></div>)}
      </div>
      {r.error && <div className="mb-4"><Notice tone="danger">{r.error}</Notice></div>}
      <div className="grid gap-4 xl:grid-cols-[1fr_1fr]">
        <Panel title="Execution log" pad={false}>
          <ol className="scroll-thin max-h-[70vh] overflow-y-auto">
            {final.map((s: any) => <StepRow key={s.seq} s={s} />)}
            {ACTIVE.includes(r.status) && <li className="flex items-center gap-2 px-5 py-3 text-[12.5px] text-muted"><span className="size-2 animate-pulse rounded-full bg-amber" />{r.status}…</li>}
          </ol>
        </Panel>
        <div className="space-y-4">
          <Panel title="Output">{r.output ? <Markdown>{r.output}</Markdown> : <p className="text-[13px] text-muted">{ACTIVE.includes(r.status) ? "The report appears when the agent finishes." : "No output."}</p>}</Panel>
          {r.children?.length > 0 && <Panel title="Handoffs" pad={false}>{r.children.map((c: any) => <Link key={c.id} to={`/app/agents/runs/${c.id}`} className="flex items-center gap-3 border-b border-line-2 px-5 py-2.5 last:border-0 hover:bg-ivory/50"><ArrowRightLeft className="size-4 text-amber-deep" /><span className="font-medium">{titleCase(c.agent_key)}</span><span className="truncate text-[12.5px] text-muted">{c.task}</span><StatusBadge status={c.status} /></Link>)}</Panel>}
        </div>
      </div>
    </>
  );
}

function StepRow({ s }: { s: any }) {
  const [open, setOpen] = useState(false);
  const icon = { plan: ListChecks, tool_call: Wrench, tool_result: Wrench, message: MessageSquare, handoff: ArrowRightLeft, error: AlertTriangle, log: MessageSquare }[s.kind as string] ?? MessageSquare;
  const I = icon;
  let content = s.content;
  try { const p = JSON.parse(s.content); content = typeof p === "string" ? p : JSON.stringify(p, null, 2); } catch { /* raw */ }
  const isText = s.kind === "plan" || s.kind === "message";
  return (
    <li className="border-b border-line-2 px-5 py-3 last:border-0">
      <button className="flex w-full items-center gap-2 text-left" onClick={() => setOpen(!open)}>
        <I className={cx("size-4", s.kind === "error" ? "text-danger" : s.kind === "tool_call" ? "text-amber-deep" : "text-ink-2")} />
        <span className="text-[12.5px] font-medium text-ink">{s.kind === "tool_call" ? `Call ${s.name}` : s.kind === "tool_result" ? `Result ${s.name}` : titleCase(s.kind)}</span>
        {s.duration_ms != null && <span className="text-[11px] text-faint">{s.duration_ms}ms</span>}
        <span className="ml-auto text-[11px] text-faint">#{s.seq}</span>
      </button>
      {(open || isText) && (isText ? <div className="mt-2 text-[13px]"><Markdown>{content}</Markdown></div> : <pre className="scroll-thin mt-2 max-h-72 overflow-auto rounded-lg bg-[#FCFBF8] p-2.5 font-mono text-[11px] text-ink-2 ring-1 ring-line">{content}</pre>)}
    </li>
  );
}
