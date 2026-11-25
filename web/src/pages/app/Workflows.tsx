import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ReactFlow, ReactFlowProvider, Background, Controls, MiniMap, addEdge, useNodesState, useEdgesState, useReactFlow, Handle, Position, type Connection, type Node, type Edge } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Workflow, Plus, Save, Copy, Download, Trash2, Play, Zap, ScanSearch, Bot, ShieldCheck, Bug, FlaskConical, TestTube2, GitPullRequest, GitBranch, UserCheck, Bell, FileText, CircleStop, ArrowLeft, Check, X } from "lucide-react";
import { get, post, put, del } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { useRepo } from "../../lib/repo";
import { NeedsRepo } from "../../components/AppShell";
import { PageHeader, Panel, Button, Modal, Field, Input, Textarea, Select, EmptyState, LoadingBlock, StatusBadge, Badge, Notice, Table, Toggle, cx } from "../../components/ui";
import { timeAgo, fmtDate, titleCase } from "../../lib/format";

const TYPES: Record<string, { label: string; icon: any; color: string; desc: string; handles?: string[] }> = {
  trigger: { label: "Trigger", icon: Zap, color: "#D99A28", desc: "Starts the workflow (manual run)" },
  repo_analyzer: { label: "Repository Analyzer", icon: ScanSearch, color: "#6B7F96", desc: "Run an analysis preset (optionally pull latest)" },
  agent: { label: "AI Agent", icon: Bot, color: "#8A6FA0", desc: "Run a specialist agent" },
  security_scan: { label: "Security Scan", icon: ShieldCheck, color: "#D94C4C", desc: "Security + dependency scan → security.*" },
  bug_scan: { label: "Bug Scan", icon: Bug, color: "#B97E17", desc: "Bug analysis → bugs.*" },
  test_generator: { label: "Test Generator", icon: FlaskConical, color: "#23966A", desc: "Generate + execute tests for a file → tests.*" },
  test_runner: { label: "Test Runner", icon: TestTube2, color: "#23966A", desc: "Run the existing suite in the sandbox → tests.*" },
  code_review: { label: "Code Review", icon: GitPullRequest, color: "#3B6EA8", desc: "Review a commit (default HEAD) → review.risk" },
  condition: { label: "Condition", icon: GitBranch, color: "#4A4A44", desc: "Branch on results, e.g. security.critical > 0", handles: ["true", "false"] },
  approval: { label: "Approval", icon: UserCheck, color: "#D99A28", desc: "Pause until a human approves", handles: ["approved", "rejected"] },
  notification: { label: "Notification", icon: Bell, color: "#6B7F96", desc: "In-app, Slack or webhook" },
  report: { label: "Report", icon: FileText, color: "#4A4A44", desc: "Generate a Markdown report" },
  end: { label: "End", icon: CircleStop, color: "#A3A199", desc: "End of workflow" },
};
const STATE_COLOR: Record<string, string> = { running: "#D99A28", completed: "#23966A", failed: "#D94C4C", waiting: "#6B7F96", skipped: "#C9C6BD" };

function WfNode({ data, selected, type }: any) {
  const t = TYPES[type] ?? TYPES.end;
  const I = t.icon;
  const st = data.__state;
  return (
    <div className={cx("min-w-[170px] rounded-xl border bg-white shadow-[0_1px_3px_rgba(36,37,33,.08)]", selected ? "border-amber ring-4 ring-amber-soft/70" : "border-line")} style={st ? { borderColor: STATE_COLOR[st], boxShadow: `0 0 0 3px ${STATE_COLOR[st]}22` } : undefined}>
      {type !== "trigger" && <Handle type="target" position={Position.Left} className="!size-2.5 !border-2 !border-white !bg-silver" />}
      <div className="flex items-center gap-2 px-3 py-2.5">
        <span className="grid size-7 place-items-center rounded-lg" style={{ background: `${t.color}18`, color: t.color }}><I className="size-4" /></span>
        <div className="min-w-0"><div className="truncate text-[12.5px] font-semibold text-ink">{data.label || t.label}</div><div className="text-[10.5px] text-muted">{t.label}</div></div>
        {st && <span className={cx("ml-auto size-2 rounded-full", st === "running" && "animate-pulse")} style={{ background: STATE_COLOR[st] }} title={st} />}
      </div>
      {t.handles ? t.handles.map((h, i) => (
        <div key={h} className="relative">
          <div className="pr-4 text-right text-[10px] text-muted" style={{ marginTop: i ? 0 : -4, paddingBottom: 4 }}>{h}</div>
          <Handle id={h} type="source" position={Position.Right} style={{ top: "auto", bottom: 6 }} className={cx("!size-2.5 !border-2 !border-white", h === "true" || h === "approved" ? "!bg-success" : "!bg-danger")} />
        </div>
      )) : type !== "end" && <Handle type="source" position={Position.Right} className="!size-2.5 !border-2 !border-white !bg-amber" />}
    </div>
  );
}
const nodeTypes = Object.fromEntries(Object.keys(TYPES).map((k) => [k, WfNode]));

