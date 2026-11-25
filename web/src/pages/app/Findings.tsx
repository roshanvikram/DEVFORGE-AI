import { useMemo, useState, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Bug, Gauge, Hammer, Download, Search, ScanSearch, MessageSquare, History, ArrowLeft, FileSearch, FlaskConical, Layers } from "lucide-react";
import { get, patch, post, download } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { useRepo } from "../../lib/repo";
import { NeedsRepo } from "../../components/AppShell";
import { PageHeader, Panel, Button, Input, Select, EmptyState, ErrorState, LoadingBlock, SeverityBadge, StatusBadge, OriginBadge, Badge, CodeBlock, Textarea, Stat, Notice, DiffView, useDebounced, cx } from "../../components/ui";
import { JobPanel, useActiveJobs } from "../../components/jobs";
import { timeAgo, fmtDate, SEVERITIES, SEV_COLOR, titleCase } from "../../lib/format";

export const STATUSES = ["open", "triaged", "in_progress", "resolved", "ignored", "false_positive"];

/** Reusable issue explorer: filters, search, sort, group, bulk triage, export. */
export function FindingExplorer({ sources, scanKinds, repo, extraFilters }: { sources: string; scanKinds?: string[]; repo: any; extraFilters?: ReactNode }) {
  const { can } = useAuth();
  const qc = useQueryClient();
  const nav = useNavigate();
  const [f, setF] = useState({ q: "", severity: "", status: "open,triaged,in_progress", origin: "", category: "", tool: "", sort: "severity" });
  const [group, setGroup] = useState<"none" | "file" | "category" | "rule">("none");
  const [sel, setSel] = useState<Set<string>>(new Set());
  const dq = useDebounced(f.q, 250);
  const qs = new URLSearchParams({ repo: repo.id, source: sources, sort: f.sort, limit: "500", ...(dq && { q: dq }), ...(f.severity && { severity: f.severity }), ...(f.status && { status: f.status }), ...(f.origin && { origin: f.origin }), ...(f.category && { category: f.category }), ...(f.tool && { tool: f.tool }) }).toString();
  const q = useQuery({ queryKey: ["findings", qs], queryFn: () => get(`/findings?${qs}`) });
  const members = useQuery({ queryKey: ["members"], queryFn: () => get("/members"), enabled: can("findings.update") });
  const groups = useMemo(() => {
    const items = q.data?.items ?? [];
    if (group === "none") return [["", items]] as [string, any[]][];
    const m = new Map<string, any[]>();
    for (const it of items) { const k = group === "file" ? it.file_path ?? "(repository)" : group === "category" ? it.category : it.rule_id; (m.get(k) ?? m.set(k, []).get(k)!).push(it); }
    return [...m.entries()].sort((a, b) => b[1].length - a[1].length);
  }, [q.data, group]);
  const bulk = async (status: string) => {
    try { const r = await post("/findings/bulk", { ids: [...sel], status }); toast.success(`${r.updated} findings updated`); setSel(new Set()); qc.invalidateQueries({ queryKey: ["findings"] }); } catch (e: any) { toast.error(e.message); }
  };
  const runScan = async () => {
    try { await post(`/repositories/${repo.id}/analyze`, { kinds: scanKinds }); toast.success("Scan started"); } catch (e: any) { toast.error(e.message); }
  };
  const facets = q.data?.facets;
  const bySev = Object.fromEntries((facets?.severity ?? []).map((x: any) => [x.k, x.n]));
  return (
    <>
      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-5">
        {SEVERITIES.map((s) => (
          <button key={s} onClick={() => setF({ ...f, severity: f.severity === s ? "" : s })} className={cx("panel p-3 text-left transition", f.severity === s && "ring-2 ring-amber/50")}>
            <div className="flex items-center gap-1.5 text-[12px] capitalize text-muted"><span className="size-2 rounded-full" style={{ background: SEV_COLOR[s] }} />{s}</div>
            <div className="mt-1 text-[22px] font-semibold tabular-nums text-ink">{bySev[s] ?? 0}</div>
          </button>
        ))}
      </div>
      <Panel pad={false}>
        <div className="flex flex-wrap items-center gap-2 border-b border-line-2 p-3">
          <div className="relative min-w-[220px] flex-1"><Search className="absolute left-2.5 top-2.5 size-4 text-faint" /><Input className="pl-8" placeholder="Search title, file, rule, evidence…" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} /></div>
          <Select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}><option value="open,triaged,in_progress">Active</option><option value="">All statuses</option>{STATUSES.map((s) => <option key={s} value={s}>{titleCase(s)}</option>)}</Select>
          <Select value={f.origin} onChange={(e) => setF({ ...f, origin: e.target.value })}><option value="">All origins</option><option value="detected">Detected</option><option value="ai_hypothesis">AI hypotheses</option></Select>
          <Select value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}><option value="">All categories</option>{facets?.category?.map((c: any) => <option key={c.k} value={c.k}>{c.k} ({c.n})</option>)}</Select>
          <Select value={f.tool} onChange={(e) => setF({ ...f, tool: e.target.value })}><option value="">All tools</option>{facets?.tool?.map((c: any) => <option key={c.k} value={c.k}>{c.k} ({c.n})</option>)}</Select>
          <Select value={f.sort} onChange={(e) => setF({ ...f, sort: e.target.value })}><option value="severity">Sort: severity</option><option value="newest">Sort: newest</option><option value="oldest">Sort: oldest</option><option value="file">Sort: file</option></Select>
          <Select value={group} onChange={(e) => setGroup(e.target.value as any)}><option value="none">No grouping</option><option value="file">Group by file</option><option value="category">Group by category</option><option value="rule">Group by rule</option></Select>
          {extraFilters}
          <div className="ml-auto flex gap-2">
            <Button size="sm" icon={<Download className="size-3.5" />} onClick={() => download(`/findings/export?${qs}&format=csv`, "devforge-findings.csv").catch((e) => toast.error(e.message))}>CSV</Button>
            {scanKinds && can("analysis.run") && <Button size="sm" variant="primary" icon={<ScanSearch className="size-3.5" />} onClick={runScan}>Run scan</Button>}
          </div>
        </div>
        {sel.size > 0 && (
          <div className="flex items-center gap-2 border-b border-line-2 bg-amber-soft/30 px-4 py-2 text-[12.5px]">
            <span className="font-medium">{sel.size} selected</span>
            {["triaged", "in_progress", "resolved", "ignored", "false_positive"].map((s) => <Button key={s} size="sm" variant="ghost" onClick={() => bulk(s)}>{titleCase(s)}</Button>)}
            <button className="ml-auto text-muted" onClick={() => setSel(new Set())}>Clear</button>
          </div>
        )}
        {q.isLoading ? <div className="p-5"><LoadingBlock /></div> : q.error ? <div className="p-5"><ErrorState error={q.error} retry={q.refetch} /></div> : !q.data.items.length ? (
          <EmptyState icon={<Bug className="size-5" />} title="No findings match" description={f.status ? "No active findings for these filters. Try 'All statuses', or run a scan." : "Try adjusting the filters."} />
        ) : (
          <div>
            {groups.map(([g, items]) => (
              <div key={g}>
                {g && <div className="sticky top-0 border-b border-line-2 bg-ivory/80 px-4 py-1.5 font-mono text-[11.5px] text-ink-2 backdrop-blur">{g} <span className="text-faint">· {items.length}</span></div>}
                {items.map((it: any) => (
                  <div key={it.id} className="group flex items-center gap-3 border-b border-line-2 px-4 py-2.5 hover:bg-ivory/40">
                    {can("findings.update") && <input type="checkbox" className="accent-[#D99A28]" checked={sel.has(it.id)} onChange={(e) => { const n = new Set(sel); e.target.checked ? n.add(it.id) : n.delete(it.id); setSel(n); }} aria-label="Select finding" />}
                    <SeverityBadge severity={it.severity} />
                    <button onClick={() => nav(`/app/findings/${it.id}`)} className="min-w-0 flex-1 text-left">
                      <div className="truncate text-[13px] font-medium text-ink group-hover:text-amber-deep">{it.title}</div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11.5px] text-muted"><span className="font-mono">{it.file_path ?? "repository"}{it.line ? `:${it.line}` : ""}</span><span>·</span><span>{it.category}</span><span>·</span><span>{it.tool}</span></div>
                    </button>
                    {it.origin === "ai_hypothesis" && <OriginBadge origin={it.origin} />}
                    <span className="hidden md:block"><StatusBadge status={it.status} /></span>
                    <span className="hidden w-20 text-right text-[11.5px] text-faint lg:block">{timeAgo(it.first_seen_at)}</span>
                  </div>
                ))}
              </div>
            ))}
            {q.data.total > q.data.items.length && <div className="px-4 py-3 text-[12px] text-muted">Showing {q.data.items.length} of {q.data.total}. Refine filters or export CSV for the full list.</div>}
          </div>
        )}
      </Panel>
      {members.data && null}
    </>
  );
}

