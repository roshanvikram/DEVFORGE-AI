import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { ChevronRight, File, Folder, FolderOpen, Search, Send, Sparkles, ScanSearch, Code2, Route, Database, Box, GitCommit, ListChecks, FlaskConical } from "lucide-react";
import { get, post } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { NeedsRepo } from "../../components/AppShell";
import { PageHeader, Panel, Tabs, Input, Button, CodeBlock, EmptyState, ErrorState, LoadingBlock, Badge, SeverityBadge, StatusBadge, Markdown, Modal, Toggle, Notice, useDebounced, cx, Table } from "../../components/ui";
import { JobPanel, useActiveJobs } from "../../components/jobs";
import { num, timeAgo, LANG_COLOR, titleCase } from "../../lib/format";

type Tab = "explorer" | "search" | "symbols" | "ask" | "commits" | "scans";

export default function Repository() {
  return <NeedsRepo>{(repo) => <RepoView repo={repo} />}</NeedsRepo>;
}

function RepoView({ repo }: { repo: any }) {
  const [params, setParams] = useSearchParams();
  const [tab, setTab] = useState<Tab>((params.get("tab") as Tab) ?? "explorer");
  const [analyze, setAnalyze] = useState(params.get("action") === "analyze");
  const { can } = useAuth();
  const jobs = useActiveJobs((j) => j.payload?.repositoryId === repo.id);
  const st = repo.stats ?? {};
  return (
    <>
      <PageHeader eyebrow="Repository Intelligence" title={repo.name}
        description={<span className="flex flex-wrap items-center gap-2">{num(st.files)} files · {num(st.loc)} LOC · {num(Object.values(st.symbols ?? {}).reduce((a: number, b: any) => a + b, 0))} symbols · {num(st.symbols?.route ?? 0)} routes · {num(st.symbols?.model ?? 0)} models {repo.frameworks.slice(0, 6).map((f: string) => <Badge key={f}>{f}</Badge>)}</span>}
        actions={can("analysis.run") && <Button variant="primary" icon={<ScanSearch className="size-4" />} onClick={() => setAnalyze(true)}>Run analysis</Button>} />
      {st.unsupportedLanguages?.length > 0 && <div className="mb-4"><Notice tone="info">Full AST analysis covers TypeScript, JavaScript and Python. {st.unsupportedLanguages.join(", ")} files are indexed for search, metrics and pattern rules only.</Notice></div>}
      {jobs.length > 0 && <div className="mb-4 space-y-2">{jobs.map((j: any) => <JobPanel key={j.id} jobId={j.id} compact />)}</div>}
      <Tabs className="mb-5" value={tab} onChange={(t) => { setTab(t); setParams((p) => { p.set("tab", t); return p; }); }} tabs={[{ id: "explorer", label: "Explorer" }, { id: "search", label: "Code search" }, { id: "symbols", label: "Symbols & APIs" }, { id: "ask", label: "Ask the repository" }, { id: "commits", label: "Commits" }, { id: "scans", label: "Scan history" }]} />
      {tab === "explorer" && <Explorer repo={repo} />}
      {tab === "search" && <CodeSearch repo={repo} />}
      {tab === "symbols" && <Symbols repo={repo} />}
      {tab === "ask" && <Ask repo={repo} />}
      {tab === "commits" && <Commits repo={repo} />}
      {tab === "scans" && <Scans repo={repo} />}
      <AnalyzeModal repo={repo} open={analyze} onClose={() => { setAnalyze(false); setParams((p) => { p.delete("action"); return p; }); }} />
    </>
  );
}