export default function Workflows() {
  return <NeedsRepo>{() => <WorkflowsView />}</NeedsRepo>;
}

function WorkflowsView() {
  const [params, setParams] = useSearchParams();
  const { can } = useAuth();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["workflows"], queryFn: () => get("/workflows") });
  const editing = params.get("id");
  const execution = params.get("execution");
  const create = async (name: string, definition: any, description?: string) => {
    try { const r = await post("/workflows", { name, definition, description }); qc.invalidateQueries({ queryKey: ["workflows"] }); setParams({ id: r.id }); } catch (e: any) { toast.error(e.message); }
  };
  if (execution) return <ExecutionView id={execution} onBack={() => setParams(editing ? { id: editing } : {})} />;
  if (editing) return <ReactFlowProvider><Editor id={editing} onBack={() => setParams({})} /></ReactFlowProvider>;
  return (
    <>
      <PageHeader eyebrow="Workflow Studio" icon={<Workflow className="size-6 text-amber-deep" />} title="Workflows" description="Compose scans, agents, tests, reviews, conditions, approvals, notifications and reports into automated engineering workflows. Executions run on the server with logs, retries and approvals."
        actions={can("workflows.edit") && <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => create("Untitled workflow", { nodes: [{ id: "t", type: "trigger", position: { x: 80, y: 160 }, data: { label: "Manual trigger" } }], edges: [] })}>New workflow</Button>} />
      <Approvals />
      {q.isLoading ? <LoadingBlock /> : (
        <>
          <Panel pad={false} title="Your workflows" className="mb-4">
            {!q.data.workflows.length ? <EmptyState icon={<Workflow className="size-5" />} title="No workflows yet" description="Start from a template below or build one from scratch." /> : (
              <Table head={["Name", "Steps", "Last run", "Executions", "Updated", ""]}>
                {q.data.workflows.map((w: any) => (
                  <tr key={w.id} className="hover:bg-ivory/50">
                    <td className="px-4 py-3"><button onClick={() => setParams({ id: w.id })} className="font-medium text-ink hover:text-amber-deep">{w.name}</button>{w.description && <div className="text-[11.5px] text-muted">{w.description}</div>}</td>
                    <td className="px-4 py-3 tabular-nums">{w.definition.nodes?.length ?? 0}</td>
                    <td className="px-4 py-3">{w.last_status ? <StatusBadge status={w.last_status} /> : <span className="text-faint">never</span>}</td>
                    <td className="px-4 py-3 tabular-nums">{w.executions}</td>
                    <td className="px-4 py-3 text-muted">{timeAgo(w.updated_at)}</td>
                    <td className="px-4 py-3 text-right"><Button size="sm" onClick={() => setParams({ id: w.id })}>Open</Button></td>
                  </tr>
                ))}
              </Table>
            )}
          </Panel>
          <div className="mb-2 text-[12px] font-semibold uppercase tracking-[0.12em] text-muted">Templates</div>
          <div className="grid gap-4 md:grid-cols-2">
            {q.data.templates.map((t: any) => (
              <div key={t.name} className="panel p-5">
                <h3 className="text-[15px] font-semibold text-ink">{t.name}</h3>
                <p className="mt-1 text-[13px] text-muted">{t.description}</p>
                <div className="mt-3 flex flex-wrap gap-1">{t.definition.nodes.map((n: any) => <Badge key={n.id}>{TYPES[n.type]?.label}</Badge>)}</div>
                {can("workflows.edit") && <Button className="mt-4" size="sm" onClick={() => create(t.name, t.definition, t.description)}>Use template</Button>}
              </div>
            ))}
          </div>
        </>
      )}
    </>
  );
}

