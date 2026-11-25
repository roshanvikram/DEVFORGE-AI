import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { ReactFlow, Background, Controls, MiniMap, useReactFlow, ReactFlowProvider, Handle, Position, type Node, type Edge } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { forceSimulation, forceLink, forceManyBody, forceCenter, forceCollide, forceX, forceY } from "d3-force";
import { Search, Maximize2, Minimize2, Route as RouteIcon, AlertTriangle, Boxes, X } from "lucide-react";
import { get } from "../../lib/api";
import { NeedsRepo } from "../../components/AppShell";
import { PageHeader, Panel, Tabs, Input, Button, EmptyState, ErrorState, LoadingBlock, Badge, Toggle, Select, Markdown, cx } from "../../components/ui";
import { SceneBoundary, webglSupported } from "../../components/three/Scene";
import { SEV_COLOR, num } from "../../lib/format";

const RepoGraph3D = lazy(() => import("../../components/three/RepoGraph3D"));

export default function Architecture() {
  return <NeedsRepo>{(repo) => <ArchView repo={repo} />}</NeedsRepo>;
}

function ArchView({ repo }: { repo: any }) {
  const q = useQuery({ queryKey: ["architecture", repo.id, repo.stats?.files], queryFn: () => get(`/repositories/${repo.id}/architecture`) });
  const [tab, setTab] = useState<"graph" | "3d" | "report">("graph");
  if (q.isLoading) return <LoadingBlock rows={8} />;
  if (q.error) return <ErrorState error={q.error} retry={q.refetch} />;
  const d = q.data;
  return (
    <>
      <PageHeader eyebrow="Architecture Intelligence" title="System architecture" description={`${num(d.summary.files)} code files · ${num(d.summary.importEdges)} internal import edges · ${d.summary.cycles.length} circular dependencies · ${d.external.length} external packages`} />
      <Tabs className="mb-4" value={tab} onChange={setTab} tabs={[{ id: "graph", label: "Dependency graph" }, { id: "3d", label: "3D repository map" }, { id: "report", label: "Architecture report" }]} />
      {tab === "graph" && <ReactFlowProvider><Graph data={d} repoId={repo.id} /></ReactFlowProvider>}
      {tab === "3d" && (
        <Panel pad={false} className="h-[620px] overflow-hidden">
          {webglSupported() ? <SceneBoundary fallback={<EmptyState title="3D view unavailable" description="WebGL failed to initialise; use the 2D dependency graph." />}><Suspense fallback={<div className="p-6"><LoadingBlock /></div>}><RepoGraph3D nodes={d.nodes} edges={d.edges} /></Suspense></SceneBoundary> : <EmptyState title="WebGL not supported" description="Use the 2D dependency graph instead." />}
        </Panel>
      )}
      {tab === "report" && <Report repo={repo} d={d} />}
    </>
  );
}

function moduleOf(path: string, depth: number) {
  const parts = path.split("/");
  return parts.length <= 1 ? "(root)" : parts.slice(0, Math.min(depth, parts.length - 1)).join("/");
}

function FileNode({ data, selected }: any) {
  return (
    <div className={cx("rounded-xl border bg-white px-3 py-2 shadow-[0_1px_2px_rgba(36,37,33,.06)] transition", selected ? "border-amber ring-4 ring-amber-soft/70" : data.dim ? "border-line opacity-30" : data.hl ? "border-amber" : "border-line")} style={{ minWidth: data.module ? 150 : 120 }}>
      <Handle type="target" position={Position.Left} className="!size-1.5 !border-0 !bg-silver" />
      <div className="flex items-center gap-2">
        {data.module ? <Boxes className="size-3.5 text-amber-deep" /> : <span className="size-2 rounded-full" style={{ background: data.worst ? SEV_COLOR[data.worst] : "#C9C6BD" }} />}
        <span className="max-w-[180px] truncate font-mono text-[11.5px] text-ink">{data.label}</span>
      </div>
      <div className="mt-1 flex gap-1.5 text-[10px] text-muted">
        {data.module ? <span>{data.count} files · {num(data.loc)} LOC</span> : <span>{data.loc} LOC</span>}
        {data.findings > 0 && <span className="text-amber-deep">{data.findings} findings</span>}
        {data.cycle && <span className="text-danger">cycle</span>}
      </div>
      <Handle type="source" position={Position.Right} className="!size-1.5 !border-0 !bg-silver" />
    </div>
  );
}
const nodeTypes = { file: FileNode };

