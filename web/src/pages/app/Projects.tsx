import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { FolderGit2, Plus, RefreshCw, Trash2, ExternalLink, GitBranch } from "lucide-react";
import { Github } from "../../components/icons";
import { get, post, del } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { useRepo } from "../../lib/repo";
import { PageHeader, Button, Modal, Field, Input, Select, Tabs, Notice, EmptyState, HealthRing, StatusBadge, Badge, cx } from "../../components/ui";
import { JobPanel, useActiveJobs } from "../../components/jobs";
import { timeAgo, num } from "../../lib/format";

export function ConnectRepoModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [tab, setTab] = useState<"git" | "github" | "local">("git");
  const [url, setUrl] = useState("");
  const [branch, setBranch] = useState("");
  const [path, setPath] = useState("");
  const [preset, setPreset] = useState("full");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const qc = useQueryClient();
  const { setRepoId } = useRepo();
  const gh = useQuery({ queryKey: ["gh-repos"], queryFn: () => get("/github/repos"), enabled: open && tab === "github", retry: false });
  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await post("/repositories", tab === "local" ? { source: "local", path, preset } : { source: tab, url, branch: branch || undefined, preset });
      setRepoId(r.id);
      qc.invalidateQueries({ queryKey: ["repos"] });
      toast.success("Repository connected — analysis started");
      onClose();
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  return (
    <Modal open={open} onClose={onClose} title="Connect a repository" footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={submit} disabled={tab === "local" ? !path : !url}>Connect & analyse</Button></>}>
      <Tabs tabs={[{ id: "git", label: "Git URL" }, { id: "github", label: "GitHub" }, { id: "local", label: "Local path" }]} value={tab} onChange={setTab} />
      <div className="mt-5 space-y-4">
        {err && <Notice tone="danger">{err}</Notice>}
        {tab !== "local" && <Field label="Repository URL" hint="https only. Allowed hosts are set by GIT_HOST_ALLOWLIST on the server."><Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://github.com/owner/repo" autoFocus /></Field>}
        {tab === "github" && (gh.data?.connected ? (
          <div className="scroll-thin max-h-52 overflow-y-auto rounded-xl border border-line">{gh.data.items.map((r: any) => <button key={r.full_name} onClick={() => setUrl(r.url)} className={cx("flex w-full items-center justify-between border-b border-line-2 px-3 py-2 text-left text-[13px] hover:bg-ivory", url === r.url && "bg-amber-soft/40")}><span>{r.full_name}</span>{r.private && <Badge>private</Badge>}</button>)}</div>
        ) : gh.isFetched && <Notice tone="amber">GitHub is not connected. Public repositories still work via URL; connect a token in Integrations for private ones.</Notice>)}
        {tab !== "local" && <Field label="Branch (optional)"><Input value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="default branch" /></Field>}
        {tab === "local" && <Field label="Directory on the DevForge server" hint="Only directories under LOCAL_IMPORT_ROOTS are allowed. The directory is copied; it is never modified."><Input value={path} onChange={(e) => setPath(e.target.value)} placeholder="/srv/code/my-service" /></Field>}
        <Field label="Analysis preset"><Select className="w-full" value={preset} onChange={(e) => setPreset(e.target.value)}><option value="full">Full repository analysis</option><option value="quick">Quick scan</option><option value="security">Security audit</option><option value="architecture">Architecture analysis</option></Select></Field>
      </div>
    </Modal>
  );
}

