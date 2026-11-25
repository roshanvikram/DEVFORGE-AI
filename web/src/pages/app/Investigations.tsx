import { useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { FileSearch, Plus, ArrowLeft, RotateCcw, CheckCircle2, CircleDashed, XCircle, MinusCircle, GitCommit, AlertTriangle, Layers, FlaskConical } from "lucide-react";
import { get, post } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { useRepo } from "../../lib/repo";
import { NeedsRepo } from "../../components/AppShell";
import { PageHeader, Panel, Button, Modal, Field, Input, Textarea, EmptyState, ErrorState, LoadingBlock, StatusBadge, Badge, Notice, DiffView, Markdown, Tabs, Table, cx } from "../../components/ui";
import { JobPanel } from "../../components/jobs";
import { timeAgo, fmtDate } from "../../lib/format";

export function InvestigationsPage() {
  const [params, setParams] = useSearchParams();
  const { can } = useAuth();
  const q = useQuery({ queryKey: ["investigations"], queryFn: () => get("/investigations") });
  return (
    <NeedsRepo>{(repo) => (
      <>
        <PageHeader eyebrow="Root Cause Investigation Lab" icon={<FileSearch className="size-6 text-amber-deep" />} title="Investigations" description="Paste an error, stack trace, logs or failing tests. DevForge maps the incident to your code, walks call chains and dependencies, collects evidence and ranks root-cause hypotheses."
          actions={can("investigations.create") && <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setParams({ new: "1" })}>New investigation</Button>} />
        <Panel pad={false}>
          {q.isLoading ? <div className="p-5"><LoadingBlock /></div> : !q.data?.length ? (
            <EmptyState icon={<FileSearch className="size-5" />} title="No investigations yet" description="Start with an incident you're debugging right now." action={can("investigations.create") && <Button variant="primary" onClick={() => setParams({ new: "1" })}>New investigation</Button>} />
          ) : (
            <Table head={["Investigation", "Repository", "Status", "Hypotheses", "AI", "Created"]}>
              {q.data.map((i: any) => (
                <tr key={i.id} className="hover:bg-ivory/50">
                  <td className="px-4 py-3"><Link to={`/app/investigations/${i.id}`} className="font-medium text-ink hover:text-amber-deep">{i.title}</Link></td>
                  <td className="px-4 py-3 text-muted">{i.repository}</td>
                  <td className="px-4 py-3"><StatusBadge status={i.status} /></td>
                  <td className="px-4 py-3 tabular-nums">{i.hypotheses ?? 0}</td>
                  <td className="px-4 py-3">{i.ai_used ? <Badge tone="info">used</Badge> : <span className="text-faint">—</span>}</td>
                  <td className="px-4 py-3 text-muted">{timeAgo(i.created_at)}</td>
                </tr>
              ))}
            </Table>
          )}
        </Panel>
        <NewInvestigation repo={repo} open={params.get("new") === "1"} onClose={() => setParams({})} findingId={params.get("finding")} />
      </>
    )}</NeedsRepo>
  );
}

