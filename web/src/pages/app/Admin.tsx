import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Users, Plug, Settings as SettingsIcon, HelpCircle, Mail, Trash2, Plus, Sparkles, Webhook, Shield, KeyRound, Monitor, CheckCircle2, XCircle, Terminal, BookOpen, Zap } from "lucide-react";
import { Github, Slack } from "../../components/icons";
import { get, post, patch, put, del, setWorkspaceId } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { PageHeader, Panel, Button, Modal, Field, Input, Select, EmptyState, LoadingBlock, Badge, StatusBadge, Notice, Tabs, Toggle, Table, Stat, cx } from "../../components/ui";
import { timeAgo, fmtDate, usd, num, titleCase } from "../../lib/format";

const ROLE_DESC: Record<string, string> = { owner: "Full control including deletion and ownership", admin: "Manage members, settings, integrations", engineer: "Import repos, run analyses, tests, workflows", security: "Run scans, triage, approve workflow gates", viewer: "Read-only access" };

export function TeamPage() {
  const { can, me, workspace, refresh, switchWorkspace } = useAuth();
  const [params, setParams] = useSearchParams();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["members"], queryFn: () => get("/members") });
  const [inv, setInv] = useState({ email: "", role: "engineer" });
  const [busy, setBusy] = useState(false);
  const [wsName, setWsName] = useState("");
  const nav = useNavigate();
  return (
    <>
      <PageHeader eyebrow="Team & Collaboration" icon={<Users className="size-6 text-amber-deep" />} title={workspace?.name ?? "Team"} description={`Organization: ${workspace?.org_name}. Roles are enforced by the server on every request.`} actions={<Button icon={<Plus className="size-4" />} onClick={() => setParams({ new: "1" })}>New workspace</Button>} />
      <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
        <Panel title="Members" pad={false}>
          {q.isLoading ? <div className="p-5"><LoadingBlock /></div> : (
            <Table head={["Member", "Role", "Joined", ""]}>
              {q.data.members.map((m: any) => (
                <tr key={m.id}>
                  <td className="px-4 py-3"><div className="font-medium text-ink">{m.name}{m.user_id === me?.user.id && <span className="text-muted"> (you)</span>}</div><div className="text-[12px] text-muted">{m.email}</div></td>
                  <td className="px-4 py-3">{can("members.manage") && m.user_id !== me?.user.id ? <Select value={m.role} onChange={async (e) => { try { await patch(`/members/${m.id}`, { role: e.target.value }); qc.invalidateQueries({ queryKey: ["members"] }); toast.success("Role updated"); } catch (er: any) { toast.error(er.message); } }}>{["owner", "admin", "engineer", "security", "viewer"].map((r) => <option key={r}>{r}</option>)}</Select> : <Badge>{m.role}</Badge>}</td>
                  <td className="px-4 py-3 text-muted">{timeAgo(m.created_at)}</td>
                  <td className="px-4 py-3 text-right">{(can("members.manage") || m.user_id === me?.user.id) && <Button size="sm" variant="ghost" icon={<Trash2 className="size-3.5" />} onClick={async () => { if (!confirm(m.user_id === me?.user.id ? "Leave this workspace?" : `Remove ${m.name}?`)) return; try { await del(`/members/${m.id}`); if (m.user_id === me?.user.id) { setWorkspaceId(null); await refresh(); nav("/app"); } else qc.invalidateQueries({ queryKey: ["members"] }); } catch (er: any) { toast.error(er.message); } }}>{m.user_id === me?.user.id ? "Leave" : "Remove"}</Button>}</td>
                </tr>
              ))}
            </Table>
          )}
          {q.data?.invitations?.length > 0 && (
            <div className="border-t border-line-2 p-4">
              <div className="mb-2 text-[12px] font-semibold uppercase tracking-[0.08em] text-muted">Pending invitations</div>
              {q.data.invitations.map((i: any) => <div key={i.id} className="flex items-center gap-3 py-1.5 text-[13px]"><Mail className="size-3.5 text-faint" />{i.email}<Badge>{i.role}</Badge><span className="text-[11.5px] text-faint">expires {fmtDate(i.expires_at)}</span>{can("members.manage") && <button className="ml-auto text-[12px] text-danger" onClick={async () => { await del(`/invitations/${i.id}`); qc.invalidateQueries({ queryKey: ["members"] }); }}>Revoke</button>}</div>)}
            </div>
          )}
        </Panel>
        <div className="space-y-4">
          {can("members.manage") && (
            <Panel title="Invite a teammate">
              <div className="space-y-3">
                <Field label="Email"><Input type="email" value={inv.email} onChange={(e) => setInv({ ...inv, email: e.target.value })} /></Field>
                <Field label="Role" hint={ROLE_DESC[inv.role]}><Select className="w-full" value={inv.role} onChange={(e) => setInv({ ...inv, role: e.target.value })}>{["admin", "engineer", "security", "viewer"].map((r) => <option key={r}>{r}</option>)}</Select></Field>
                <Button variant="primary" className="w-full" loading={busy} onClick={async () => { setBusy(true); try { const r = await post("/invitations", inv); toast.success(r.delivery === "outbox" ? "Invitation created (dev mode: written to server outbox)" : "Invitation sent"); setInv({ email: "", role: "engineer" }); qc.invalidateQueries({ queryKey: ["members"] }); } catch (e: any) { toast.error(e.message); } finally { setBusy(false); } }}>Send invitation</Button>
              </div>
            </Panel>
          )}
          <Panel title="Roles & permissions">{Object.entries(ROLE_DESC).map(([r, d]) => <div key={r} className="mb-2 text-[12.5px]"><b className="capitalize text-ink">{r}</b> — <span className="text-muted">{d}</span></div>)}</Panel>
          <Panel title="Your workspaces" pad={false}>{me?.workspaces.map((w) => <button key={w.id} onClick={() => switchWorkspace(w.id)} className={cx("flex w-full items-center justify-between border-b border-line-2 px-4 py-2.5 text-left text-[13px] last:border-0 hover:bg-ivory/50", w.id === workspace?.id && "bg-amber-soft/30")}><span>{w.name}</span><Badge>{w.role}</Badge></button>)}</Panel>
        </div>
      </div>
      <Modal open={params.get("new") === "1"} onClose={() => setParams({})} title="Create workspace" footer={<Button variant="primary" disabled={wsName.trim().length < 2} onClick={async () => { try { const r = await post("/workspaces", { name: wsName }); await refresh(); await switchWorkspace(r.id); setParams({}); nav("/app"); } catch (e: any) { toast.error(e.message); } }}>Create</Button>}>
        <Field label="Workspace name"><Input value={wsName} onChange={(e) => setWsName(e.target.value)} autoFocus /></Field>
      </Modal>
    </>
  );
}

