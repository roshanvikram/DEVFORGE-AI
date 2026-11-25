import { useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { GitPullRequest, Plus, ArrowLeft, Download, GitMerge, RefreshCw, MessageSquarePlus, ExternalLink, Users } from "lucide-react";
import { Github } from "../../components/icons";
import { get, post, download } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { NeedsRepo } from "../../components/AppShell";
import { PageHeader, Panel, Button, Modal, Field, Input, Textarea, EmptyState, ErrorState, LoadingBlock, StatusBadge, Badge, Notice, DiffView, Markdown, Tabs, Table, SeverityBadge, OriginBadge, Select, HealthRing } from "../../components/ui";
import { JobPanel } from "../../components/jobs";
import { timeAgo, fmtDate } from "../../lib/format";

export function ReviewsPage() {
  const [params, setParams] = useSearchParams();
  const { can } = useAuth();
  const q = useQuery({ queryKey: ["reviews"], queryFn: () => get("/reviews") });
  return (
    <NeedsRepo>{(repo) => (
      <>
        <PageHeader eyebrow="AI Code Review" icon={<GitPullRequest className="size-6 text-amber-deep" />} title="Code reviews" description="Review commits, commit ranges, pull requests or snippets. Rules run on the changed lines; breaking changes and blast radius come from your dependency graph; Claude adds contextual review when configured."
          actions={can("reviews.create") && <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setParams({ new: "1" })}>New review</Button>} />
        <Panel pad={false}>
          {q.isLoading ? <div className="p-5"><LoadingBlock /></div> : !q.data?.length ? <EmptyState icon={<GitPullRequest className="size-5" />} title="No reviews yet" description="Review your latest commit to get started." action={can("reviews.create") && <Button variant="primary" onClick={() => setParams({ new: "1" })}>New review</Button>} /> : (
            <Table head={["Review", "Type", "Status", "Risk", "Findings", "AI", "Created"]}>
              {q.data.map((r: any) => (
                <tr key={r.id} className="hover:bg-ivory/50">
                  <td className="px-4 py-3"><Link to={`/app/reviews/${r.id}`} className="font-medium text-ink hover:text-amber-deep">{r.title}</Link><div className="text-[11.5px] text-muted">{r.repository}</div></td>
                  <td className="px-4 py-3"><Badge>{r.kind.replace("_", " ")}</Badge></td>
                  <td className="px-4 py-3"><StatusBadge status={r.status} /></td>
                  <td className="px-4 py-3 tabular-nums">{r.risk_score ?? "—"}</td>
                  <td className="px-4 py-3 tabular-nums">{r.findings}</td>
                  <td className="px-4 py-3">{r.ai_used ? <Badge tone="info">yes</Badge> : <span className="text-faint">—</span>}</td>
                  <td className="px-4 py-3 text-muted">{timeAgo(r.created_at)}</td>
                </tr>
              ))}
            </Table>
          )}
        </Panel>
        <NewReview repo={repo} open={params.get("new") === "1"} onClose={() => setParams({})} sha={params.get("sha")} pr={params.get("pr")} />
      </>
    )}</NeedsRepo>
  );
}

