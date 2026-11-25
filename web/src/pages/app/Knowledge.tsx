import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { BookOpen, Plus, Upload, Search, Trash2, FileText, Download, Activity as ActivityIcon, FileDown } from "lucide-react";
import { get, post, del, download } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { useRepo } from "../../lib/repo";
import { PageHeader, Panel, Button, Modal, Field, Input, Textarea, Select, EmptyState, LoadingBlock, Badge, Markdown, Table, useDebounced, cx } from "../../components/ui";
import { timeAgo, fmtDate, titleCase } from "../../lib/format";

export function KnowledgePage() {
  const [params, setParams] = useSearchParams();
  const { can } = useAuth();
  const { repo } = useRepo();
  const qc = useQueryClient();
  const [q, setQ] = useState("");
  const dq = useDebounced(q, 250);
  const list = useQuery({ queryKey: ["kb", dq], queryFn: () => get(`/kb${dq ? `?q=${encodeURIComponent(dq)}` : ""}`) });
  const docId = params.get("doc");
  const doc = useQuery({ queryKey: ["kb-doc", docId], queryFn: () => get(`/kb/${docId}`), enabled: !!docId });
  const [newOpen, setNewOpen] = useState(false);
  const [form, setForm] = useState({ title: "", content: "" });
  const onFile = (f: File) => { if (f.size > 2_000_000) return toast.error("File too large (max 2 MB)"); f.text().then((t) => setForm({ title: f.name, content: t })); setNewOpen(true); };
  return (
    <>
      <PageHeader eyebrow="Knowledge Base" icon={<BookOpen className="size-6 text-amber-deep" />} title="Knowledge base" description="Repository documentation, generated architecture docs, agent-written docs and your own notes — full-text searchable. For questions about code, use Repository Intelligence → Ask."
        actions={can("kb.write") && <>
          {repo && <Button icon={<FileDown className="size-4" />} onClick={async () => { try { const r = await post("/kb/import-repo-docs", { repositoryId: repo.id }); toast.success(`Imported ${r.imported} Markdown files from ${repo.name}`); qc.invalidateQueries({ queryKey: ["kb"] }); } catch (e: any) { toast.error(e.message); } }}>Import repo docs</Button>}
          <label className="inline-flex h-9 cursor-pointer items-center gap-2 rounded-[10px] border border-line bg-white px-4 text-[13.5px] font-medium hover:border-silver"><Upload className="size-4" />Upload<input type="file" accept=".md,.markdown,.txt" className="hidden" onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])} /></label>
          <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => { setForm({ title: "", content: "" }); setNewOpen(true); }}>New note</Button>
        </>} />
      <div className="grid gap-4 lg:grid-cols-[340px_1fr]">
        <Panel pad={false}>
          <div className="border-b border-line-2 p-3"><div className="relative"><Search className="absolute left-2.5 top-2.5 size-4 text-faint" /><Input className="pl-8" placeholder="Search knowledge…" value={q} onChange={(e) => setQ(e.target.value)} /></div></div>
          <div className="scroll-thin max-h-[70vh] overflow-y-auto">
            {list.isLoading ? <div className="p-4"><LoadingBlock /></div> : !list.data?.length ? <EmptyState icon={<BookOpen className="size-5" />} title={dq ? "No matches" : "Knowledge base is empty"} description={dq ? undefined : "Import repository docs, upload Markdown, or run the Documentation Agent."} /> : list.data.map((d: any) => (
              <button key={d.id} onClick={() => setParams({ doc: d.id })} className={cx("w-full border-b border-line-2 px-4 py-3 text-left last:border-0 hover:bg-ivory/50", docId === d.id && "bg-amber-soft/30")}>
                <div className="flex items-center gap-2"><FileText className="size-3.5 text-faint" /><span className="truncate text-[13px] font-medium text-ink">{d.title}</span></div>
                <div className="mt-1 flex items-center gap-2 text-[11px] text-muted"><Badge>{titleCase(d.kind)}</Badge>{timeAgo(d.updated_at)}</div>
                {d.snippet && <div className="mt-1 line-clamp-2 text-[12px] text-ink-2">{d.snippet}</div>}
              </button>
            ))}
          </div>
        </Panel>
        <Panel title={doc.data?.title ?? "Document"} actions={doc.data && can("kb.write") && <Button size="sm" variant="danger" icon={<Trash2 className="size-3.5" />} onClick={async () => { if (!confirm("Delete this document?")) return; await del(`/kb/${doc.data.id}`); setParams({}); qc.invalidateQueries({ queryKey: ["kb"] }); }}>Delete</Button>}>
          {!docId ? <EmptyState title="Select a document" /> : doc.isLoading ? <LoadingBlock /> : doc.data ? <><div className="mb-3 text-[12px] text-muted">{titleCase(doc.data.kind)}{doc.data.source_path && <> · <span className="font-mono">{doc.data.source_path}</span></>} · updated {fmtDate(doc.data.updated_at)}</div><Markdown>{doc.data.content}</Markdown></> : null}
        </Panel>
      </div>
      <Modal open={newOpen} onClose={() => setNewOpen(false)} width={760} title="New knowledge document" footer={<><Button variant="ghost" onClick={() => setNewOpen(false)}>Cancel</Button><Button variant="primary" disabled={!form.title || !form.content} onClick={async () => { try { const r = await post("/kb", { ...form, repositoryId: repo?.id, kind: "note" }); setNewOpen(false); qc.invalidateQueries({ queryKey: ["kb"] }); setParams({ doc: r.id }); } catch (e: any) { toast.error(e.message); } }}>Save</Button></>}>
        <div className="space-y-4"><Field label="Title"><Input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></Field><Field label="Content (Markdown)"><Textarea rows={14} className="font-mono text-[12.5px]" value={form.content} onChange={(e) => setForm({ ...form, content: e.target.value })} /></Field></div>
      </Modal>
    </>
  );
}

