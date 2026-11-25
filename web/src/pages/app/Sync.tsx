import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { RefreshCw, Webhook, Copy, KeyRound, Trash2, Radar } from "lucide-react";
import { get, put, post, del } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { NeedsRepo } from "../../components/AppShell";
import { PageHeader, Panel, Button, Field, Select, Toggle, Badge, EmptyState, ErrorState, LoadingBlock, Notice, Modal, Table } from "../../components/ui";
import { fmtDate, timeAgo } from "../../lib/format";

function SyncFor({ repo }: { repo: any }) {
  const { can } = useAuth();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["watch", repo.id], queryFn: () => get<any>(`/repositories/${repo.id}/watch`), refetchInterval: 15000 });
  const [form, setForm] = useState<{ enabled: boolean; intervalMin: number; preset: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [secret, setSecret] = useState<{ secret: string; url: string } | null>(null);
  useEffect(() => { if (q.data) setForm({ enabled: q.data.enabled, intervalMin: q.data.intervalMin, preset: q.data.preset }); }, [q.data?.enabled, q.data?.intervalMin, q.data?.preset, repo.id]);
  const refresh = () => qc.invalidateQueries({ queryKey: ["watch", repo.id] });
  const act = async (key: string, fn: () => Promise<any>) => {
    setBusy(key);
    try { return await fn(); } catch (e: any) { toast.error(e.message); } finally { setBusy(null); refresh(); }
  };
  if (q.error) return <ErrorState error={q.error} retry={() => q.refetch()} />;
  if (!q.data || !form) return <LoadingBlock />;
  const w = q.data;
  return (
    <>
      {!w.supported && <div className="mb-4"><Notice tone="amber">{repo.name} was imported from a local folder, so it has no git remote to watch or receive pushes from. Connect a git or GitHub repository to use auto-sync and webhooks.</Notice></div>}
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title={<span className="flex items-center gap-2"><Radar className="size-4 text-amber" />Auto-sync</span>} subtitle="Polls the remote with git ls-remote (no download) and re-analyses only when a new commit lands">
          <div className="space-y-3">
            <Toggle checked={form.enabled} disabled={!w.supported || !can("analysis.run")} onChange={(v) => setForm({ ...form, enabled: v })} label="Watch the default branch" />
            <div className="grid grid-cols-2 gap-3">
              <Field label="Check every"><Select value={form.intervalMin} disabled={!w.supported} onChange={(e) => setForm({ ...form, intervalMin: Number(e.target.value) })}>{[5, 15, 30, 60, 180, 720, 1440].map((m) => <option key={m} value={m}>{m < 60 ? `${m} min` : `${m / 60} h`}</option>)}</Select></Field>
              <Field label="Scan preset"><Select value={form.preset} disabled={!w.supported} onChange={(e) => setForm({ ...form, preset: e.target.value })}><option value="quick">Quick</option><option value="full">Full</option><option value="security">Security</option></Select></Field>
            </div>
            <div className="flex gap-2">
              <Button variant="primary" disabled={!w.supported || !can("analysis.run")} loading={busy === "save"} onClick={() => act("save", async () => { await put(`/repositories/${repo.id}/watch`, form); toast.success(form.enabled ? "Auto-sync enabled" : "Auto-sync disabled"); })}>Save</Button>
              <Button disabled={!w.supported || !can("analysis.run")} loading={busy === "check"} icon={<RefreshCw className="size-4" />} onClick={() => act("check", async () => {
                const r = await post<any>(`/repositories/${repo.id}/watch/check`);
                const msg: Record<string, string> = { updated: "New commit found — analysis queued", unchanged: "Already up to date", busy: "An analysis is already running", unsupported: "Not supported for local imports", error: `Check failed: ${r.error}` };
                toast[r.status === "error" ? "error" : "success"](msg[r.status]);
              })}>Check now</Button>
            </div>
            <dl className="grid grid-cols-2 gap-2 text-[12px]">
              <div className="rounded-lg bg-ivory/70 px-3 py-2 ring-1 ring-line"><dt className="text-muted">Last checked</dt><dd className="font-medium text-ink">{w.lastCheckedAt ? timeAgo(w.lastCheckedAt) : "never"}</dd></div>
              <div className="rounded-lg bg-ivory/70 px-3 py-2 ring-1 ring-line"><dt className="text-muted">Remote head</dt><dd className="font-mono text-ink">{w.remoteSha ? w.remoteSha.slice(0, 10) : "—"}</dd></div>
              <div className="rounded-lg bg-ivory/70 px-3 py-2 ring-1 ring-line"><dt className="text-muted">Analysed commit</dt><dd className="font-mono text-ink">{repo.commit ? repo.commit.slice(0, 10) : "—"}</dd></div>
              <div className="rounded-lg bg-ivory/70 px-3 py-2 ring-1 ring-line"><dt className="text-muted">Status</dt><dd>{w.lastError ? <Badge tone="danger">error</Badge> : w.enabled ? <Badge tone="success">watching</Badge> : <Badge>off</Badge>}</dd></div>
            </dl>
            {w.lastError && <Notice tone="danger">{w.lastError}</Notice>}
          </div>
        </Panel>

        <Panel title={<span className="flex items-center gap-2"><Webhook className="size-4 text-amber" />Push webhook</span>} subtitle="GitHub calls DevForge on every push; analysis starts within seconds">
          <div className="space-y-3 text-[13px]">
            <Field label="Payload URL"><div className="flex gap-2"><code className="min-w-0 flex-1 truncate rounded-lg bg-ivory px-3 py-2 font-mono text-[12px] ring-1 ring-line">{w.webhook.url}</code><Button size="sm" variant="ghost" icon={<Copy className="size-3.5" />} onClick={() => navigator.clipboard.writeText(w.webhook.url).then(() => toast.success("Copied"))}>Copy</Button></div></Field>
            <p className="text-muted">Content type <code className="font-mono">application/json</code>, events: <b>Just the push event</b>. Requests are verified with HMAC-SHA256 (<code className="font-mono">X-Hub-Signature-256</code>); unsigned or forged deliveries are rejected and logged.</p>
            <div className="flex items-center gap-2">
              {w.webhook.configured ? <Badge tone="success">secret configured</Badge> : <Badge>not configured</Badge>}
              {w.webhook.lastDeliveryAt && <span className="text-[12px] text-muted">last delivery {timeAgo(w.webhook.lastDeliveryAt)}</span>}
            </div>
            {can("integrations.manage") ? (
              <div className="flex gap-2">
                <Button variant="primary" disabled={!w.supported} loading={busy === "secret"} icon={<KeyRound className="size-4" />} onClick={() => act("secret", async () => setSecret(await post(`/repositories/${repo.id}/webhook`)))}>{w.webhook.configured ? "Rotate secret" : "Generate secret"}</Button>
                {w.webhook.configured && <Button variant="ghost" loading={busy === "off"} icon={<Trash2 className="size-4" />} onClick={() => act("off", async () => { await del(`/repositories/${repo.id}/webhook`); toast.success("Webhook disabled"); })}>Disable</Button>}
              </div>
            ) : <Notice tone="info">Only owners and admins can manage webhook secrets.</Notice>}
          </div>
        </Panel>
      </div>

      <Panel className="mt-4" title="Recent deliveries" subtitle="Every webhook request, including rejected ones" pad={false}>
        {w.deliveries.length ? (
          <Table head={["When", "Event", "Result", "Detail"]}>
            {w.deliveries.map((d: any, i: number) => (
              <tr key={i} className="border-b border-line/60 last:border-0"><td className="px-4 py-2 text-muted">{fmtDate(d.created_at)}</td><td className="px-4 py-2 font-mono text-[12px]">{d.event ?? "—"}</td><td className="px-4 py-2"><Badge tone={d.status === "queued" || d.status === "ok" ? "success" : d.status === "rejected" ? "danger" : "neutral"}>{d.status}</Badge></td><td className="px-4 py-2 text-ink-2">{d.detail}</td></tr>
            ))}
          </Table>
        ) : <div className="p-6"><EmptyState icon={<Webhook className="size-5" />} title="No deliveries yet" description="Deliveries appear here in real time once GitHub starts sending pushes." /></div>}
      </Panel>

      <Modal open={!!secret} onClose={() => setSecret(null)} title="Webhook secret" footer={<Button variant="primary" onClick={() => setSecret(null)}>I've saved it</Button>}>
        <Notice tone="amber">Copy this secret into GitHub → Settings → Webhooks now. It is stored encrypted and will not be shown again.</Notice>
        <div className="mt-3 flex gap-2"><code className="min-w-0 flex-1 break-all rounded-lg bg-ivory px-3 py-2 font-mono text-[12.5px] ring-1 ring-line">{secret?.secret}</code><Button size="sm" icon={<Copy className="size-3.5" />} onClick={() => navigator.clipboard.writeText(secret!.secret).then(() => toast.success("Copied"))}>Copy</Button></div>
      </Modal>
    </>
  );
}

export default function SyncPage() {
  return (
    <>
      <PageHeader eyebrow="Automate" title="Auto-Sync & Webhooks" description="Keep analysis current without clicking anything: watch the remote for new commits, or let GitHub push them to DevForge. Every new commit is re-indexed, re-scanned, scored and checked against your quality gate." />
      <NeedsRepo>{(repo) => <SyncFor key={repo.id} repo={repo} />}</NeedsRepo>
    </>
  );
}