const INT_ICON: Record<string, any> = { github: Github, anthropic: Sparkles, groq: Zap, slack: Slack, webhook: Webhook };
export function IntegrationsPage() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["integrations"], queryFn: () => get("/integrations") });
  const caps = useQuery({ queryKey: ["capabilities"], queryFn: () => get("/system/capabilities") });
  const [edit, setEdit] = useState<any>(null);
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <>
      <PageHeader eyebrow="Integrations" icon={<Plug className="size-6 text-amber-deep" />} title="Integrations" description="Credentials are verified before saving, encrypted with AES-256-GCM, and never shown again — only the last four characters." />
      <div className="grid gap-4 md:grid-cols-2">
        {q.isLoading ? <LoadingBlock /> : q.data.map((i: any) => {
          const I = INT_ICON[i.provider] ?? Plug;
          return (
            <Panel key={i.provider}>
              <div className="flex items-start gap-4">
                <div className="grid size-11 place-items-center rounded-xl bg-gradient-to-b from-white to-ivory ring-1 ring-line"><I className="size-5 text-ink-2" /></div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2"><h3 className="text-[15px] font-semibold text-ink">{i.name}</h3><StatusBadge status={i.status} /></div>
                  <p className="mt-1 text-[13px] text-muted">{i.description}</p>
                  <div className="mt-2 text-[12px] text-faint">{i.source === "environment" ? "Configured via server environment variable" : i.secretHint ? `Key ${i.secretHint}${i.config?.login ? ` · @${i.config.login}` : ""} · updated ${timeAgo(i.updatedAt)}` : "Not connected"}</div>
                </div>
              </div>
              {can("integrations.manage") && <div className="mt-4 flex gap-2">
                <Button size="sm" variant={i.status === "connected" ? "secondary" : "primary"} onClick={() => { setEdit(i); setSecret(""); }}>{i.source === "workspace" ? "Replace credential" : "Connect"}</Button>
                {i.source === "workspace" && <Button size="sm" variant="danger" onClick={async () => { if (!confirm(`Disconnect ${i.name}?`)) return; await del(`/integrations/${i.provider}`); qc.invalidateQueries({ queryKey: ["integrations"] }); qc.invalidateQueries({ queryKey: ["capabilities"] }); }}>Disconnect</Button>}
              </div>}
            </Panel>
          );
        })}
      </div>
      <Panel title="Analysis tools on this server" className="mt-4">
        <p className="mb-3 text-[13px] text-muted">Optional scanners are used when installed on the DevForge server. Missing tools are reported per scan — DevForge's built-in analyzers always run.</p>
        <div className="grid grid-cols-2 gap-2 md:grid-cols-5">{Object.entries(caps.data?.tools ?? {}).map(([k, v]: any) => <div key={k} className="flex items-center gap-2 rounded-lg bg-ivory/60 px-3 py-2 text-[12.5px] ring-1 ring-line">{v ? <CheckCircle2 className="size-3.5 text-success" /> : <XCircle className="size-3.5 text-faint" />}<span className="font-mono">{k}</span></div>)}</div>
        {caps.data && <div className="mt-3 text-[12.5px] text-muted">Sandbox: <b className="text-ink">{caps.data.sandbox.mode}</b> — {caps.data.sandbox.reason}</div>}
      </Panel>
      <Modal open={!!edit} onClose={() => setEdit(null)} title={`Connect ${edit?.name}`} footer={<><Button variant="ghost" onClick={() => setEdit(null)}>Cancel</Button><Button variant="primary" loading={busy} disabled={secret.length < 8} onClick={async () => { setBusy(true); try { await put(`/integrations/${edit.provider}`, { secret, config: {} }); toast.success(`${edit.name} connected`); setEdit(null); setSecret(""); qc.invalidateQueries({ queryKey: ["integrations"] }); qc.invalidateQueries({ queryKey: ["capabilities"] }); } catch (e: any) { toast.error(e.message); } finally { setBusy(false); } }}>Verify & save</Button></>}>
        <Field label={edit?.secretLabel ?? "Secret"} hint="Stored encrypted; you won't be able to view it again."><Input type="password" autoComplete="off" value={secret} onChange={(e) => setSecret(e.target.value)} /></Field>
      </Modal>
    </>
  );
}