function NewReview({ repo, open, onClose, sha, pr }: { repo: any; open: boolean; onClose: () => void; sha: string | null; pr: string | null }) {
  const nav = useNavigate();
  const [kind, setKind] = useState<"commit" | "range" | "pull_request" | "snippet">(pr ? "pull_request" : "commit");
  const commits = useQuery({ queryKey: ["commits", repo.id], queryFn: () => get(`/repositories/${repo.id}/commits`), enabled: open });
  const [v, setV] = useState({ sha: sha ?? "", base: "HEAD~1", head: "HEAD", number: pr ?? "", code: "", path: "" });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const selSha = v.sha || commits.data?.[0]?.sha || "";
  return (
    <Modal open={open} onClose={onClose} width={680} title="New code review" footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={async () => {
      setBusy(true); setErr(null);
      try {
        const body: any = { repositoryId: repo.id, kind };
        if (kind === "commit") body.sha = selSha;
        if (kind === "range") { body.base = v.base; body.head = v.head; }
        if (kind === "pull_request") body.number = Number(v.number);
        if (kind === "snippet") { body.code = v.code; body.path = v.path || undefined; }
        const r = await post("/reviews", body);
        onClose(); nav(`/app/reviews/${r.id}`);
      } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
    }}>Start review</Button></>}>
      <Tabs value={kind} onChange={setKind} tabs={[{ id: "commit", label: "Commit" }, { id: "range", label: "Range" }, { id: "pull_request", label: "Pull request" }, { id: "snippet", label: "Snippet" }]} />
      <div className="mt-5 space-y-4">
        {err && <Notice tone="danger">{err}</Notice>}
        {kind === "commit" && (commits.data?.length ? <Field label="Commit"><Select className="w-full" value={selSha} onChange={(e) => setV({ ...v, sha: e.target.value })}>{commits.data.map((c: any) => <option key={c.sha} value={c.sha}>{c.sha.slice(0, 8)} — {c.subject.slice(0, 70)}</option>)}</Select></Field> : <Notice tone="amber">No git history available for this repository.</Notice>)}
        {kind === "range" && <div className="grid grid-cols-2 gap-3"><Field label="Base ref"><Input value={v.base} onChange={(e) => setV({ ...v, base: e.target.value })} /></Field><Field label="Head ref"><Input value={v.head} onChange={(e) => setV({ ...v, head: e.target.value })} /></Field></div>}
        {kind === "pull_request" && <Field label="Pull request number" hint="Requires a GitHub repository. Private repositories need GitHub connected."><Input type="number" value={v.number} onChange={(e) => setV({ ...v, number: e.target.value })} /></Field>}
        {kind === "snippet" && <><Field label="File path (optional)"><Input value={v.path} onChange={(e) => setV({ ...v, path: e.target.value })} placeholder="src/utils/auth.ts" /></Field><Field label="Code"><Textarea rows={10} className="font-mono text-[12px]" value={v.code} onChange={(e) => setV({ ...v, code: e.target.value })} /></Field></>}
      </div>
    </Modal>
  );
}