export default function Projects() {
  const [params, setParams] = useSearchParams();
  const { repos, setRepoId } = useRepo();
  const { can } = useAuth();
  const nav = useNavigate();
  const qc = useQueryClient();
  const jobs = useActiveJobs();
  const [confirm, setConfirm] = useState<any>(null);
  const open = params.get("new") === "1";
  return (
    <>
      <PageHeader eyebrow="Projects" title="Repositories" description="Every connected repository in this workspace, with its latest analysis state." actions={can("repo.create") && <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setParams({ new: "1" })}>Connect repository</Button>} />
      {jobs.length > 0 && <div className="mb-5 space-y-2">{jobs.map((j: any) => <JobPanel key={j.id} jobId={j.id} compact />)}</div>}
      {repos && !repos.length && <div className="panel"><EmptyState icon={<FolderGit2 className="size-5" />} title="No repositories connected" description="Connect a repository to begin analysis." action={can("repo.create") && <Button variant="primary" onClick={() => setParams({ new: "1" })}>Connect repository</Button>} /></div>}
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {repos?.map((r) => (
          <div key={r.id} className="panel flex flex-col p-5">
            <div className="flex items-start gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">{r.source_type === "github" ? <Github className="size-4 text-muted" /> : <GitBranch className="size-4 text-muted" />}<h3 className="truncate text-[15px] font-semibold text-ink">{r.name}</h3></div>
                <div className="mt-1 flex flex-wrap items-center gap-1.5"><StatusBadge status={r.status} />{r.default_branch && <Badge>{r.default_branch}</Badge>}{r.commit && <Badge className="font-mono">{r.commit.slice(0, 7)}</Badge>}</div>
              </div>
              <HealthRing score={r.health?.score ?? null} size={68} label="" />
            </div>
            {r.error && <div className="mt-3 text-[12px] text-danger">{r.error}</div>}
            <div className="mt-4 grid grid-cols-3 gap-2 text-center text-[11.5px]">
              <div className="rounded-lg bg-ivory/70 py-2 ring-1 ring-line"><div className="text-[14px] font-semibold tabular-nums text-ink">{num(r.stats?.files)}</div><div className="text-muted">files</div></div>
              <div className="rounded-lg bg-ivory/70 py-2 ring-1 ring-line"><div className="text-[14px] font-semibold tabular-nums text-ink">{num(r.stats?.loc)}</div><div className="text-muted">LOC</div></div>
              <div className="rounded-lg bg-ivory/70 py-2 ring-1 ring-line"><div className="text-[14px] font-semibold tabular-nums text-ink">{num(Object.values(r.stats?.symbols ?? {}).reduce((a: number, b: any) => a + b, 0))}</div><div className="text-muted">symbols</div></div>
            </div>
            <div className="mt-3 flex flex-wrap gap-1">{r.frameworks.slice(0, 6).map((f) => <Badge key={f}>{f}</Badge>)}</div>
            <div className="mt-auto flex items-center gap-2 pt-4 text-[12px] text-faint">
              <span>Analysed {timeAgo(r.last_analyzed_at)}</span>
              <div className="ml-auto flex gap-1">
                {r.source_url && <a href={r.source_url} target="_blank" rel="noreferrer noopener" className="rounded-lg p-1.5 hover:bg-ivory" title="Open source"><ExternalLink className="size-3.5" /></a>}
                {can("analysis.run") && <button title="Pull latest & re-analyse" className="rounded-lg p-1.5 hover:bg-ivory" onClick={async () => { try { await post(`/repositories/${r.id}/refresh`, { preset: "full" }); toast.success("Refreshing"); qc.invalidateQueries(); } catch (e: any) { toast.error(e.message); } }}><RefreshCw className="size-3.5" /></button>}
                {can("repo.delete") && <button title="Delete" className="rounded-lg p-1.5 hover:bg-danger-soft hover:text-danger" onClick={() => setConfirm(r)}><Trash2 className="size-3.5" /></button>}
              </div>
            </div>
            <Button className="mt-3" onClick={() => { setRepoId(r.id); nav("/app"); }}>Open</Button>
          </div>
        ))}
      </div>
      <ConnectRepoModal open={open} onClose={() => setParams({})} />
      <Modal open={!!confirm} onClose={() => setConfirm(null)} title="Delete repository" footer={<><Button variant="ghost" onClick={() => setConfirm(null)}>Cancel</Button><Button variant="danger" onClick={async () => { await del(`/repositories/${confirm.id}`); setConfirm(null); qc.invalidateQueries(); toast.success("Repository deleted"); }}>Delete permanently</Button></>}>
        <p className="text-[13.5px] text-ink-2">This permanently deletes <b>{confirm?.name}</b>, its index, findings, reviews and test history from DevForge. The original repository is not affected. This cannot be undone.</p>
      </Modal>
    </>
  );
}