function ScanJobs({ repo }: { repo: any }) {
  const jobs = useActiveJobs((j) => j.payload?.repositoryId === repo.id);
  return jobs.length ? <div className="mb-4 space-y-2">{jobs.map((j: any) => <JobPanel key={j.id} jobId={j.id} compact />)}</div> : null;
}

export function BugsPage() {
  return (
    <NeedsRepo>{(repo) => (
      <>
        <PageHeader eyebrow="Bug Intelligence" icon={<Bug className="size-6 text-amber-deep" />} title="Bugs & defects" description="Type errors, broken imports, async misuse, swallowed exceptions, suspicious logic and dead code — from TypeScript, DevForge AST rules and (if installed) Ruff. AI hypotheses are labelled." actions={<Link to="/app/investigations?new=1"><Button icon={<FileSearch className="size-4" />}>Investigate an incident</Button></Link>} />
        <ScanJobs repo={repo} />
        <FindingExplorer repo={repo} sources="bug" scanKinds={["bug"]} />
      </>
    )}</NeedsRepo>
  );
}
export function PerformancePage() {
  return (
    <NeedsRepo>{(repo) => (
      <>
        <PageHeader eyebrow="Performance Lab" icon={<Gauge className="size-6 text-amber-deep" />} title="Performance analysis" description="Static evidence of performance risks: N+1 queries, sequential awaits in loops, quadratic iteration, blocking I/O in request paths, expensive cloning, large assets." />
        <Notice tone="info">Benchmarks are only shown when actually measured. DevForge does not run your code to time it during static analysis, so this page reports evidence and expected impact — not invented numbers.</Notice>
        <div className="h-4" />
        <ScanJobs repo={repo} />
        <FindingExplorer repo={repo} sources="performance" scanKinds={["performance"]} />
      </>
    )}</NeedsRepo>
  );
}
export function DebtPage() {
  return <NeedsRepo>{(repo) => <DebtView repo={repo} />}</NeedsRepo>;
}
function DebtView({ repo }: { repo: any }) {
  const a = useQuery({ queryKey: ["analytics-debt", repo.id], queryFn: () => get(`/analytics?repo=${repo.id}&days=90`) });
  const arch = useQuery({ queryKey: ["architecture", repo.id, repo.stats?.files], queryFn: () => get(`/repositories/${repo.id}/architecture`) });
  const f = useQuery({ queryKey: ["findings", "debt-summary", repo.id], queryFn: () => get(`/findings?repo=${repo.id}&source=debt&limit=1`) });
  const cats = f.data?.facets?.category ?? [];
  const total = f.data?.total ?? 0;
  const kloc = Math.max(1, (repo.stats?.loc ?? 0) / 1000);
  const resolved = (a.data?.resolution ?? []).find((r: any) => r.source === "debt");
  return (
    <>
      <PageHeader eyebrow="Technical Debt" icon={<Hammer className="size-6 text-amber-deep" />} title="Technical debt" description="Complexity, long functions, large files, duplication, deferred work (TODO/FIXME/HACK) and circular dependencies — measured on the current snapshot." />
      <ScanJobs repo={repo} />
      <div className="mb-4 grid gap-3 md:grid-cols-4">
        <Stat label="Debt items" value={total} />
        <Stat label="Debt density" value={(total / kloc).toFixed(1)} sub="items per KLOC" tone={total / kloc > 5 ? "danger" : total / kloc > 2 ? "amber" : "success"} />
        <Stat label="Circular dependencies" value={arch.data?.summary.cycles.length ?? "—"} />
        <Stat label="Resolved (all time)" value={resolved?.n ?? 0} sub={resolved?.avg_days != null ? `avg ${resolved.avg_days.toFixed(1)} days to resolve` : "no resolutions yet"} />
      </div>
      <div className="mb-4 grid gap-4 lg:grid-cols-2">
        <Panel title="Remediation roadmap" subtitle="Prioritised by category size and impact">
          {cats.length ? (
            <ol className="space-y-3">
              {[...cats].sort((x: any, y: any) => ({ "Poor architecture": 0, Complexity: 1, "Duplicate code": 2, "Long functions": 3, "Large files": 4 } as any)[x.k] - ({ "Poor architecture": 0, Complexity: 1, "Duplicate code": 2, "Long functions": 3, "Large files": 4 } as any)[y.k] || y.n - x.n).map((c: any, i: number) => (
                <li key={c.k} className="flex items-start gap-3"><span className="grid size-6 shrink-0 place-items-center rounded-full bg-amber-soft text-[11px] font-bold text-amber-deep">{i + 1}</span><div><div className="text-[13.5px] font-medium text-ink">{c.k} <span className="text-muted">({c.n})</span></div><div className="text-[12.5px] text-muted">{ROADMAP[c.k] ?? "Review and address items in this category."}</div></div></li>
              ))}
            </ol>
          ) : <EmptyState title="No debt recorded" description="Run a debt scan to measure." />}
        </Panel>
        <Panel title="Highest-risk files" subtitle="Complexity × dependents × findings" pad={false}>
          {(arch.data?.summary.highRisk ?? []).slice(0, 8).map((h: any) => (
            <Link key={h.path} to={`/app/repository?tab=explorer&file=${encodeURIComponent(h.path)}`} className="flex items-center gap-3 border-b border-line-2 px-5 py-2.5 text-[12.5px] last:border-0 hover:bg-ivory/50"><Layers className="size-3.5 text-faint" /><span className="min-w-0 flex-1 truncate font-mono">{h.path}</span><Badge>cx {h.complexity}</Badge><Badge>{h.fanIn} deps</Badge></Link>
          ))}
          {arch.data && !arch.data.summary.highRisk.length && <EmptyState title="No risk hotspots" />}
        </Panel>
      </div>
      <FindingExplorer repo={repo} sources="debt" scanKinds={["debt"]} />
    </>
  );
}
const ROADMAP: Record<string, string> = {
  "Poor architecture": "Break import cycles first — they block safe refactoring of everything else.",
  Complexity: "Split the most complex functions; add tests before refactoring.",
  "Duplicate code": "Extract duplicated blocks into shared helpers to stop fixes drifting.",
  "Long functions": "Decompose long functions into named steps.",
  "Large files": "Split oversized modules along responsibilities.",
  "Deferred work": "Triage TODO/FIXME/HACK comments into tracked issues.",
};