function AnalyzeModal({ repo, open, onClose }: { repo: any; open: boolean; onClose: () => void }) {
  const [kinds, setKinds] = useState<string[]>(["bug", "security", "dependency", "performance", "debt"]);
  const [busy, setBusy] = useState(false);
  const labels: Record<string, string> = { bug: "Bug analysis (AST rules, TypeScript, Ruff)", security: "Security & secrets (rules, Semgrep, Gitleaks, Trivy)", dependency: "Dependencies (OSV.dev, npm audit, registries)", performance: "Performance (static evidence)", debt: "Technical debt (complexity, duplication, cycles)" };
  return (
    <Modal open={open} onClose={onClose} title={`Analyse ${repo.name}`} footer={<>
      <Button variant="ghost" onClick={onClose}>Cancel</Button>
      <Button onClick={async () => { setBusy(true); try { await post(`/repositories/${repo.id}/refresh`, { preset: "full" }); toast.success("Pulling latest and re-indexing"); onClose(); } catch (e: any) { toast.error(e.message); } finally { setBusy(false); } }}>Pull latest & re-index</Button>
      <Button variant="primary" loading={busy} disabled={!kinds.length} onClick={async () => { setBusy(true); try { await post(`/repositories/${repo.id}/analyze`, { kinds }); toast.success("Analysis started"); onClose(); } catch (e: any) { toast.error(e.message); } finally { setBusy(false); } }}>Run selected</Button>
    </>}>
      <div className="space-y-3">{Object.entries(labels).map(([k, l]) => <div key={k}><Toggle checked={kinds.includes(k)} onChange={(v) => setKinds(v ? [...kinds, k] : kinds.filter((x) => x !== k))} label={l} /></div>)}</div>
      <p className="mt-4 text-[12px] text-muted">Analysis runs against the indexed snapshot. Findings no longer detected are auto-resolved; tools that are not installed never resolve their old findings.</p>
    </Modal>
  );
}

interface TreeNode { name: string; path: string; children: Map<string, TreeNode>; file?: any }
function buildTree(files: any[]): TreeNode {
  const root: TreeNode = { name: "", path: "", children: new Map() };
  for (const f of files) {
    const parts = f.path.split("/");
    let cur = root;
    parts.forEach((p: string, i: number) => {
      if (!cur.children.has(p)) cur.children.set(p, { name: p, path: parts.slice(0, i + 1).join("/"), children: new Map() });
      cur = cur.children.get(p)!;
      if (i === parts.length - 1) cur.file = f;
    });
  }
  return root;
}
function TreeView({ node, depth, selected, onSelect, open, toggle }: { node: TreeNode; depth: number; selected: string | null; onSelect: (p: string) => void; open: Set<string>; toggle: (p: string) => void }) {
  const kids = [...node.children.values()].sort((a, b) => (!!a.file === !!b.file ? a.name.localeCompare(b.name) : a.file ? 1 : -1));
  return (
    <>
      {kids.map((k) => k.file ? (
        <button key={k.path} onClick={() => onSelect(k.path)} className={cx("flex w-full items-center gap-1.5 rounded-md py-1 pr-2 text-left text-[12.5px]", selected === k.path ? "bg-amber-soft/60 text-ink" : "text-ink-2 hover:bg-ivory")} style={{ paddingLeft: depth * 12 + 8 }}>
          <File className="size-3.5 shrink-0" style={{ color: LANG_COLOR[k.file.language] ?? "#A3A199" }} /><span className="truncate">{k.name}</span>
          {k.file.findings > 0 && <span className="ml-auto rounded-full bg-amber-soft px-1.5 text-[10px] font-semibold text-amber-deep">{k.file.findings}</span>}
        </button>
      ) : (
        <div key={k.path}>
          <button onClick={() => toggle(k.path)} className="flex w-full items-center gap-1.5 rounded-md py-1 pr-2 text-left text-[12.5px] text-ink hover:bg-ivory" style={{ paddingLeft: depth * 12 + 4 }}>
            <ChevronRight className={cx("size-3 text-faint transition", open.has(k.path) && "rotate-90")} />{open.has(k.path) ? <FolderOpen className="size-3.5 text-amber-deep" /> : <Folder className="size-3.5 text-muted" />}<span className="truncate">{k.name}</span>
          </button>
          {open.has(k.path) && <TreeView node={k} depth={depth + 1} selected={selected} onSelect={onSelect} open={open} toggle={toggle} />}
        </div>
      ))}
    </>
  );
}