export function ReviewDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const { can } = useAuth();
  const [tab, setTab] = useState<"findings" | "diff" | "summary">("findings");
  const [cat, setCat] = useState("");
  const q = useQuery({ queryKey: ["review", id], queryFn: () => get(`/reviews/${id}`), refetchInterval: (qq) => (["queued", "running"].includes((qq.state.data as any)?.status) ? 1500 : false) });
  if (q.isLoading) return <LoadingBlock rows={8} />;
  if (q.error) return <ErrorState error={q.error} retry={q.refetch} />;
  const r = q.data;
  const s = r.summary ?? {};
  const cats = [...new Set(r.findings.map((f: any) => f.category))] as string[];
  const findings = r.findings.filter((f: any) => !cat || f.category === cat);
  return (
    <>
      <button onClick={() => nav("/app/reviews")} className="mb-4 flex items-center gap-1.5 text-[13px] text-muted hover:text-ink"><ArrowLeft className="size-4" />Reviews</button>
      <PageHeader eyebrow={`Code review · ${r.repository}`} title={r.title} description={<span className="flex flex-wrap items-center gap-2"><StatusBadge status={r.status} /><Badge>{r.kind.replace("_", " ")}</Badge>{r.ai_used ? <Badge tone="info">AI review included</Badge> : <Badge>Rule-based only</Badge>}<span>{fmtDate(r.created_at)}</span></span>}
        actions={r.status === "completed" && <>
          <Button icon={<Download className="size-4" />} onClick={() => download(`/reviews/${r.id}/export`, `review-${r.id}.md`)}>Export</Button>
          {r.kind === "pull_request" && can("reviews.create") && <Button variant="primary" icon={<MessageSquarePlus className="size-4" />} onClick={async () => { if (!confirm("Post a summary comment of this review to the GitHub pull request?")) return; try { const x = await post(`/reviews/${r.id}/post-comment`); toast.success("Comment posted"); window.open(x.url, "_blank", "noopener"); } catch (e: any) { toast.error(e.message); } }}>Post to GitHub</Button>}
        </>} />
      {r.error && <div className="mb-4"><Notice tone="danger">{r.error}</Notice></div>}
      {["queued", "running"].includes(r.status) && <Panel><LoadingBlock /></Panel>}
      {r.status === "completed" && (
        <>
          <div className="mb-4 grid gap-4 lg:grid-cols-[220px_1fr_1fr]">
            <Panel className="flex items-center justify-center"><HealthRing score={r.risk_score} label="Risk" size={130} /></Panel>
            <Panel title="Risk summary">
              <div className="grid grid-cols-2 gap-2 text-[12.5px]">
                <div><span className="text-muted">Files</span> <b>{s.risk?.files ?? s.files?.length}</b></div>
                <div><span className="text-muted">Lines</span> <b className="text-success">+{s.risk?.additions ?? 0}</b> <b className="text-danger">−{s.risk?.deletions ?? 0}</b></div>
                <div><span className="text-muted">Tests changed</span> <b>{s.risk?.testsChanged ?? 0}</b></div>
                <div><span className="text-muted">Findings</span> <b>{r.findings.length}</b></div>
              </div>
              <div className="mt-3 flex flex-wrap gap-1.5">{Object.entries(s.bySeverity ?? {}).map(([k, v]: any) => <Badge key={k}>{k}: {v}</Badge>)}</div>
            </Panel>
            <Panel title={<span className="flex items-center gap-2"><Users className="size-4" />Suggested reviewers</span>}>
              {s.reviewers?.length ? s.reviewers.map((x: any) => <div key={x.name} className="flex justify-between py-1 text-[13px]"><span className="text-ink">{x.name}</span><span className="text-muted">{x.commits} recent commits to these files</span></div>) : <p className="text-[13px] text-muted">No git history for the touched files.</p>}
            </Panel>
          </div>
          <Tabs className="mb-4" value={tab} onChange={setTab} tabs={[{ id: "findings", label: "Findings", count: r.findings.length }, { id: "diff", label: "Diff" }, { id: "summary", label: "Summary" }]} />
          {tab === "findings" && (
            <>
              {cats.length > 1 && <div className="mb-3 flex flex-wrap gap-2"><button onClick={() => setCat("")} className={`rounded-full px-3 py-1 text-[12px] ${!cat ? "bg-ink text-white" : "bg-white ring-1 ring-line"}`}>All</button>{cats.map((c) => <button key={c} onClick={() => setCat(c)} className={`rounded-full px-3 py-1 text-[12px] ${cat === c ? "bg-ink text-white" : "bg-white ring-1 ring-line"}`}>{c}</button>)}</div>}
              <div className="space-y-3">
                {findings.map((f: any) => (
                  <Panel key={f.id}>
                    <div className="flex flex-wrap items-center gap-2"><SeverityBadge severity={f.severity} /><OriginBadge origin={f.origin} /><Badge>{f.category}</Badge><span className="font-mono text-[11.5px] text-muted">{f.file_path}{f.line ? `:${f.line}` : ""}</span></div>
                    <h3 className="mt-2 text-[14.5px] font-semibold text-ink">{f.title}</h3>
                    <div className="mt-2 grid gap-3 text-[13px] md:grid-cols-2">
                      <div><div className="text-[11.5px] font-medium uppercase tracking-[0.06em] text-muted">Evidence</div><p className="mt-1 text-ink-2">{f.evidence}</p></div>
                      <div><div className="text-[11.5px] font-medium uppercase tracking-[0.06em] text-muted">Impact</div><p className="mt-1 text-ink-2">{f.impact}</p></div>
                    </div>
                    {f.explanation && <p className="mt-2 text-[13px] text-ink-2">{f.explanation}</p>}
                    <div className="mt-2 text-[13px]"><span className="font-medium text-ink">Fix: </span><span className="text-ink-2">{f.recommendation}</span></div>
                    {f.suggested_patch && <div className="mt-3"><DiffView diff={f.suggested_patch} maxHeight={260} /></div>}
                  </Panel>
                ))}
                {!findings.length && <Panel><EmptyState title="No findings" description="No rule matched the changed lines and the AI review (if enabled) raised no issues." /></Panel>}
              </div>
            </>
          )}
          {tab === "diff" && <Panel pad={false}><div className="p-3">{r.diff ? <DiffView diff={r.diff} maxHeight={720} /> : <EmptyState title="No diff stored" />}</div></Panel>}
          {tab === "summary" && <Panel><Markdown>{s.text ?? ""}</Markdown><div className="mt-4"><Table head={["File", "Status", "+", "−"]}>{(s.files ?? []).map((f: any) => <tr key={f.path}><td className="px-4 py-1.5 font-mono text-[12px]">{f.path}</td><td className="px-4 py-1.5"><Badge>{f.status}</Badge></td><td className="px-4 py-1.5 text-success">{f.additions}</td><td className="px-4 py-1.5 text-danger">{f.deletions}</td></tr>)}</Table></div></Panel>}
        </>
      )}
    </>
  );
}