function Approvals() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["approvals"], queryFn: () => get("/approvals"), refetchInterval: 8000 });
  const pending = (q.data ?? []).filter((a: any) => a.status === "pending");
  if (!pending.length) return null;
  const decide = async (id: string, decision: string) => { try { await post(`/approvals/${id}/decide`, { decision }); toast.success(`Step ${decision}`); qc.invalidateQueries(); } catch (e: any) { toast.error(e.message); } };
  return (
    <Panel title="Pending approvals" className="mb-4" pad={false}>
      {pending.map((a: any) => (
        <div key={a.id} className="flex items-center gap-3 border-b border-line-2 px-5 py-3 last:border-0">
          <UserCheck className="size-4 text-amber-deep" /><div className="min-w-0 flex-1"><div className="text-[13px] font-medium">{a.title}</div><div className="text-[11.5px] text-muted">{a.workflow} · requested {timeAgo(a.created_at)}</div></div>
          {can("approvals.decide") ? <><Button size="sm" variant="danger" icon={<X className="size-3.5" />} onClick={() => decide(a.id, "rejected")}>Reject</Button><Button size="sm" variant="primary" icon={<Check className="size-3.5" />} onClick={() => decide(a.id, "approved")}>Approve</Button></> : <Badge>Needs owner/admin/security</Badge>}
        </div>
      ))}
    </Panel>
  );
}