function Explorer({ repo }: { repo: any }) {
  const [params, setParams] = useSearchParams();
  const tree = useQuery({ queryKey: ["tree", repo.id, repo.stats?.files], queryFn: () => get(`/repositories/${repo.id}/tree`) });
  const [filter, setFilter] = useState("");
  const selected = params.get("file");
  const line = Number(params.get("line") ?? 0) || null;
  const [open, setOpen] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (selected) setOpen((o) => new Set([...o, ...selected.split("/").slice(0, -1).map((_, i, a) => a.slice(0, i + 1).join("/"))]));
  }, [selected]);
  const files = useMemo(() => (tree.data ?? []).filter((f: any) => !filter || f.path.toLowerCase().includes(filter.toLowerCase())), [tree.data, filter]);
  const root = useMemo(() => buildTree(files), [files]);
  useEffect(() => { if (filter) setOpen(new Set(files.flatMap((f: any) => f.path.split("/").slice(0, -1).map((_: string, i: number, a: string[]) => a.slice(0, i + 1).join("/"))))); }, [filter]);
  const select = (p: string, l?: number) => setParams((x) => { x.set("file", p); if (l) x.set("line", String(l)); else x.delete("line"); x.set("tab", "explorer"); return x; });
  return (
    <div className="grid gap-4 lg:grid-cols-[280px_1fr]">
      <Panel pad={false} className="h-[calc(100vh-260px)] min-h-[420px] overflow-hidden">
        <div className="border-b border-line-2 p-2"><Input placeholder="Filter files…" value={filter} onChange={(e) => setFilter(e.target.value)} /></div>
        <div className="scroll-thin h-[calc(100%-52px)] overflow-y-auto p-1.5">
          {tree.isLoading ? <LoadingBlock /> : tree.error ? <ErrorState error={tree.error} /> : <TreeView node={root} depth={0} selected={selected} onSelect={(p) => select(p)} open={open} toggle={(p) => setOpen((o) => { const n = new Set(o); n.has(p) ? n.delete(p) : n.add(p); return n; })} />}
        </div>
      </Panel>
      {selected ? <FileView repo={repo} path={selected} line={line} onNavigate={select} /> : <Panel><EmptyState icon={<Code2 className="size-5" />} title="Select a file" description="Browse the indexed snapshot. Files with open findings show a count." /></Panel>}
    </div>
  );
}