export function SettingsPage() {
  const [params, setParams] = useSearchParams();
  const tab = (params.get("tab") ?? "profile") as any;
  return (
    <>
      <PageHeader eyebrow="Settings" icon={<SettingsIcon className="size-6 text-amber-deep" />} title="Settings" />
      <Tabs className="mb-5" value={tab} onChange={(t) => setParams({ tab: t })} tabs={[{ id: "profile", label: "Account" }, { id: "security", label: "Security" }, { id: "workspace", label: "Workspace" }, { id: "ai", label: "AI & models" }, { id: "notifications", label: "Notifications" }, { id: "usage", label: "Usage & billing" }, { id: "retention", label: "Data retention" }]} />
      {tab === "profile" && <Profile />}
      {tab === "security" && <SecuritySettings />}
      {tab === "workspace" && <WorkspaceSettings />}
      {(tab === "ai" || tab === "notifications" || tab === "retention" || tab === "usage") && <WsSettings tab={tab} />}
    </>
  );
}

function Profile() {
  const { me, refresh } = useAuth();
  const [name, setName] = useState(me?.user.name ?? "");
  return (
    <Panel title="Profile" className="max-w-xl">
      <div className="space-y-4">
        <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="Email" hint={me?.user.email_verified_at ? `Verified ${fmtDate(me.user.email_verified_at)}` : "Not verified"}><Input value={me?.user.email} disabled /></Field>
        {me?.user.providers.length ? <div className="text-[12.5px] text-muted">Linked sign-in: {me.user.providers.join(", ")}</div> : null}
        <Button variant="primary" onClick={async () => { try { await patch("/auth/profile", { name }); await refresh(); toast.success("Profile saved"); } catch (e: any) { toast.error(e.message); } }}>Save</Button>
      </div>
    </Panel>
  );
}