export function PullRequestsPage() {
  return <NeedsRepo>{(repo) => <PRs repo={repo} />}</NeedsRepo>;
}
function PRs({ repo }: { repo: any }) {
  const qc = useQueryClient();
  const nav = useNavigate();
  const [sel, setSel] = useState<any>(null);
  const q = useQuery({ queryKey: ["pulls", repo.id], queryFn: () => get(`/repositories/${repo.id}/pulls`) });
  const files = useQuery({ queryKey: ["pull-files", repo.id, sel?.number], queryFn: () => get(`/repositories/${repo.id}/pulls/${sel.number}/files`), enabled: !!sel });
  const [syncing, setSyncing] = useState(false);
  const sync = async () => { setSyncing(true); try { await get(`/repositories/${repo.id}/pulls?sync=1`); qc.invalidateQueries({ queryKey: ["pulls", repo.id] }); toast.success("Pull requests synced from GitHub"); } catch (e: any) { toast.error(e.message); } finally { setSyncing(false); } };
  const review = async (n: number) => { try { const r = await post("/reviews", { repositoryId: repo.id, kind: "pull_request", number: n }); nav(`/app/reviews/${r.id}`); } catch (e: any) { toast.error(e.message); } };
  if (q.data?.reason === "not_github") return <><PageHeader eyebrow="Pull Request Intelligence" icon={<GitMerge className="size-6 text-amber-deep" />} title="Pull requests" /><Panel><EmptyState icon={<Github className="size-5" />} title="Not a GitHub repository" description="Pull request intelligence is available for repositories hosted on github.com. Use commit or range reviews for other hosts." action={<Link to="/app/reviews?new=1"><Button>Review a commit</Button></Link>} /></Panel></>;
  return (
    <>
      <PageHeader eyebrow="Pull Request Intelligence" icon={<GitMerge className="size-6 text-amber-deep" />} title="Pull requests" description="Changed files, diffs, AI review, security impact, risk scoring and suggested reviewers for GitHub pull requests." actions={<Button icon={<RefreshCw className="size-4" />} loading={syncing} onClick={sync}>Sync from GitHub</Button>} />
      {q.data && !q.data.connected && <div className="mb-4"><Notice tone="amber">GitHub is not connected — public repositories can still be synced with GitHub's unauthenticated rate limits. <Link to="/app/integrations" className="font-medium text-amber-deep underline">Connect GitHub</Link> for private repositories and posting comments.</Notice></div>}
      <div className="grid gap-4 xl:grid-cols-[1fr_1.2fr]">
        <Panel pad={false}>
          {q.isLoading ? <div className="p-5"><LoadingBlock /></div> : !q.data?.items?.length ? <EmptyState icon={<GitMerge className="size-5" />} title="No pull requests synced" description="Sync to fetch open pull requests." action={<Button onClick={sync} loading={syncing}>Sync now</Button>} /> : q.data.items.map((p: any) => (
            <button key={p.id} onClick={() => setSel(p)} className={`flex w-full items-start gap-3 border-b border-line-2 px-5 py-3 text-left last:border-0 hover:bg-ivory/50 ${sel?.id === p.id ? "bg-amber-soft/30" : ""}`}>
              <GitPullRequest className="mt-0.5 size-4 text-success" />
              <div className="min-w-0 flex-1"><div className="truncate text-[13.5px] font-medium text-ink">#{p.number} {p.title}</div><div className="text-[11.5px] text-muted">{p.author} · {p.head_ref} → {p.base_ref} · updated {timeAgo(p.updated_at)}</div></div>
              {p.review_id && <Badge tone="info">reviewed</Badge>}
            </button>
          ))}
        </Panel>
        <Panel title={sel ? `#${sel.number} ${sel.title}` : "Select a pull request"} actions={sel && <>{sel.url && <a href={sel.url} target="_blank" rel="noreferrer noopener"><Button size="sm" icon={<ExternalLink className="size-3.5" />}>GitHub</Button></a>}{sel.review_id ? <Link to={`/app/reviews/${sel.review_id}`}><Button size="sm">Open review</Button></Link> : null}<Button size="sm" variant="primary" onClick={() => review(sel.number)}>Run AI review</Button></>}>
          {!sel ? <p className="text-[13px] text-muted">Changed files and patches appear here.</p> : files.isLoading ? <LoadingBlock /> : files.error ? <ErrorState error={files.error} /> : (
            <div className="space-y-3">
              {sel.data?.body && <div className="rounded-xl bg-ivory/50 p-3 ring-1 ring-line"><Markdown>{sel.data.body}</Markdown></div>}
              {files.data.map((f: any) => <details key={f.filename} className="rounded-xl border border-line"><summary className="flex cursor-pointer items-center gap-2 px-3 py-2 font-mono text-[12px]"><Badge>{f.status}</Badge>{f.filename}<span className="ml-auto text-success">+{f.additions}</span><span className="text-danger">−{f.deletions}</span></summary>{f.patch ? <div className="p-2"><DiffView diff={f.patch} maxHeight={320} /></div> : <div className="px-3 py-2 text-[12px] text-muted">Binary or too large to display</div>}</details>)}
            </div>
          )}
        </Panel>
      </div>
    </>
  );
}