function FileView({ repo, path, line, onNavigate }: { repo: any; path: string; line: number | null; onNavigate: (p: string, l?: number) => void }) {
  const q = useQuery({ queryKey: ["file", repo.id, path], queryFn: () => get(`/repositories/${repo.id}/file?path=${encodeURIComponent(path)}`) });
  const [refs, setRefs] = useState<string | null>(null);
  const refQ = useQuery({ queryKey: ["refs", repo.id, refs], queryFn: () => get(`/repositories/${repo.id}/references?symbol=${encodeURIComponent(refs!)}`), enabled: !!refs });
  useEffect(() => { if (line && q.data) setTimeout(() => document.getElementById(`L${line}`)?.scrollIntoView({ block: "center" }), 50); }, [line, q.data]);
  if (q.isLoading) return <Panel><LoadingBlock rows={10} /></Panel>;
  if (q.error) return <Panel><ErrorState error={q.error} retry={q.refetch} /></Panel>;
  const d = q.data;
  const findingLines = d.findings.map((f: any) => f.line).filter(Boolean);
  return (
    <div className="grid min-w-0 gap-4 xl:grid-cols-[1fr_300px]">
      <Panel pad={false} className="min-w-0" title={<span className="font-mono text-[13px]">{path}</span>} subtitle={`${d.file.language ?? "text"} · ${num(d.file.loc)} LOC · complexity ${d.file.complexity}${d.file.is_test ? " · test file" : ""}`}
        actions={<Link to={`/app/tests?new=1&path=${encodeURIComponent(path)}`}><Button size="sm" icon={<FlaskConical className="size-3.5" />}>Generate tests</Button></Link>}>
        <div className="p-3"><CodeBlock code={d.content} language={d.file.language ?? "text"} highlightLines={[...(line ? [line] : []), ...findingLines]} maxHeight={640} /></div>
      </Panel>
      <div className="space-y-4">
        <Panel title="Findings" pad={false}>
          {d.findings.length ? d.findings.map((f: any) => (
            <Link key={f.id} to={`/app/findings/${f.id}`} className="block border-b border-line-2 px-4 py-2.5 last:border-0 hover:bg-ivory/50">
              <div className="flex items-center gap-2"><SeverityBadge severity={f.severity} /><span className="text-[11px] text-faint">L{f.line ?? "—"}</span></div>
              <div className="mt-1 text-[12.5px] text-ink">{f.title}</div>
            </Link>
          )) : <div className="px-4 py-4 text-[12.5px] text-muted">No open findings in this file.</div>}
        </Panel>
        <Panel title="Symbols" pad={false}>
          <div className="scroll-thin max-h-72 overflow-y-auto">
            {d.symbols.map((s: any) => (
              <div key={s.id} className="group flex items-center gap-2 border-b border-line-2 px-4 py-2 text-[12.5px] last:border-0">
                <Badge className="w-[70px] justify-center">{s.kind}</Badge>
                <button className="truncate text-left font-mono text-[12px] text-ink hover:text-amber-deep" onClick={() => onNavigate(path, s.line)}>{s.name}</button>
                {["function", "method", "component", "class"].includes(s.kind) && <button className="ml-auto text-[11px] text-faint opacity-0 hover:text-amber-deep group-hover:opacity-100" onClick={() => setRefs(s.name)}>refs</button>}
              </div>
            ))}
            {!d.symbols.length && <div className="px-4 py-4 text-[12.5px] text-muted">No symbols extracted.</div>}
          </div>
        </Panel>
        <Panel title="Imports" pad={false}>
          <div className="scroll-thin max-h-52 overflow-y-auto px-4 py-2">{d.imports.map((i: any, k: number) => <div key={k} className="truncate py-0.5 text-[12px]">{i.internal ? <button className="font-mono text-ink hover:text-amber-deep" onClick={() => onNavigate(i.target)}>{i.target}</button> : <span className="font-mono text-muted">{i.target}</span>}</div>)}{!d.imports.length && <div className="text-[12.5px] text-muted">None</div>}</div>
        </Panel>
        <Panel title={`Imported by (${d.importedBy.length})`} pad={false}>
          <div className="scroll-thin max-h-52 overflow-y-auto px-4 py-2">{d.importedBy.map((i: any) => <button key={i.path} className="block truncate py-0.5 font-mono text-[12px] text-ink hover:text-amber-deep" onClick={() => onNavigate(i.path)}>{i.path}</button>)}{!d.importedBy.length && <div className="text-[12.5px] text-muted">No internal importers</div>}</div>
        </Panel>
      </div>
      <Modal open={!!refs} onClose={() => setRefs(null)} title={<>References to <span className="font-mono">{refs}</span></>} width={680}>
        {refQ.isLoading ? <LoadingBlock /> : (
          <div className="space-y-4">
            <div><div className="mb-2 text-[12px] font-semibold uppercase tracking-[0.08em] text-muted">Resolved callers ({refQ.data?.callers.length ?? 0})</div>{refQ.data?.callers.map((c: any, i: number) => <button key={i} onClick={() => { setRefs(null); onNavigate(c.path, c.line); }} className="block w-full truncate rounded-lg px-2 py-1 text-left font-mono text-[12px] hover:bg-ivory">{c.path}:{c.line} <span className="text-muted">in {c.caller ?? "module scope"}</span></button>)}</div>
            <div><div className="mb-2 text-[12px] font-semibold uppercase tracking-[0.08em] text-muted">Text occurrences</div>{refQ.data?.textual.map((h: any) => h.matches.slice(0, 3).map((m: any) => <button key={h.path + m.line} onClick={() => { setRefs(null); onNavigate(h.path, m.line); }} className="block w-full truncate rounded-lg px-2 py-1 text-left font-mono text-[12px] hover:bg-ivory">{h.path}:{m.line} <span className="text-muted">{m.text.trim()}</span></button>))}</div>
          </div>
        )}
      </Modal>
    </div>
  );
}