function SecuritySettings() {
  const { me } = useAuth();
  const qc = useQueryClient();
  const sessions = useQuery({ queryKey: ["sessions"], queryFn: () => get("/auth/sessions") });
  const [pw, setPw] = useState({ current: "", next: "" });
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Panel title={<span className="flex items-center gap-2"><KeyRound className="size-4" />Change password</span>}>
        <div className="space-y-3">
          {me?.user.has_password && <Field label="Current password"><Input type="password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} autoComplete="current-password" /></Field>}
          <Field label="New password" hint="At least 10 characters with letters and numbers. Other sessions will be signed out."><Input type="password" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} autoComplete="new-password" /></Field>
          <Button variant="primary" onClick={async () => { try { await post("/auth/change-password", pw); setPw({ current: "", next: "" }); toast.success("Password changed"); qc.invalidateQueries({ queryKey: ["sessions"] }); } catch (e: any) { toast.error(e.message); } }}>Update password</Button>
        </div>
      </Panel>
      <Panel title={<span className="flex items-center gap-2"><Monitor className="size-4" />Active sessions</span>} pad={false}>
        {sessions.data?.map((s: any) => <div key={s.id} className="flex items-center gap-3 border-b border-line-2 px-5 py-3 text-[12.5px] last:border-0"><div className="min-w-0 flex-1"><div className="truncate text-ink">{s.user_agent || "Unknown device"}</div><div className="text-muted">{s.ip} · last active {timeAgo(s.last_seen_at)} · expires {fmtDate(s.expires_at)}</div></div>{s.current ? <Badge tone="success">this device</Badge> : <Button size="sm" variant="ghost" onClick={async () => { await del(`/auth/sessions/${s.id}`); qc.invalidateQueries({ queryKey: ["sessions"] }); }}>Revoke</Button>}</div>)}
      </Panel>
    </div>
  );
}

function WorkspaceSettings() {
  const { workspace, can, refresh } = useAuth();
  const nav = useNavigate();
  const [name, setName] = useState(workspace?.name ?? "");
  const [confirmName, setConfirmName] = useState("");
  return (
    <div className="grid max-w-3xl gap-4">
      <Panel title="Workspace">
        <div className="space-y-3"><Field label="Name"><Input value={name} disabled={!can("workspace.manage")} onChange={(e) => setName(e.target.value)} /></Field>
          {can("workspace.manage") && <Button variant="primary" onClick={async () => { try { await patch("/workspace", { name }); await refresh(); toast.success("Saved"); } catch (e: any) { toast.error(e.message); } }}>Save</Button>}</div>
      </Panel>
      {can("workspace.delete") && (
        <Panel title={<span className="text-danger">Danger zone</span>}>
          <p className="text-[13px] text-muted">Deleting the workspace permanently removes its repositories, findings, reviews, tests, agents, workflows and audit history. This cannot be undone.</p>
          <div className="mt-3 flex gap-2"><Input placeholder={`Type "${workspace?.name}" to confirm`} value={confirmName} onChange={(e) => setConfirmName(e.target.value)} /><Button variant="danger" disabled={confirmName !== workspace?.name} onClick={async () => { try { await del("/workspace", { confirm: confirmName }); setWorkspaceId(null); await refresh(); nav("/onboarding"); } catch (e: any) { toast.error(e.message); } }}>Delete workspace</Button></div>
        </Panel>
      )}
    </div>
  );
}