function NewInvestigation({ repo, open, onClose, findingId }: { repo: any; open: boolean; onClose: () => void; findingId: string | null }) {
  const nav = useNavigate();
  const finding = useQuery({ queryKey: ["finding", findingId], queryFn: () => get(`/findings/${findingId}`), enabled: !!findingId && open });
  const [f, setF] = useState({ title: "", error: "", stackTrace: "", logs: "", failingTests: "", description: "" });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const pre = finding.data && !f.title ? { title: `Investigate: ${finding.data.title}`, description: `${finding.data.evidence}\nLocation: ${finding.data.file_path}:${finding.data.line ?? ""}` } : {};
  const val = { ...f, ...pre };
  return (
    <Modal open={open} onClose={onClose} width={720} title={`New investigation · ${repo.name}`} footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={async () => { setBusy(true); setErr(null); try { const r = await post("/investigations", { repositoryId: repo.id, ...Object.fromEntries(Object.entries(val).filter(([, v]) => v)) }); onClose(); nav(`/app/investigations/${r.id}`); } catch (e: any) { setErr(e.message); } finally { setBusy(false); } }}>Start investigation</Button></>}>
      <div className="space-y-4">
        {err && <Notice tone="danger">{err}</Notice>}
        <Field label="Title"><Input value={val.title} onChange={(e) => setF({ ...val, title: e.target.value })} placeholder="Checkout returns 500 for guest users" /></Field>
        <Field label="Error message"><Input value={val.error} onChange={(e) => setF({ ...val, error: e.target.value })} placeholder="TypeError: Cannot read properties of undefined (reading 'id')" /></Field>
        <Field label="Stack trace"><Textarea rows={6} className="font-mono text-[12px]" value={val.stackTrace} onChange={(e) => setF({ ...val, stackTrace: e.target.value })} placeholder={"at resolveCustomer (src/orders/checkout.ts:42:18)\nat async handler (src/api/routes.ts:88:5)"} /></Field>
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Logs (optional)"><Textarea rows={4} className="font-mono text-[12px]" value={val.logs} onChange={(e) => setF({ ...val, logs: e.target.value })} /></Field>
          <Field label="Failing tests (optional)"><Textarea rows={4} className="font-mono text-[12px]" value={val.failingTests} onChange={(e) => setF({ ...val, failingTests: e.target.value })} placeholder="one test name per line" /></Field>
        </div>
        <Field label="Description"><Textarea rows={3} value={val.description} onChange={(e) => setF({ ...val, description: e.target.value })} placeholder="What happened, when, and what changed recently?" /></Field>
      </div>
    </Modal>
  );
}

const StepIcon = ({ s }: { s: string }) => s === "done" ? <CheckCircle2 className="size-4 text-success" /> : s === "failed" ? <XCircle className="size-4 text-danger" /> : s === "skipped" ? <MinusCircle className="size-4 text-faint" /> : <CircleDashed className="size-4 animate-spin text-amber" />;