function CodeSearch({ repo }: { repo: any }) {
  const [q, setQ] = useState("");
  const [exact, setExact] = useState(false);
  const dq = useDebounced(q, 300);
  const [, setParams] = useSearchParams();
  const r = useQuery({ queryKey: ["search", repo.id, dq, exact], queryFn: () => get(`/repositories/${repo.id}/search?q=${encodeURIComponent(dq)}${exact ? "&exact=1" : ""}`), enabled: dq.trim().length >= 2 });
  const open = (p: string, l: number) => setParams((x) => { x.set("tab", "explorer"); x.set("file", p); x.set("line", String(l)); return x; });
  return (
    <Panel>
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1"><Search className="absolute left-3 top-2.5 size-4 text-faint" /><Input className="pl-9" autoFocus placeholder="Search code — identifiers, strings, concepts (BM25 ranked)" value={q} onChange={(e) => setQ(e.target.value)} /></div>
        <Toggle checked={exact} onChange={setExact} label="Exact match" />
      </div>
      <div className="mt-5">
        {dq.trim().length < 2 ? <EmptyState icon={<Search className="size-5" />} title="Search the indexed code" description="Ranking uses SQLite FTS5 BM25 with camelCase/snake_case splitting. Symbol names are matched separately." /> : r.isLoading ? <LoadingBlock /> : (
          <div className="space-y-4">
            {r.data?.symbols?.length > 0 && <div className="flex flex-wrap gap-2">{r.data.symbols.slice(0, 12).map((s: any) => <button key={s.id} onClick={() => open(s.path, s.line)} className="rounded-lg bg-ivory px-2.5 py-1 font-mono text-[12px] ring-1 ring-line hover:ring-amber"><span className="text-muted">{s.kind} </span>{s.name}</button>)}</div>}
            {r.data?.code.map((h: any) => (
              <div key={h.path} className="rounded-xl border border-line">
                <div className="border-b border-line-2 bg-ivory/50 px-4 py-2 font-mono text-[12.5px] text-ink">{h.path}</div>
                {h.matches.map((m: any) => <button key={m.line} onClick={() => open(h.path, m.line)} className="flex w-full gap-3 px-4 py-1 text-left font-mono text-[12px] hover:bg-amber-soft/30"><span className="w-10 shrink-0 text-right text-faint">{m.line}</span><span className="truncate whitespace-pre text-ink-2">{m.text}</span></button>)}
              </div>
            ))}
            {!r.data?.code.length && !r.data?.symbols?.length && <EmptyState title="No matches" />}
          </div>
        )}
      </div>
    </Panel>
  );
}