function WsSettings({ tab }: { tab: "ai" | "notifications" | "retention" | "usage" }) {
  const { can } = useAuth();
  const q = useQuery({ queryKey: ["settings"], queryFn: () => get("/settings") });
  const an = useQuery({ queryKey: ["analytics", 30, ""], queryFn: () => get("/analytics?days=30"), enabled: tab === "usage" });
  const [s, setS] = useState<any>(null);
  useEffect(() => { if (q.data) setS(q.data.settings); }, [q.data]);
  const qc = useQueryClient();
  if (!s) return <LoadingBlock />;
  const editable = can("settings.manage");
  const save = async (section: string) => { try { await patch("/settings", { [section]: s[section] }); qc.invalidateQueries({ queryKey: ["settings"] }); toast.success("Settings saved"); } catch (e: any) { toast.error(e.message); } };
  const upd = (section: string, k: string, v: any) => setS({ ...s, [section]: { ...s[section], [k]: v } });
  if (tab === "usage") {
    const ai = q.data.ai;
    return (
      <>
        <div className="mb-4 grid gap-3 md:grid-cols-4"><Stat label="AI spend this month" value={usd(ai.monthSpendUsd)} sub={`budget ${ai.budgetUsd ? usd(ai.budgetUsd) : "unlimited"}`} /><Stat label="AI requests" value={num(ai.monthRequests)} /><Stat label="Input tokens" value={num(ai.monthInputTokens)} /><Stat label="Output tokens" value={num(ai.monthOutputTokens)} /></div>
        <Panel title="Billing">
          <p className="text-[13px] leading-relaxed text-muted">AI usage is billed by your provider (Anthropic or Groq) directly to the API key you connect; DevForge records provider-reported token usage and estimates cost from published per-model prices. Self-hosted DevForge has no platform fee.</p>
          {an.data?.ai?.length > 0 && <div className="mt-4"><Table head={["Feature (30d)", "Requests", "Cost"]}>{an.data.ai.map((r: any) => <tr key={r.feature}><td className="px-4 py-2 font-mono text-[12px]">{r.feature}</td><td className="px-4 py-2">{r.n}</td><td className="px-4 py-2">{usd(r.cost)}</td></tr>)}</Table></div>}
        </Panel>
      </>
    );
  }
  return (
    <Panel className="max-w-2xl" title={tab === "ai" ? "AI provider & model" : tab === "notifications" ? "Notifications" : "Data retention"}>
      {!editable && <div className="mb-3"><Notice tone="info">Only owners and admins can change workspace settings.</Notice></div>}
      {tab === "ai" && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2 text-[13px]">Active provider: <b>{q.data.ai.provider === "groq" ? "Groq" : q.data.ai.provider === "anthropic" ? "Anthropic Claude" : "none"}</b> <StatusBadge status={q.data.ai.configured ? "connected" : "disconnected"} />{q.data.ai.source && <span className="text-muted">via {q.data.ai.source}</span>}<span className="text-muted">· keys: Claude {q.data.ai.available.anthropic ? "✓" : "—"}, Groq {q.data.ai.available.groq ? "✓" : "—"}</span></div>
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Provider" hint="Auto uses Claude when connected, otherwise Groq."><Select className="w-full" disabled={!editable} value={s.ai.provider ?? "auto"} onChange={(e) => upd("ai", "provider", e.target.value)}><option value="auto">Auto</option><option value="anthropic">Anthropic Claude</option><option value="groq">Groq</option></Select></Field>
            <Field label="Claude model"><Select className="w-full" disabled={!editable} value={s.ai.model} onChange={(e) => upd("ai", "model", e.target.value)}>{q.data.models.map((m: string) => <option key={m}>{m}</option>)}</Select></Field>
            <Field label="Groq model"><Select className="w-full" disabled={!editable} value={s.ai.groqModel ?? q.data.groqModels?.[0]} onChange={(e) => upd("ai", "groqModel", e.target.value)}>{(q.data.groqModels ?? []).map((m: string) => <option key={m}>{m}</option>)}</Select></Field>
            <Field label="Reasoning effort (Claude)" hint="Higher effort: deeper analysis, more tokens."><Select className="w-full" disabled={!editable} value={s.ai.effort} onChange={(e) => upd("ai", "effort", e.target.value)}>{["low", "medium", "high", "xhigh", "max"].map((m) => <option key={m}>{m}</option>)}</Select></Field>
            <Field label="Monthly budget (USD)" hint="Requests are refused once reached. 0 = unlimited."><Input type="number" min={0} disabled={!editable} value={s.ai.monthlyBudgetUsd} onChange={(e) => upd("ai", "monthlyBudgetUsd", Number(e.target.value))} /></Field>
            <Field label="Max context files per request"><Input type="number" min={1} max={40} disabled={!editable} value={s.ai.maxContextFiles} onChange={(e) => upd("ai", "maxContextFiles", Number(e.target.value))} /></Field>
          </div>
          {q.data.ai.provider === "groq" && !q.data.ai.costTracked && <Notice tone="info">Groq token usage is recorded, but cost is shown as $0 unless the server sets GROQ_PRICES, so the monthly budget does not limit Groq spend.</Notice>}
          <Toggle disabled={!editable} checked={s.ai.allowCodeSnippetsToAI} onChange={(v) => upd("ai", "allowCodeSnippetsToAI", v)} label="Allow relevant code snippets to be sent to the AI provider" />
          {editable && <div className="pt-1"><Button variant="primary" onClick={() => save("ai")}>Save</Button></div>}
        </div>
      )}
      {tab === "notifications" && (
        <div className="space-y-3">
          {[["analysisComplete", "Analysis completed"], ["criticalFindings", "Critical findings detected"], ["workflowApprovals", "Workflow approvals requested"], ["email", "Also send email (requires SMTP)"]].map(([k, l]) => <div key={k}><Toggle disabled={!editable} checked={s.notifications[k]} onChange={(v) => upd("notifications", k, v)} label={l} /></div>)}
          {editable && <div className="pt-1"><Button variant="primary" onClick={() => save("notifications")}>Save</Button></div>}
        </div>
      )}
      {tab === "retention" && (
        <div className="space-y-4">
          <Field label="Activity log retention (days)"><Input type="number" disabled={!editable} value={s.retention.activityDays} onChange={(e) => upd("retention", "activityDays", Number(e.target.value))} /></Field>
          <Field label="Job log retention (days)"><Input type="number" disabled={!editable} value={s.retention.jobLogDays} onChange={(e) => upd("retention", "jobLogDays", Number(e.target.value))} /></Field>
          <Field label="Repository chat retention (days)"><Input type="number" disabled={!editable} value={s.retention.chatDays} onChange={(e) => upd("retention", "chatDays", Number(e.target.value))} /></Field>
          {editable && <div className="pt-1"><Button variant="primary" onClick={() => save("retention")}>Save</Button></div>}
        </div>
      )}
    </Panel>
  );
}