export function ReportsPage() {
  const [params, setParams] = useSearchParams();
  const { can } = useAuth();
  const { repos, repo } = useRepo();
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ["reports"], queryFn: () => get("/reports") });
  const id = params.get("id");
  const r = useQuery({ queryKey: ["report", id], queryFn: () => get(`/reports/${id}`), enabled: !!id });
  const [kind, setKind] = useState("executive");
  const [repoId, setRepoId] = useState(repo?.id ?? "");
  const [busy, setBusy] = useState(false);
  return (
    <>
      <PageHeader eyebrow="Reports" icon={<FileText className="size-6 text-amber-deep" />} title="Reports" description="Generated from recorded scan data, workflow executions and agent output. Download as Markdown."
        actions={can("reports.create") && repos?.length ? <><Select value={repoId || repo?.id} onChange={(e) => setRepoId(e.target.value)}>{repos.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select><Select value={kind} onChange={(e) => setKind(e.target.value)}>{["executive", "security", "quality", "debt", "dependencies"].map((k) => <option key={k} value={k}>{titleCase(k)} report</option>)}</Select><Button variant="primary" loading={busy} onClick={async () => { setBusy(true); try { const x = await post("/reports", { repositoryId: repoId || repo?.id, kind }); qc.invalidateQueries({ queryKey: ["reports"] }); setParams({ id: x.id }); } catch (e: any) { toast.error(e.message); } finally { setBusy(false); } }}>Generate</Button></> : null} />
      <div className="grid gap-4 lg:grid-cols-[340px_1fr]">
        <Panel pad={false}>
          {list.isLoading ? <div className="p-4"><LoadingBlock /></div> : !list.data?.length ? <EmptyState icon={<FileText className="size-5" />} title="No reports yet" /> : list.data.map((x: any) => (
            <button key={x.id} onClick={() => setParams({ id: x.id })} className={cx("w-full border-b border-line-2 px-4 py-3 text-left last:border-0 hover:bg-ivory/50", id === x.id && "bg-amber-soft/30")}>
              <div className="truncate text-[13px] font-medium text-ink">{x.title}</div><div className="mt-1 flex items-center gap-2 text-[11px] text-muted"><Badge>{x.kind}</Badge>{x.author ?? "workflow"} · {timeAgo(x.created_at)}</div>
            </button>
          ))}
        </Panel>
        <Panel title={r.data?.title ?? "Report"} actions={r.data && <Button size="sm" icon={<Download className="size-3.5" />} onClick={() => download(`/reports/${r.data.id}?download=1`, `${r.data.title}.md`)}>Download .md</Button>}>
          {!id ? <EmptyState title="Select or generate a report" /> : r.isLoading ? <LoadingBlock /> : r.data && <Markdown>{r.data.content}</Markdown>}
        </Panel>
      </div>
    </>
  );
}