function Symbols({ repo }: { repo: any }) {
  const [kind, setKind] = useState("route");
  const q = useQuery({ queryKey: ["symbols", repo.id, kind], queryFn: () => get(`/repositories/${repo.id}/symbols?kind=${kind}`) });
  const [, setParams] = useSearchParams();
  const kinds = [["route", "API routes", Route], ["model", "Data models", Database], ["class", "Classes", Box], ["function", "Functions", Code2], ["component", "Components", Sparkles], ["interface", "Interfaces", ListChecks]] as const;
  return (
    <Panel pad={false}>
      <div className="flex flex-wrap gap-2 border-b border-line-2 p-3">{kinds.map(([k, l, I]) => <button key={k} onClick={() => setKind(k)} className={cx("flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12.5px]", kind === k ? "bg-ink text-white" : "bg-white text-ink-2 ring-1 ring-line")}><I className="size-3.5" />{l}<span className="opacity-60">{repo.stats?.symbols?.[k] ?? 0}</span></button>)}</div>
      {q.isLoading ? <div className="p-5"><LoadingBlock /></div> : !q.data?.length ? <EmptyState title={`No ${kind}s detected`} description={kind === "route" ? "Route discovery supports Express-style routers, Next.js route files, FastAPI and Flask decorators." : undefined} /> : (
        <Table head={["Name", "Location", kind === "route" ? "Method / framework" : "Complexity", "Exported"]}>
          {q.data.map((s: any) => (
            <tr key={s.id} className="hover:bg-ivory/50">
              <td className="px-4 py-2 font-mono text-[12.5px] text-ink">{s.parent ? <span className="text-muted">{s.parent}.</span> : null}{s.name}</td>
              <td className="px-4 py-2"><button className="font-mono text-[12px] text-muted hover:text-amber-deep" onClick={() => setParams((x) => { x.set("tab", "explorer"); x.set("file", s.path); x.set("line", String(s.line)); return x; })}>{s.path}:{s.line}</button></td>
              <td className="px-4 py-2 text-[12.5px]">{kind === "route" ? <span className="flex gap-1"><Badge tone="amber">{s.meta?.method}</Badge><Badge>{s.meta?.framework}</Badge></span> : kind === "model" ? <Badge>{s.meta?.orm ?? "class"}</Badge> : <span className={cx("tabular-nums", s.complexity > 15 && "font-semibold text-danger")}>{s.complexity}</span>}</td>
              <td className="px-4 py-2 text-[12.5px] text-muted">{s.exported ? "yes" : "—"}</td>
            </tr>
          ))}
        </Table>
      )}
    </Panel>
  );
}

function Ask({ repo }: { repo: any }) {
  const hist = useQuery({ queryKey: ["chat", repo.id], queryFn: () => get(`/repositories/${repo.id}/chat`) });
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [local, setLocal] = useState<any[]>([]);
  const [, setParams] = useSearchParams();
  const msgs = [...(hist.data ?? []), ...local];
  const ask = async () => {
    if (!q.trim()) return;
    const question = q;
    setQ("");
    setBusy(true);
    setLocal((l) => [...l, { role: "user", content: question, id: Math.random() }]);
    try {
      const r = await post(`/repositories/${repo.id}/chat`, { question });
      setLocal((l) => [...l, { role: "assistant", content: r.answer ?? r.note, citations: r.citations, id: Math.random(), retrievalOnly: !r.aiConfigured }]);
    } catch (e: any) {
      setLocal((l) => [...l, { role: "assistant", content: `**Error:** ${e.message}`, id: Math.random() }]);
    } finally { setBusy(false); }
  };
  return (
    <Panel pad={false} className="flex h-[calc(100vh-260px)] min-h-[480px] flex-col">
      <div className="scroll-thin flex-1 space-y-4 overflow-y-auto p-5">
        {!msgs.length && <EmptyState icon={<Sparkles className="size-5" />} title="Ask about this repository" description="Answers are grounded in retrieved code excerpts and cite file:line. Without an AI provider you still get the most relevant code locations." />}
        {msgs.map((m: any) => (
          <div key={m.id} className={cx("max-w-3xl", m.role === "user" ? "ml-auto" : "")}>
            {m.role === "user" ? <div className="rounded-2xl rounded-br-md bg-ink px-4 py-2.5 text-[13.5px] text-white">{m.content}</div> : (
              <div className="rounded-2xl rounded-bl-md border border-line bg-white px-4 py-3">
                {m.retrievalOnly && <Badge tone="info" className="mb-2">Retrieval only — no AI configured</Badge>}
                <Markdown>{m.content}</Markdown>
                {m.citations?.length > 0 && <div className="mt-3 flex flex-wrap gap-1.5 border-t border-line-2 pt-3">{m.citations.map((c: any, i: number) => <button key={i} onClick={() => setParams((x) => { x.set("tab", "explorer"); x.set("file", c.path); x.set("line", String(c.startLine)); return x; })} className="rounded-md bg-ivory px-2 py-0.5 font-mono text-[11px] text-ink-2 ring-1 ring-line hover:ring-amber">{c.path}:{c.startLine}-{c.endLine}</button>)}</div>}
              </div>
            )}
          </div>
        ))}
        {busy && <div className="flex items-center gap-2 text-[13px] text-muted"><span className="size-2 animate-pulse rounded-full bg-amber" />Retrieving context and thinking…</div>}
      </div>
      <form className="flex gap-2 border-t border-line-2 p-3" onSubmit={(e) => { e.preventDefault(); ask(); }}>
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="e.g. Where is authentication handled? How are orders persisted?" />
        <Button variant="primary" loading={busy} icon={<Send className="size-4" />} type="submit">Ask</Button>
      </form>
    </Panel>
  );
}