function Editor({ id, onBack }: { id: string; onBack: () => void }) {
  const { can } = useAuth();
  const { repos, repo } = useRepo();
  const [, setParams] = useSearchParams();
  const qc = useQueryClient();
  const rf = useReactFlow();
  const q = useQuery({ queryKey: ["workflow", id], queryFn: () => get(`/workflows/${id}`), refetchInterval: 10000 });
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const [selId, setSelId] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [runOpen, setRunOpen] = useState(false);
  const [runRepo, setRunRepo] = useState(repo?.id ?? "");
  const loaded = useRef(false);
  useEffect(() => {
    if (!q.data || loaded.current) return;
    loaded.current = true;
    setName(q.data.name);
    setDesc(q.data.description ?? "");
    setNodes(q.data.definition.nodes.map((n: any) => ({ ...n, position: n.position ?? { x: 0, y: 0 } })));
    setEdges(q.data.definition.edges.map((e: any) => ({ ...e, animated: false, style: { stroke: "#C9C6BD", strokeWidth: 1.6 } })));
  }, [q.data]);
  const onConnect = useCallback((c: Connection) => { setEdges((es) => addEdge({ ...c, id: `e${Date.now()}`, style: { stroke: "#C9C6BD", strokeWidth: 1.6 } }, es)); setDirty(true); }, []);
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    const type = e.dataTransfer.getData("application/df-node");
    if (!type) return;
    const pos = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY });
    const nid = `${type}_${Math.random().toString(36).slice(2, 7)}`;
    setNodes((ns) => [...ns, { id: nid, type, position: pos, data: { label: TYPES[type].label, config: type === "condition" ? { expression: "security.critical > 0" } : type === "notification" ? { message: "Workflow update: {{findings.total}} open findings", channel: "in-app" } : {} } }]);
    setSelId(nid);
    setDirty(true);
  };
  const definition = () => ({ nodes: nodes.map((n) => ({ id: n.id, type: n.type, position: n.position, data: { label: (n.data as any).label, config: (n.data as any).config ?? {} } })), edges: edges.map((e) => ({ id: e.id, source: e.source, target: e.target, sourceHandle: e.sourceHandle ?? null })) });
  const save = async () => { try { await put(`/workflows/${id}`, { name, description: desc || null, definition: definition() }); setDirty(false); qc.invalidateQueries({ queryKey: ["workflows"] }); toast.success("Saved"); return true; } catch (e: any) { toast.error(e.message); return false; } };
  const sel = nodes.find((n) => n.id === selId);
  const setCfg = (patch: Record<string, any>) => { setNodes((ns) => ns.map((n) => (n.id === selId ? { ...n, data: { ...n.data, config: { ...((n.data as any).config ?? {}), ...patch } } } : n))); setDirty(true); };
  const setLabel = (label: string) => { setNodes((ns) => ns.map((n) => (n.id === selId ? { ...n, data: { ...n.data, label } } : n))); setDirty(true); };
  const agents = useQuery({ queryKey: ["agents"], queryFn: () => get("/agents") });
  if (q.isLoading) return <LoadingBlock rows={8} />;
  const editable = can("workflows.edit");
  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <button onClick={onBack} className="flex items-center gap-1.5 text-[13px] text-muted hover:text-ink"><ArrowLeft className="size-4" />Workflows</button>
        <Input className="h-9 max-w-xs font-semibold" value={name} disabled={!editable} onChange={(e) => { setName(e.target.value); setDirty(true); }} />
        {dirty && <Badge tone="amber">unsaved</Badge>}
        <div className="ml-auto flex flex-wrap gap-2">
          <Button icon={<Download className="size-4" />} onClick={() => { const blob = new Blob([JSON.stringify({ name, description: desc, definition: definition() }, null, 2)], { type: "application/json" }); const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `${name.replace(/\W+/g, "-")}.workflow.json`; a.click(); }}>Export</Button>
          {editable && <Button icon={<Copy className="size-4" />} onClick={async () => { const r = await post(`/workflows/${id}/duplicate`); qc.invalidateQueries({ queryKey: ["workflows"] }); setParams({ id: r.id }); loaded.current = false; toast.success("Duplicated"); }}>Duplicate</Button>}
          {editable && <Button icon={<Trash2 className="size-4" />} variant="danger" onClick={async () => { if (!confirm("Delete this workflow and its execution history?")) return; await del(`/workflows/${id}`); qc.invalidateQueries({ queryKey: ["workflows"] }); onBack(); }}>Delete</Button>}
          {editable && <Button icon={<Save className="size-4" />} onClick={save} disabled={!dirty}>Save</Button>}
          {can("workflows.run") && <Button variant="primary" icon={<Play className="size-4" />} onClick={async () => { if (dirty && !(await save())) return; setRunOpen(true); }}>Run</Button>}
        </div>
      </div>
      <div className="grid gap-4 xl:grid-cols-[200px_1fr_300px]">
        <Panel title="Nodes" pad={false}>
          <div className="space-y-1 p-2">
            {Object.entries(TYPES).filter(([k]) => k !== "trigger").map(([k, t]) => (
              <div key={k} draggable={editable} onDragStart={(e) => { e.dataTransfer.setData("application/df-node", k); e.dataTransfer.effectAllowed = "move"; }} className={cx("flex cursor-grab items-center gap-2 rounded-lg border border-line bg-white px-2.5 py-2 text-[12px] active:cursor-grabbing", !editable && "opacity-50")} title={t.desc}>
                <t.icon className="size-3.5" style={{ color: t.color }} />{t.label}
              </div>
            ))}
            <p className="px-1 pt-2 text-[11px] text-faint">Drag onto the canvas, then connect handles.</p>
          </div>
        </Panel>
        <Panel pad={false} className="h-[620px] overflow-hidden">
          <div className="h-full" onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; }} onDrop={onDrop}>
            <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} onNodesChange={(c) => { onNodesChange(c); if (c.toArray().some((x) => x.type === "position" || x.type === "remove")) setDirty(true); }} onEdgesChange={(c) => { onEdgesChange(c); if (c.toArray().some((x) => x.type === "remove")) setDirty(true); }} onConnect={onConnect} onNodeClick={(_, n) => setSelId(n.id)} onPaneClick={() => setSelId(null)} nodesDraggable={editable} nodesConnectable={editable} deleteKeyCode={editable ? ["Backspace", "Delete"] : null} fitView proOptions={{ hideAttribution: true }}>
              <Background color="#E7E3DA" gap={20} size={1.2} />
              <Controls position="bottom-right" />
              <MiniMap pannable zoomable maskColor="rgba(247,246,242,.7)" nodeColor={(n) => TYPES[n.type ?? "end"]?.color ?? "#ccc"} />
            </ReactFlow>
          </div>
        </Panel>
        <div className="space-y-4">
          <Panel title={sel ? "Node configuration" : "Workflow"}>
            {!sel ? (
              <div className="space-y-3"><Field label="Description"><Textarea rows={3} value={desc} disabled={!editable} onChange={(e) => { setDesc(e.target.value); setDirty(true); }} /></Field><p className="text-[12px] text-muted">Select a node to configure it. Conditions can reference <code className="font-mono">security.*</code>, <code className="font-mono">bugs.*</code>, <code className="font-mono">findings.*</code>, <code className="font-mono">tests.failed</code>, <code className="font-mono">review.risk</code>.</p></div>
            ) : (
              <NodeConfig node={sel} setLabel={setLabel} setCfg={setCfg} agents={agents.data?.agents ?? []} disabled={!editable} onDelete={() => { setNodes((ns) => ns.filter((n) => n.id !== selId)); setEdges((es) => es.filter((e) => e.source !== selId && e.target !== selId)); setSelId(null); setDirty(true); }} />
            )}
          </Panel>
          <Panel title="Executions" pad={false}>
            {(q.data.executions ?? []).slice(0, 10).map((x: any) => <button key={x.id} onClick={() => setParams({ id, execution: x.id })} className="flex w-full items-center gap-2 border-b border-line-2 px-4 py-2 text-left text-[12.5px] last:border-0 hover:bg-ivory/50"><StatusBadge status={x.status} /><span className="text-muted">{timeAgo(x.started_at)}</span></button>)}
            {!q.data.executions?.length && <div className="px-4 py-3 text-[12.5px] text-muted">Not run yet.</div>}
          </Panel>
        </div>
      </div>
      <Modal open={runOpen} onClose={() => setRunOpen(false)} title={`Run “${name}”`} footer={<><Button variant="ghost" onClick={() => setRunOpen(false)}>Cancel</Button><Button variant="primary" onClick={async () => { try { const r = await post(`/workflows/${id}/run`, { repositoryId: runRepo }); setRunOpen(false); setParams({ id, execution: r.id }); } catch (e: any) { toast.error(e.message); } }}>Start execution</Button></>}>
        <Field label="Repository"><Select className="w-full" value={runRepo} onChange={(e) => setRunRepo(e.target.value)}>{repos?.filter((r) => r.stats).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</Select></Field>
      </Modal>
    </>
  );
}