export function ActivityPage() {
  const [f, setF] = useState({ q: "", action: "", entity: "", from: "", to: "" });
  const dq = useDebounced(f.q, 250);
  const qs = new URLSearchParams(Object.entries({ ...f, q: dq }).filter(([, v]) => v) as any).toString();
  const q = useQuery({ queryKey: ["activity", qs], queryFn: () => get(`/activity?${qs}&limit=200`) });
  const [sel, setSel] = useState<any>(null);
  return (
    <>
      <PageHeader eyebrow="Activity & Audit" icon={<ActivityIcon className="size-6 text-amber-deep" />} title="Activity" description="Every user action, scan, agent run, review, test, investigation, workflow execution, approval and configuration change in this workspace." />
      <Panel pad={false}>
        <div className="flex flex-wrap gap-2 border-b border-line-2 p-3">
          <div className="relative flex-1"><Search className="absolute left-2.5 top-2.5 size-4 text-faint" /><Input className="pl-8" placeholder="Search actions, entities, data…" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} /></div>
          <Select value={f.action} onChange={(e) => setF({ ...f, action: e.target.value })}><option value="">All actions</option>{q.data?.actions?.filter(Boolean).map((a: string) => <option key={a} value={a}>{a}</option>)}</Select>
          <Input type="date" className="w-40" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} aria-label="From date" />
          <Input type="date" className="w-40" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} aria-label="To date" />
        </div>
        {q.isLoading ? <div className="p-5"><LoadingBlock /></div> : !q.data?.items?.length ? <EmptyState title="No activity matches" /> : (
          <Table head={["When", "Actor", "Action", "Entity", ""]}>
            {q.data.items.map((a: any) => (
              <tr key={a.id} className="hover:bg-ivory/50">
                <td className="whitespace-nowrap px-4 py-2 text-[12px] text-muted" title={a.created_at}>{fmtDate(a.created_at)}</td>
                <td className="px-4 py-2 text-[12.5px]">{a.actor ?? <span className="capitalize text-muted">{a.actor_type}</span>}{a.actor_type !== "user" && a.actor && <Badge className="ml-1">{a.actor_type}</Badge>}</td>
                <td className="px-4 py-2 font-mono text-[12px] text-ink">{a.action}</td>
                <td className="px-4 py-2 text-[12px] text-muted">{a.entity_type ? `${a.entity_type} ${a.entity_id ?? ""}` : "—"}</td>
                <td className="px-4 py-2 text-right"><button className="text-[12px] text-amber-deep" onClick={() => setSel(a)}>Details</button></td>
              </tr>
            ))}
          </Table>
        )}
        {q.data && <div className="border-t border-line-2 px-4 py-2 text-[12px] text-muted">{q.data.items.length} of {q.data.total} events</div>}
      </Panel>
      <Modal open={!!sel} onClose={() => setSel(null)} title="Audit event">
        {sel && <div className="space-y-2 text-[13px]"><div><span className="text-muted">Action:</span> <span className="font-mono">{sel.action}</span></div><div><span className="text-muted">Actor:</span> {sel.actor ?? sel.actor_type}</div><div><span className="text-muted">Time:</span> {sel.created_at}</div>{sel.ip && <div><span className="text-muted">IP:</span> {sel.ip}</div>}<div><span className="text-muted">Entity:</span> {sel.entity_type} {sel.entity_id}</div><pre className="mt-2 rounded-lg bg-ivory p-3 font-mono text-[11.5px]">{JSON.stringify(sel.data, null, 2)}</pre></div>}
      </Modal>
    </>
  );
}