function Graph({ data, repoId }: { data: any; repoId: string }) {
  const rf = useReactFlow();
  const [mode, setMode] = useState<"modules" | "files">(data.nodes.length > 120 ? "modules" : "files");
  const [depth, setDepth] = useState(2);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [hideTests, setHideTests] = useState(true);
  const [onlyCycles, setOnlyCycles] = useState(false);
  const [lang, setLang] = useState("all");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [pathFrom, setPathFrom] = useState<string | null>(null);
  const [pathNodes, setPathNodes] = useState<string[] | null>(null);

  const cycleFiles = useMemo(() => new Set<string>(data.summary.cycles.flatMap((c: any) => c.path)), [data]);
  const byId = useMemo(() => new Map(data.nodes.map((n: any) => [n.id, n])), [data]);
  const langs = useMemo(() => [...new Set(data.nodes.map((n: any) => n.language))], [data]);

  const { nodes, edges } = useMemo(() => {
    let files = data.nodes.filter((n: any) => (!hideTests || !n.is_test) && (lang === "all" || n.language === lang) && (!onlyCycles || cycleFiles.has(n.path)));
    const visibleKey = (f: any) => (mode === "files" || expanded.has(moduleOf(f.path, depth)) ? f.id : `mod:${moduleOf(f.path, depth)}`);
    const groups = new Map<string, any>();
    for (const f of files) {
      const k = visibleKey(f);
      if (!groups.has(k)) groups.set(k, k.startsWith("mod:") ? { id: k, module: true, label: k.slice(4), count: 0, loc: 0, findings: 0, files: [] } : { id: k, label: f.path.split("/").slice(-2).join("/"), path: f.path, loc: f.loc, findings: f.findings, worst: f.worst, cycle: cycleFiles.has(f.path) });
      const g = groups.get(k);
      if (g.module) { g.count++; g.loc += f.loc; g.findings += f.findings; g.files.push(f.path); if (cycleFiles.has(f.path)) g.cycle = true; }
    }
    const fileKey = new Map(files.map((f: any) => [f.id, visibleKey(f)]));
    const agg = new Map<string, number>();
    for (const e of data.edges) {
      const s = fileKey.get(e.source);
      const t = fileKey.get(e.target);
      if (!s || !t || s === t) continue;
      agg.set(`${s}|${t}`, (agg.get(`${s}|${t}`) ?? 0) + e.weight);
    }
    // Force layout
    const simNodes = [...groups.values()].map((g) => ({ id: g.id, x: Math.random() * 800, y: Math.random() * 600 }));
    const simLinks = [...agg.keys()].map((k) => ({ source: k.split("|")[0], target: k.split("|")[1] }));
    const sim = forceSimulation(simNodes as any).force("link", forceLink(simLinks as any).id((d: any) => d.id).distance(140).strength(0.4)).force("charge", forceManyBody().strength(-520)).force("center", forceCenter(0, 0)).force("collide", forceCollide(95)).force("x", forceX(0).strength(0.03)).force("y", forceY(0).strength(0.05)).stop();
    for (let i = 0; i < 260; i++) sim.tick();
    const pos = new Map(simNodes.map((n: any) => [n.id, { x: n.x, y: n.y }]));
    const term = search.trim().toLowerCase();
    const pathSet = new Set(pathNodes ?? []);
    const neighbors = new Set<string>();
    if (selected) for (const k of agg.keys()) { const [s, t] = k.split("|"); if (s === selected) neighbors.add(t); if (t === selected) neighbors.add(s); }
    const ns: Node[] = [...groups.values()].map((g) => {
      const hit = term && (g.label.toLowerCase().includes(term) || g.path?.toLowerCase().includes(term));
      const dim = (!!term && !hit) || (!!pathNodes && !pathSet.has(g.path ?? "")) || (!!selected && selected !== g.id && !neighbors.has(g.id));
      return { id: g.id, type: "file", position: pos.get(g.id)!, data: { ...g, hl: hit || pathSet.has(g.path ?? ""), dim } };
    });
    const es: Edge[] = [...agg.entries()].map(([k, w]) => {
      const [s, t] = k.split("|");
      const onPath = pathNodes && pathNodes.some((p, i) => i < pathNodes.length - 1 && byId.get(s as any) && (byId.get(s as any) as any)?.path === p && (byId.get(t as any) as any)?.path === pathNodes[i + 1]);
      const touch = selected && (s === selected || t === selected);
      return { id: k, source: s, target: t, animated: !!onPath || !!touch, style: { stroke: onPath ? "#D99A28" : touch ? "#B97E17" : "#D6D2C8", strokeWidth: onPath ? 2.5 : Math.min(4, 0.8 + Math.log2(1 + w)) }, markerEnd: undefined };
    });
    return { nodes: ns, edges: es };
  }, [data, mode, depth, expanded, hideTests, lang, onlyCycles, search, selected, pathNodes, cycleFiles, byId]);

  useEffect(() => { setTimeout(() => rf.fitView({ padding: 0.15, duration: 400 }), 50); }, [mode, depth, hideTests, lang, onlyCycles]);
  const sel = selected ? nodes.find((n) => n.id === selected)?.data as any : null;
  return (
    <div className="grid gap-4 xl:grid-cols-[1fr_320px]">
      <Panel pad={false} className="relative h-[640px] overflow-hidden">
        <div className="absolute left-3 right-3 top-3 z-10 flex flex-wrap items-center gap-2">
          <div className="glass flex items-center gap-1 rounded-xl p-1">{(["modules", "files"] as const).map((m) => <button key={m} onClick={() => { setMode(m); setSelected(null); }} className={cx("rounded-lg px-2.5 py-1 text-[12px] capitalize", mode === m ? "bg-white text-ink shadow-sm" : "text-muted")}>{m}</button>)}</div>
          {mode === "modules" && <Select className="h-8 text-[12px]" value={depth} onChange={(e) => setDepth(Number(e.target.value))}><option value={1}>Depth 1</option><option value={2}>Depth 2</option><option value={3}>Depth 3</option></Select>}
          <Select className="h-8 text-[12px]" value={lang} onChange={(e) => setLang(e.target.value)}><option value="all">All languages</option>{langs.map((l: any) => <option key={l}>{l}</option>)}</Select>
          <div className="glass flex items-center gap-3 rounded-xl px-3 py-1.5"><Toggle checked={hideTests} onChange={setHideTests} label="Hide tests" /><Toggle checked={onlyCycles} onChange={setOnlyCycles} label="Cycles only" /></div>
          <div className="relative ml-auto w-56"><Search className="absolute left-2.5 top-2 size-3.5 text-faint" /><Input className="h-8 pl-8 text-[12px]" placeholder="Search & highlight" value={search} onChange={(e) => setSearch(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { const n = nodes.find((x: any) => x.data.hl); if (n) { setSelected(n.id); rf.setCenter(n.position.x + 80, n.position.y + 20, { zoom: 1.2, duration: 500 }); } } }} /></div>
        </div>
        {pathNodes && <div className="absolute bottom-3 left-3 z-10"><Badge tone="amber" className="py-1">Path: {pathNodes.length} hops <button onClick={() => { setPathNodes(null); setPathFrom(null); }}><X className="size-3" /></button></Badge></div>}
        {nodes.length ? (
          <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} fitView minZoom={0.1} maxZoom={2.5} onNodeClick={(_, n) => setSelected(n.id === selected ? null : n.id)} onPaneClick={() => setSelected(null)} nodesConnectable={false} proOptions={{ hideAttribution: true }}>
            <Background color="#E7E3DA" gap={22} size={1.2} />
            <Controls showInteractive={false} position="bottom-right" />
            <MiniMap pannable zoomable nodeColor={(n: any) => (n.data.worst ? SEV_COLOR[n.data.worst] : n.data.module ? "#D99A28" : "#C9C6BD")} maskColor="rgba(247,246,242,.7)" position="top-right" style={{ marginTop: 56 }} />
          </ReactFlow>
        ) : <EmptyState title="No nodes match the filters" />}
      </Panel>
      <div className="space-y-4">
        <Panel title={sel ? (sel.module ? "Module" : "File") : "Details"}>
          {!sel ? <p className="text-[13px] text-muted">Select a node to inspect it. Click a module's <b>Expand</b> to see its files. Pick two files to highlight the import path between them.</p> : (
            <div className="space-y-3 text-[13px]">
              <div className="break-all font-mono text-[12.5px] text-ink">{sel.path ?? sel.label}</div>
              <div className="flex flex-wrap gap-1.5">{sel.module ? <Badge>{sel.count} files</Badge> : null}<Badge>{num(sel.loc)} LOC</Badge>{sel.findings > 0 && <Badge tone="amber">{sel.findings} findings</Badge>}{sel.cycle && <Badge tone="danger">in a cycle</Badge>}</div>
              <div className="flex flex-wrap gap-2">
                {sel.module ? (
                  <Button size="sm" icon={expanded.has(sel.label) ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />} onClick={() => { const n = new Set(expanded); n.has(sel.label) ? n.delete(sel.label) : n.add(sel.label); setExpanded(n); setSelected(null); }}>{expanded.has(sel.label) ? "Collapse" : "Expand"}</Button>
                ) : (
                  <>
                    <Link to={`/app/repository?tab=explorer&file=${encodeURIComponent(sel.path)}`}><Button size="sm">Open file</Button></Link>
                    {!pathFrom ? <Button size="sm" icon={<RouteIcon className="size-3.5" />} onClick={() => setPathFrom(sel.path)}>Path from here</Button>
                      : <Button size="sm" variant="amber" icon={<RouteIcon className="size-3.5" />} onClick={async () => { const r = await get(`/repositories/${repoId}/path?from=${encodeURIComponent(pathFrom)}&to=${encodeURIComponent(sel.path)}`); setPathNodes(r.path ?? []); setPathFrom(null); }}>Path to here</Button>}
                  </>
                )}
              </div>
              {pathNodes && pathNodes.length === 0 && <p className="text-[12px] text-muted">No import path exists between these files.</p>}
              {pathNodes && pathNodes.length > 0 && <ol className="space-y-1 font-mono text-[11.5px]">{pathNodes.map((p, i) => <li key={p}>{i + 1}. {p}</li>)}</ol>}
            </div>
          )}
        </Panel>
        <Panel title="Circular dependencies" pad={false}>
          <div className="scroll-thin max-h-56 overflow-y-auto">
            {data.summary.cycles.length ? data.summary.cycles.map((c: any, i: number) => <div key={i} className="border-b border-line-2 px-4 py-2 font-mono text-[11px] text-ink-2 last:border-0"><AlertTriangle className="mr-1 inline size-3 text-danger" />{c.path.map((p: string) => p.split("/").pop()).join(" → ")}</div>) : <div className="px-4 py-3 text-[12.5px] text-muted">No import cycles detected.</div>}
          </div>
        </Panel>
        <Panel title="External packages" pad={false}>
          <div className="scroll-thin flex max-h-48 flex-wrap gap-1.5 overflow-y-auto p-4">{data.external.map((e: any) => <Badge key={e.name}>{e.name} <span className="text-faint">{e.files}</span></Badge>)}</div>
        </Panel>
      </div>
    </div>
  );
}