function NodeConfig({ node, setLabel, setCfg, agents, disabled, onDelete }: { node: Node; setLabel: (s: string) => void; setCfg: (p: any) => void; agents: any[]; disabled: boolean; onDelete: () => void }) {
  const c = ((node.data as any).config ?? {}) as Record<string, any>;
  const t = node.type!;
  return (
    <div className="space-y-3">
      <Badge>{TYPES[t]?.label}</Badge>
      <p className="text-[12px] text-muted">{TYPES[t]?.desc}</p>
      <Field label="Label"><Input disabled={disabled} value={(node.data as any).label ?? ""} onChange={(e) => setLabel(e.target.value)} /></Field>
      {t === "repo_analyzer" && <><Field label="Preset"><Select className="w-full" disabled={disabled} value={c.preset ?? "quick"} onChange={(e) => setCfg({ preset: e.target.value })}><option value="quick">Quick</option><option value="full">Full</option><option value="security">Security</option><option value="architecture">Architecture</option></Select></Field><Toggle disabled={disabled} checked={!!c.refresh} onChange={(v) => setCfg({ refresh: v })} label="Pull latest and re-index first" /></>}
      {t === "agent" && <><Field label="Agent"><Select className="w-full" disabled={disabled} value={c.agent ?? "repository_analyst"} onChange={(e) => setCfg({ agent: e.target.value })}>{agents.map((a) => <option key={a.key} value={a.key}>{a.name}</option>)}</Select></Field><Field label="Task (optional)"><Textarea rows={3} disabled={disabled} value={c.task ?? ""} onChange={(e) => setCfg({ task: e.target.value })} /></Field></>}
      {t === "test_generator" && <><Field label="File path"><Input disabled={disabled} value={c.path ?? ""} onChange={(e) => setCfg({ path: e.target.value })} placeholder="src/lib/utils.ts" /></Field><Field label="Function (optional)"><Input disabled={disabled} value={c.symbol ?? ""} onChange={(e) => setCfg({ symbol: e.target.value })} /></Field></>}
      {t === "test_runner" && <Toggle disabled={disabled} checked={!!c.installDependencies} onChange={(v) => setCfg({ installDependencies: v })} label="Install dependencies in sandbox" />}
      {t === "code_review" && <Field label="Commit SHA" hint="Leave empty to review the indexed HEAD commit."><Input disabled={disabled} value={c.sha ?? ""} onChange={(e) => setCfg({ sha: e.target.value })} /></Field>}
      {t === "condition" && <Field label="Expression" hint="e.g. security.critical > 0 || security.high >= 3 · tests.failed == 0 · review.risk < 50"><Input disabled={disabled} className="font-mono text-[12px]" value={c.expression ?? ""} onChange={(e) => setCfg({ expression: e.target.value })} /></Field>}
      {t === "notification" && <><Field label="Message" hint="Use {{security.critical}}, {{findings.total}}, {{tests.failed}}…"><Textarea rows={3} disabled={disabled} value={c.message ?? ""} onChange={(e) => setCfg({ message: e.target.value })} /></Field><Field label="Channel"><Select className="w-full" disabled={disabled} value={c.channel ?? "in-app"} onChange={(e) => setCfg({ channel: e.target.value })}><option value="in-app">In-app only</option><option value="slack">Slack (integration)</option><option value="webhook">Webhook (integration)</option></Select></Field></>}
      {t === "report" && <Field label="Report title"><Input disabled={disabled} value={c.title ?? ""} onChange={(e) => setCfg({ title: e.target.value })} /></Field>}
      {!["trigger", "condition", "approval", "end"].includes(t) && <div className="grid grid-cols-2 gap-2"><Field label="Retries"><Select className="w-full" disabled={disabled} value={c.retries ?? 0} onChange={(e) => setCfg({ retries: Number(e.target.value) })}>{[0, 1, 2, 3].map((n) => <option key={n} value={n}>{n}</option>)}</Select></Field><Field label="On error"><Select className="w-full" disabled={disabled} value={c.onError ?? "fail"} onChange={(e) => setCfg({ onError: e.target.value })}><option value="fail">Fail workflow</option><option value="continue">Continue</option></Select></Field></div>}
      {t !== "trigger" && !disabled && <Button size="sm" variant="danger" icon={<Trash2 className="size-3.5" />} onClick={onDelete}>Remove node</Button>}
    </div>
  );
}