export function InvestigationDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const { can } = useAuth();
  const [tab, setTab] = useState<"hypotheses" | "evidence" | "code" | "impact" | "fix">("hypotheses");
  const q = useQuery({ queryKey: ["investigation", id], queryFn: () => get(`/investigations/${id}`), refetchInterval: (qq) => (["queued", "running"].includes((qq.state.data as any)?.status) ? 1500 : false) });
  if (q.isLoading) return <LoadingBlock rows={8} />;
  if (q.error) return <ErrorState error={q.error} retry={q.refetch} />;
  const d = q.data;
  const ev = d.evidence ?? {};
  const running = ["queued", "running"].includes(d.status);
  return (
    <>
      <button onClick={() => nav("/app/investigations")} className="mb-4 flex items-center gap-1.5 text-[13px] text-muted hover:text-ink"><ArrowLeft className="size-4" />Investigations</button>
      <PageHeader eyebrow={`Investigation · ${d.repository}`} title={d.title} description={<span className="flex items-center gap-2"><StatusBadge status={d.status} />{d.ai_used ? <Badge tone="info">AI-assisted</Badge> : <Badge>Rule-based</Badge>}<span>Opened {fmtDate(d.created_at)}</span></span>}
        actions={can("investigations.create") && !running && <Button icon={<RotateCcw className="size-4" />} onClick={async () => { await post(`/investigations/${d.id}/rerun`); qc.invalidateQueries({ queryKey: ["investigation", id] }); toast.success("Re-running"); }}>Re-run</Button>} />
      {d.error && <div className="mb-4"><Notice tone="danger">{d.error}</Notice></div>}
      {running && d.job_id && <div className="mb-4"><JobPanel jobId={d.job_id} compact /></div>}
      <div className="grid gap-4 xl:grid-cols-[320px_1fr]">
        <div className="space-y-4">
          <Panel title="Incident overview">
            <div className="space-y-2 text-[13px]">
              {d.parsed?.errorType && <div><span className="text-muted">Type</span> <Badge tone="danger">{d.parsed.errorType}</Badge></div>}
              {d.parsed?.message && <div className="break-words font-mono text-[12px] text-ink">{d.parsed.message}</div>}
              <div className="text-muted">{d.parsed?.frames?.length ?? 0} frames · {d.parsed?.frames?.filter((f: any) => f.repoPath).length ?? 0} mapped to repository</div>
              {d.input?.description && <p className="text-[12.5px] text-ink-2">{d.input.description}</p>}
            </div>
          </Panel>
          <Panel title="Pipeline timeline">
            <ol className="space-y-3">
              {(d.timeline ?? []).map((t: any, i: number) => <li key={i} className="flex gap-2.5"><StepIcon s={t.status} /><div className="min-w-0"><div className="text-[12.5px] font-medium text-ink">{t.step}</div><div className="break-words text-[11.5px] text-muted">{t.detail}</div></div></li>)}
              {!d.timeline?.length && <li className="text-[12.5px] text-muted">Queued…</li>}
            </ol>
          </Panel>
          <Panel title="Affected files" pad={false}>
            {(d.affected ?? []).map((a: any) => <Link key={a.path} to={`/app/repository?repo=${d.repository_id}&tab=explorer&file=${encodeURIComponent(a.path)}${a.lines?.[0] ? `&line=${a.lines[0]}` : ""}`} className="block border-b border-line-2 px-4 py-2 last:border-0 hover:bg-ivory/50"><div className="truncate font-mono text-[12px] text-ink">{a.path}</div><div className="text-[11px] text-muted">{a.reasons.join(", ")}</div></Link>)}
            {!d.affected?.length && <div className="px-4 py-3 text-[12.5px] text-muted">None identified yet.</div>}
          </Panel>
        </div>
        <div>
          <Tabs className="mb-4" value={tab} onChange={setTab} tabs={[{ id: "hypotheses", label: "Hypotheses", count: d.hypotheses?.length }, { id: "evidence", label: "Evidence", count: ev.items?.length }, { id: "code", label: "Relevant code" }, { id: "impact", label: "Call chains & impact" }, { id: "fix", label: "Fix & verification" }]} />
          {tab === "hypotheses" && (
            <div className="space-y-3">
              {(d.hypotheses ?? []).map((h: any, i: number) => (
                <Panel key={h.id}>
                  <div className="flex items-start gap-3">
                    <span className={cx("grid size-7 shrink-0 place-items-center rounded-full text-[12px] font-bold", i === 0 ? "bg-amber text-white" : "bg-ivory text-ink-2 ring-1 ring-line")}>{i + 1}</span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2"><h3 className="text-[14.5px] font-semibold text-ink">{h.title}</h3>{h.origin === "ai_hypothesis" ? <Badge tone="info">AI hypothesis</Badge> : h.origin === "finding" ? <Badge tone="amber">From detected finding</Badge> : <Badge tone="success">Rule-based</Badge>}</div>
                      <p className="mt-1.5 text-[13px] leading-relaxed text-ink-2">{h.explanation}</p>
                      <div className="mt-3 flex items-center gap-3"><div className="h-1.5 w-40 rounded-full bg-ivory ring-1 ring-line"><div className="h-full rounded-full bg-amber" style={{ width: `${Math.round(h.confidence * 100)}%` }} /></div><span className="text-[12px] tabular-nums text-muted">{Math.round(h.confidence * 100)}% confidence</span></div>
                      {h.evidence?.length > 0 && <ul className="mt-3 list-disc space-y-1 pl-5 text-[12.5px] text-ink-2">{h.evidence.map((e: string, k: number) => <li key={k}>{e}</li>)}</ul>}
                      <div className="mt-2 text-[11.5px] text-muted">Verification: {h.verification}</div>
                    </div>
                  </div>
                </Panel>
              ))}
              {!d.hypotheses?.length && <Panel><EmptyState title={running ? "Analysing…" : "No hypotheses"} description={running ? undefined : "The available evidence was insufficient. Add a stack trace or failing test and re-run."} /></Panel>}
            </div>
          )}
          {tab === "evidence" && (
            <Panel pad={false}>
              {(ev.items ?? []).map((e: any, i: number) => (
                <div key={i} className="flex gap-3 border-b border-line-2 px-5 py-3 last:border-0">
                  {e.kind === "commit" ? <GitCommit className="mt-0.5 size-4 text-info" /> : e.kind === "finding" ? <AlertTriangle className="mt-0.5 size-4 text-amber-deep" /> : <Layers className="mt-0.5 size-4 text-ink-2" />}
                  <div className="min-w-0"><div className="text-[13px] font-medium text-ink">{e.title}</div><div className="break-words font-mono text-[11.5px] text-muted">{e.detail}</div></div>
                </div>
              ))}
              {!ev.items?.length && <EmptyState title="No evidence collected" />}
            </Panel>
          )}
          {tab === "code" && (
            <Panel pad={false}>
              {(ev.snippets ?? []).map((s: any, i: number) => <Link key={i} to={`/app/repository?repo=${d.repository_id}&tab=explorer&file=${encodeURIComponent(s.path)}&line=${s.startLine}`} className="flex items-center gap-3 border-b border-line-2 px-5 py-2.5 last:border-0 hover:bg-ivory/50"><span className="font-mono text-[12px] text-ink">{s.path}:{s.startLine}-{s.endLine}</span><Badge className="ml-auto">{s.reason}</Badge></Link>)}
              {!ev.snippets?.length && <EmptyState title="No code retrieved" />}
            </Panel>
          )}
          {tab === "impact" && (
            <div className="space-y-4">
              <Panel title="Call chains">
                {(ev.chains ?? []).map((c: any) => <div key={c.function + c.file} className="mb-3"><div className="font-mono text-[12.5px] text-ink">{c.function} <span className="text-muted">({c.file})</span></div><div className="mt-1 space-y-0.5 pl-4">{c.callers.map((x: any, k: number) => <div key={k} className="font-mono text-[11.5px] text-muted">← {x.caller ?? "module"} @ {x.file}:{x.line}</div>)}{!c.callers.length && <div className="text-[11.5px] text-faint">No resolved callers</div>}</div></div>)}
                {!ev.chains?.length && <p className="text-[13px] text-muted">No call chains resolved.</p>}
              </Panel>
              <Panel title="Dependency paths (impact radius)">
                {(ev.depPaths ?? []).map((p: any) => <div key={p.file} className="mb-3 text-[12.5px]"><div className="font-mono text-ink">{p.file}</div><div className="text-muted">Imported by {p.importedBy.length}: <span className="font-mono">{p.importedBy.slice(0, 8).join(", ")}</span></div></div>)}
                {!ev.depPaths?.length && <p className="text-[13px] text-muted">No dependency information.</p>}
              </Panel>
            </div>
          )}
          {tab === "fix" && (
            <div className="space-y-4">
              {d.proposed_fix ? (
                <Panel title="Proposed fix" actions={<Badge tone={d.proposed_fix.origin === "ai" ? "info" : "success"}>{d.proposed_fix.origin === "ai" ? "AI-generated" : "Rule-based"}</Badge>}>
                  <Markdown>{d.proposed_fix.summary}</Markdown>
                  {d.proposed_fix.patch && <div className="mt-3"><div className="mb-2 text-[12px] font-medium text-muted">Patch preview — not applied</div><DiffView diff={d.proposed_fix.patch} /></div>}
                  {d.proposed_fix.note && <p className="mt-3 text-[12px] text-muted">{d.proposed_fix.note}</p>}
                </Panel>
              ) : <Panel><EmptyState title="No fix proposed yet" /></Panel>}
              <Panel title="Verification" actions={d.affected?.[0] && <Link to={`/app/tests?new=1&path=${encodeURIComponent(d.affected[0].path)}`}><Button size="sm" icon={<FlaskConical className="size-3.5" />}>Generate regression test</Button></Link>}>
                {d.proposed_fix?.tests && <Markdown>{d.proposed_fix.tests}</Markdown>}
                <p className="mt-2 text-[13px] text-ink-2">{d.verification?.reproducible}</p>
              </Panel>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