function Report({ repo, d }: { repo: any; d: any }) {
  const s = d.summary;
  const md = `# Architecture report — ${repo.name}

_Derived from the indexed snapshot${repo.commit ? ` at \`${repo.commit.slice(0, 8)}\`` : ""}._

## Overview
- **${num(s.files)}** code files, **${num(s.importEdges)}** internal import edges
- Frameworks: ${repo.frameworks.join(", ") || "none detected"}
- API routes: ${repo.stats?.symbols?.route ?? 0} · Data models: ${repo.stats?.symbols?.model ?? 0} · Classes: ${repo.stats?.symbols?.class ?? 0}

## Modules (by size)
| Module | Files | LOC |
|---|---|---|
${s.modules.slice(0, 20).map((m: any) => `| \`${m.name}\` | ${m.files} | ${num(m.loc)} |`).join("\n")}

## Most depended-on files (hotspots)
| File | Imported by | Imports | Complexity | Open findings |
|---|---|---|---|---|
${s.hotspots.slice(0, 12).map((h: any) => `| \`${h.path}\` | ${h.fanIn} | ${h.fanOut} | ${h.complexity} | ${h.findings} |`).join("\n")}

## High-risk components
Ranked by complexity × dependents × open findings.

${s.highRisk.slice(0, 10).map((h: any, i: number) => `${i + 1}. \`${h.path}\` — complexity ${h.complexity}, ${h.fanIn} dependents, ${h.findings} findings`).join("\n") || "None."}

## Circular dependencies (${s.cycles.length})
${s.cycles.slice(0, 15).map((c: any) => `- ${c.path.map((p: string) => `\`${p}\``).join(" → ")}`).join("\n") || "None detected."}

## Isolated components (${s.isolated.length})
Source files with no internal imports in either direction (possible entry points, scripts or dead code):

${s.isolated.slice(0, 25).map((p: string) => `- \`${p}\``).join("\n") || "None."}

## External dependencies (most used)
${d.external.slice(0, 20).map((e: any) => `- \`${e.name}\` — imported in ${e.files} files`).join("\n")}
`;
  return <Panel><Markdown>{md}</Markdown></Panel>;
}