// ---------------------------------------------------------------- Finding detail
export function FindingDetailPage() {
  const { id } = useParams();
  const { can } = useAuth();
  const qc = useQueryClient();
  const nav = useNavigate();
  const q = useQuery({ queryKey: ["finding", id], queryFn: () => get(`/findings/${id}`) });
  const members = useQuery({ queryKey: ["members"], queryFn: () => get("/members") });
  const file = useQuery({ queryKey: ["file", q.data?.repository_id, q.data?.file_path], queryFn: () => get(`/repositories/${q.data.repository_id}/file?path=${encodeURIComponent(q.data.file_path)}`), enabled: !!q.data?.file_path && !!q.data?.line, retry: false });
  const [comment, setComment] = useState("");
  if (q.isLoading) return <LoadingBlock rows={8} />;
  if (q.error) return <ErrorState error={q.error} retry={q.refetch} />;
  const f = q.data;
  const update = async (body: any) => { try { await patch(`/findings/${f.id}`, body); qc.invalidateQueries({ queryKey: ["finding", id] }); qc.invalidateQueries({ queryKey: ["findings"] }); toast.success("Updated"); } catch (e: any) { toast.error(e.message); } };
  const lines = file.data?.content?.split("\n") ?? [];
  const start = Math.max(1, (f.line ?? 1) - 6);
  const ctx = lines.slice(start - 1, (f.end_line ?? f.line ?? 1) + 6).join("\n");
  return (
    <>
      <button onClick={() => nav(-1)} className="mb-4 flex items-center gap-1.5 text-[13px] text-muted hover:text-ink"><ArrowLeft className="size-4" />Back</button>
      <div className="mb-6 flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="mb-2 flex flex-wrap items-center gap-2"><SeverityBadge severity={f.severity} /><OriginBadge origin={f.origin} /><Badge>{f.category}</Badge><Badge>confidence: {f.confidence}</Badge><StatusBadge status={f.status} /></div>
          <h1 className="text-[22px] font-semibold tracking-[-0.02em] text-ink">{f.title}</h1>
          <div className="mt-1.5 font-mono text-[12.5px] text-muted">{f.repository} · {f.file_path ? <Link className="hover:text-amber-deep" to={`/app/repository?repo=${f.repository_id}&tab=explorer&file=${encodeURIComponent(f.file_path)}${f.line ? `&line=${f.line}` : ""}`}>{f.file_path}{f.line ? `:${f.line}` : ""}</Link> : "repository-wide"} · {f.tool} / {f.rule_id} · {f.id}</div>
        </div>
        <div className="flex flex-wrap gap-2">
          {f.file_path && f.line && can("tests.run") && <Link to={`/app/tests?new=1&path=${encodeURIComponent(f.file_path)}`}><Button icon={<FlaskConical className="size-4" />}>Generate test</Button></Link>}
          {can("investigations.create") && <Link to={`/app/investigations?new=1&finding=${f.id}`}><Button icon={<FileSearch className="size-4" />}>Investigate</Button></Link>}
        </div>
      </div>
      {f.origin === "ai_hypothesis" && <div className="mb-4"><Notice tone="info">This is an AI hypothesis, not a finding produced by a static analyzer. Verify it before acting.</Notice></div>}
      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        <div className="space-y-4">
          <Panel title="Evidence">
            <p className="text-[13.5px] text-ink-2">{f.evidence}</p>
            {f.line && ctx ? <div className="mt-3"><CodeBlock code={ctx} language={file.data?.file?.language} startLine={start} highlightLines={Array.from({ length: (f.end_line ?? f.line) - f.line + 1 }, (_, i) => f.line + i)} /></div> : f.snippet ? <div className="mt-3"><CodeBlock code={f.snippet} language="tsx" startLine={f.line ?? 1} /></div> : null}
          </Panel>
          <div className="grid gap-4 md:grid-cols-2">
            <Panel title="Explanation"><p className="text-[13.5px] leading-relaxed text-ink-2">{f.explanation}</p></Panel>
            <Panel title="Potential impact"><p className="text-[13.5px] leading-relaxed text-ink-2">{f.impact}</p></Panel>
          </div>
          <Panel title="Recommended fix"><p className="text-[13.5px] leading-relaxed text-ink-2">{f.recommendation}</p>{f.suggested_patch && <div className="mt-3"><DiffView diff={f.suggested_patch} /></div>}</Panel>
          <Panel title="Verification method"><p className="text-[13.5px] text-ink-2">{f.verification}</p></Panel>
          {(f.related?.length > 0 || f.relatedFiles?.length > 0) && (
            <Panel title="Related">
              {f.related?.map((r: string) => <div key={r} className="font-mono text-[12px] text-ink-2">{r.startsWith("http") ? <a href={r} target="_blank" rel="noreferrer noopener" className="text-amber-deep underline">{r}</a> : r}</div>)}
              {f.relatedFiles?.length > 0 && <div className="mt-2"><div className="mb-1 text-[12px] text-muted">Modules importing this file</div>{f.relatedFiles.map((p: string) => <div key={p} className="font-mono text-[12px]">{p}</div>)}</div>}
            </Panel>
          )}
          <Panel title={<span className="flex items-center gap-2"><MessageSquare className="size-4" />Discussion</span>}>
            {f.comments.map((c: any) => <div key={c.id} className="mb-3 rounded-xl bg-ivory/60 p-3 ring-1 ring-line"><div className="text-[12px] text-muted"><b className="text-ink">{c.author}</b> · {timeAgo(c.created_at)}</div><p className="mt-1 whitespace-pre-wrap text-[13px] text-ink-2">{c.body}</p></div>)}
            {can("comments.create") && <form onSubmit={async (e) => { e.preventDefault(); if (!comment.trim()) return; await post(`/findings/${f.id}/comments`, { body: comment }); setComment(""); qc.invalidateQueries({ queryKey: ["finding", id] }); }} className="space-y-2"><Textarea rows={3} placeholder="Add a comment…" value={comment} onChange={(e) => setComment(e.target.value)} /><div className="flex justify-end"><Button size="sm" type="submit">Comment</Button></div></form>}
          </Panel>
        </div>
        <div className="space-y-4">
          <Panel title="Triage">
            <div className="space-y-3">
              <label className="block text-[12px] text-muted">Status<Select className="mt-1 w-full" disabled={!can("findings.update")} value={f.status} onChange={(e) => update({ status: e.target.value })}>{STATUSES.map((s) => <option key={s} value={s}>{titleCase(s)}</option>)}</Select></label>
              <label className="block text-[12px] text-muted">Assignee<Select className="mt-1 w-full" disabled={!can("findings.update")} value={f.assignee_id ?? ""} onChange={(e) => update({ assignee_id: e.target.value || null })}><option value="">Unassigned</option>{members.data?.members.map((m: any) => <option key={m.user_id} value={m.user_id}>{m.name}</option>)}</Select></label>
              <div className="text-[12px] text-muted">First seen {fmtDate(f.first_seen_at)}<br />Last seen {fmtDate(f.last_seen_at)}{f.resolved_at && <><br />Resolved {fmtDate(f.resolved_at)}</>}</div>
            </div>
          </Panel>
          <Panel title={<span className="flex items-center gap-2"><History className="size-4" />History</span>}>
            <ol className="relative space-y-3 border-l border-line pl-4">
              {f.events.map((e: any, i: number) => <li key={i} className="text-[12.5px]"><span className="absolute -left-[5px] mt-1 size-2 rounded-full bg-amber" /><div className="font-medium capitalize text-ink">{e.kind.replace(/_/g, " ")}{e.data?.to ? ` → ${String(e.data.to).replace(/_/g, " ")}` : ""}</div><div className="text-muted">{e.actor ?? "system"} · {timeAgo(e.created_at)}{e.data?.reason ? ` · ${e.data.reason}` : ""}</div></li>)}
            </ol>
          </Panel>
        </div>
      </div>
    </>
  );
}