export function HelpPage() {
  const caps = useQuery({ queryKey: ["capabilities"], queryFn: () => get("/system/capabilities") });
  return (
    <>
      <PageHeader eyebrow="Help" icon={<HelpCircle className="size-6 text-amber-deep" />} title="Help & system status" />
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Keyboard shortcuts"><div className="space-y-2 text-[13px]"><div className="flex justify-between"><span>Command palette & search</span><span className="kbd">⌘ K</span></div><div className="flex justify-between"><span>Close dialogs</span><span className="kbd">Esc</span></div><div className="flex justify-between"><span>Delete selected workflow node</span><span className="kbd">⌫</span></div></div></Panel>
        <Panel title="System status">
          {caps.data ? <div className="space-y-2 text-[13px]"><div>AI provider: <StatusBadge status={caps.data.ai.configured ? "connected" : "disconnected"} /> <span className="text-muted">{caps.data.ai.model}</span></div><div>Sandbox: <b>{caps.data.sandbox.mode}</b> <span className="text-muted">— {caps.data.sandbox.reason}</span></div><div className="flex flex-wrap gap-1.5">{Object.entries(caps.data.tools).map(([k, v]: any) => <Badge key={k} tone={v ? "success" : "neutral"}>{k}</Badge>)}</div></div> : <LoadingBlock rows={2} />}
        </Panel>
        <Panel title="How findings are labelled" className="lg:col-span-2">
          <ul className="space-y-2 text-[13px] text-ink-2">
            <li><Badge tone="success">Detected</Badge> — produced by a static analyzer or scanner, with the exact rule and evidence.</li>
            <li><Badge tone="info">AI hypothesis</Badge> — proposed by Claude; always verify before acting. Never counted in the health score.</li>
            <li>Findings that stop being detected are auto-resolved, but only by tools that actually ran successfully.</li>
            <li>Tests are reported as passing only after the runner executed them inside the sandbox and its report was parsed.</li>
          </ul>
        </Panel>
        <Panel title="Documentation" className="lg:col-span-2"><p className="flex items-center gap-2 text-[13px] text-muted"><BookOpen className="size-4" />Engineering documentation lives in the repository under <span className="font-mono">docs/</span>: PRODUCT_SPEC, ARCHITECTURE, DATABASE_SCHEMA, AGENT_SYSTEM, SECURITY, TESTING, IMPLEMENTATION_PLAN.</p></Panel>
      </div>
    </>
  );
}
export { Shield, Terminal };