function Commits({ repo }: { repo: any }) {
  const q = useQuery({ queryKey: ["commits", repo.id], queryFn: () => get(`/repositories/${repo.id}/commits`) });
  if (q.isLoading) return <LoadingBlock />;
  if (!q.data?.length) return <Panel><EmptyState icon={<GitCommit className="size-5" />} title="No git history" description="This repository was imported without git history." /></Panel>;
  return (
    <Panel pad={false}>
      <Table head={["Commit", "Message", "Author", "Changes", ""]}>
        {q.data.map((c: any) => (
          <tr key={c.sha} className="hover:bg-ivory/50">
            <td className="px-4 py-2.5 font-mono text-[12px] text-amber-deep">{c.sha.slice(0, 8)}</td>
            <td className="max-w-md truncate px-4 py-2.5 text-ink">{c.subject}</td>
            <td className="px-4 py-2.5 text-muted">{c.author} · {timeAgo(c.date)}</td>
            <td className="px-4 py-2.5 text-[12px]"><span className="text-success">+{c.insertions}</span> <span className="text-danger">−{c.deletions}</span> <span className="text-faint">{c.files} files</span></td>
            <td className="px-4 py-2.5 text-right"><Link to={`/app/reviews?new=1&sha=${c.sha}`}><Button size="sm">Review</Button></Link></td>
          </tr>
        ))}
      </Table>
    </Panel>
  );
}

function Scans({ repo }: { repo: any }) {
  const q = useQuery({ queryKey: ["scans", repo.id], queryFn: () => get(`/repositories/${repo.id}/scans`) });
  if (q.isLoading) return <LoadingBlock />;
  if (!q.data?.length) return <Panel><EmptyState title="No scans recorded" /></Panel>;
  return (
    <Panel pad={false}>
      <Table head={["Scan", "Status", "Findings", "Tools", "Finished"]}>
        {q.data.map((s: any) => (
          <tr key={s.id}>
            <td className="px-4 py-2.5 font-medium capitalize text-ink">{s.kind}</td>
            <td className="px-4 py-2.5"><StatusBadge status={s.status} />{s.error && <div className="mt-1 text-[11.5px] text-danger">{s.error}</div>}</td>
            <td className="px-4 py-2.5 text-[12.5px]">{s.summary?.findings ?? "—"} {s.summary?.created ? <span className="text-amber-deep">(+{s.summary.created} new)</span> : null} {s.summary?.autoResolved ? <span className="text-success">({s.summary.autoResolved} resolved)</span> : null}</td>
            <td className="px-4 py-2.5"><div className="flex flex-wrap gap-1">{Object.entries(s.tools).map(([k, v]: any) => <span key={k} title={v.note}><Badge tone={v.status === "ok" ? "success" : v.status === "failed" ? "danger" : "neutral"}>{k}: {titleCase(v.status)}</Badge></span>)}</div></td>
            <td className="px-4 py-2.5 text-[12.5px] text-muted">{timeAgo(s.finished_at)}</td>
          </tr>
        ))}
      </Table>
    </Panel>
  );
}