function ExecutionView({ id, onBack }: { id: string; onBack: () => void }) {
  const { can } = useAuth();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["workflow-execution", id], queryFn: () => get(`/workflow-executions/${id}`), refetchInterval: (qq) => (["queued", "running", "waiting_approval"].includes((qq.state.data as any)?.status) ? 1500 : false) });
  const nodes = useMemo(() => (q.data?.definition.nodes ?? []).map((n: any) => ({ ...n, draggable: false, data: { ...n.data, __state: q.data.node_states[n.id]?.status } })), [q.data]);
  const edges = useMemo(() => (q.data?.definition.edges ?? []).map((e: any) => { const s = q.data.node_states[e.source]?.status; const t = q.data.node_states[e.target]?.status; const active = s === "completed" && t && t !== "skipped"; return { ...e, animated: t === "running", style: { stroke: active ? "#D99A28" : "#D6D2C8", strokeWidth: active ? 2.2 : 1.4 } }; }), [q.data]);
  if (q.isLoading) return <LoadingBlock rows={8} />;
  const x = q.data;
  const pending = x.approvals.filter((a: any) => a.status === "pending");
  return (
    <>
      <button onClick={onBack} className="mb-4 flex items-center gap-1.5 text-[13px] text-muted hover:text-ink"><ArrowLeft className="size-4" />Back</button>
      <PageHeader eyebrow="Workflow execution" title={<span className="flex items-center gap-3">Execution <span className="font-mono text-[16px] text-muted">{x.id}</span></span>} description={`Started ${fmtDate(x.started_at)}${x.finished_at ? ` · finished ${fmtDate(x.finished_at)}` : ""}`}
        actions={<>{["queued", "running", "waiting_approval"].includes(x.status) && can("workflows.run") && <Button icon={<X className="size-4" />} onClick={async () => { await post(`/workflow-executions/${x.id}/cancel`); qc.invalidateQueries({ queryKey: ["workflow-execution", id] }); }}>Cancel</Button>}<StatusBadge status={x.status} /></>} />
      {x.error && <div className="mb-4"><Notice tone="danger">{x.error}</Notice></div>}
      {pending.map((a: any) => (
        <div key={a.id} className="mb-4"><Notice tone="amber" icon={<UserCheck className="size-4 text-amber-deep" />}><div className="flex flex-wrap items-center gap-3"><span><b>{a.title}</b> is waiting for approval.</span>{can("approvals.decide") && <span className="ml-auto flex gap-2"><Button size="sm" variant="danger" onClick={async () => { await post(`/approvals/${a.id}/decide`, { decision: "rejected" }); qc.invalidateQueries(); }}>Reject</Button><Button size="sm" variant="primary" onClick={async () => { await post(`/approvals/${a.id}/decide`, { decision: "approved" }); qc.invalidateQueries(); }}>Approve</Button></span>}</div></Notice></div>
      ))}
      <div className="grid gap-4 xl:grid-cols-[1fr_380px]">
        <Panel pad={false} className="h-[520px] overflow-hidden"><ReactFlowProvider><ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} fitView nodesConnectable={false} nodesDraggable={false} proOptions={{ hideAttribution: true }}><Background color="#E7E3DA" gap={20} size={1.2} /><Controls showInteractive={false} position="bottom-right" /></ReactFlow></ReactFlowProvider></Panel>
        <div className="space-y-4">
          <Panel title="Steps" pad={false}>
            {x.definition.nodes.map((n: any) => { const st = x.node_states[n.id]; return (
              <details key={n.id} className="border-b border-line-2 last:border-0"><summary className="flex cursor-pointer items-center gap-2 px-4 py-2.5 text-[12.5px]"><StatusBadge status={st?.status ?? "pending"} /><span className="font-medium">{n.data?.label ?? titleCase(n.type)}</span>{st?.attempts > 1 && <Badge>{st.attempts} attempts</Badge>}</summary>{(st?.output || st?.error) && <pre className="mx-4 mb-3 max-h-48 overflow-auto rounded-lg bg-[#FCFBF8] p-2 font-mono text-[11px] text-ink-2 ring-1 ring-line">{st.error ?? JSON.stringify(st.output, null, 2)}</pre>}</details>
            ); })}
          </Panel>
          <Panel title="Logs" pad={false}><div className="scroll-thin max-h-72 overflow-y-auto p-3 font-mono text-[11px] leading-relaxed">{x.logs.map((l: any, i: number) => <div key={i} className={l.level === "error" ? "text-danger" : l.level === "warn" ? "text-amber-deep" : "text-ink-2"}><span className="text-faint">{l.at.slice(11, 19)}</span> {l.node && <span className="text-muted">[{l.node}]</span>} {l.message}</div>)}{!x.logs.length && <span className="text-faint">No logs yet.</span>}</div></Panel>
        </div>
      </div>
    </>
  );
}
