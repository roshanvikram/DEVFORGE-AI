import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { motion, AnimatePresence } from "framer-motion";
import { ArrowLeft, ArrowRight, Check, Zap, ScanSearch, ShieldCheck, Layers, Sparkles, Lock } from "lucide-react";
import { Github } from "../components/icons";
import { Button, Input, Field, Notice, ProgressBar, Select, Toggle, Badge, cx, StatusBadge } from "../components/ui";
import { get, post, put, patch, setWorkspaceId } from "../lib/api";
import { useAuth } from "../lib/auth";
import { Logo } from "./public/Site";

const STEPS = ["Welcome", "Workspace", "GitHub", "Repository", "Analysis", "AI", "Indexing", "Progress", "Done"];
const PRESETS = [
  { id: "quick", label: "Quick Scan", icon: Zap, desc: "Bugs, security patterns and tech debt. Fastest." },
  { id: "full", label: "Full Repository Analysis", icon: ScanSearch, desc: "All analyzers including dependencies (OSV) and performance." },
  { id: "security", label: "Security Audit", icon: ShieldCheck, desc: "Security patterns, secrets and dependency vulnerabilities." },
  { id: "architecture", label: "Architecture Analysis", icon: Layers, desc: "Index, dependency graph, cycles and structural debt." },
];

export default function Onboarding() {
  const { me, refresh, workspace } = useAuth();
  const nav = useNavigate();
  const [step, setStep] = useState(me?.onboarding.step ?? 1);
  const [data, setData] = useState<Record<string, any>>(me?.onboarding.data ?? {});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const save = async (s: number, d = data, completed = false) => {
    setStep(s);
    setData(d);
    await put("/onboarding", { step: s, data: d, completed }).catch(() => {});
  };
  const next = (d: Record<string, any> = {}) => save(Math.min(step + 1, 9), { ...data, ...d });
  const back = () => save(Math.max(step - 1, 1));
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setErr(null);
    try { await fn(); } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };

  return (
    <div className="pearl-canvas min-h-full">
      <div className="mx-auto flex max-w-3xl items-center justify-between px-6 pt-8">
        <Logo />
        <button className="text-[13px] text-muted hover:text-ink" onClick={() => run(async () => { await save(step, data, true); await refresh(); nav("/app"); })}>Skip for now</button>
      </div>
      <div className="mx-auto max-w-3xl px-6 pt-10">
        <div className="mb-2 flex justify-between text-[12px] text-muted"><span>Step {step} of 9 · {STEPS[step - 1]}</span><span>{Math.round(((step - 1) / 8) * 100)}%</span></div>
        <ProgressBar value={(step - 1) / 8} />
      </div>
      <div className="mx-auto max-w-3xl px-6 py-10">
        <AnimatePresence mode="wait">
          <motion.div key={step} initial={{ opacity: 0, x: 16 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -16 }} transition={{ duration: 0.25 }} className="glass-strong rounded-[22px] p-8">
            {err && <div className="mb-5"><Notice tone="danger">{err}</Notice></div>}
            {step === 1 && (
              <div>
                <h1 className="text-[30px] font-semibold tracking-[-0.03em] text-ink">Welcome, {me?.user.name.split(" ")[0]}.</h1>
                <p className="mt-3 max-w-lg text-[15px] leading-relaxed text-muted">In a few steps you'll connect a repository and get a real analysis: indexed code, findings with evidence, and an engineering team of agents ready to help.</p>
                {!me?.user.email_verified_at && <div className="mt-5"><Notice tone="amber">Check your inbox to verify <b>{me?.user.email}</b>. (In development without SMTP, emails are written to the server's data/outbox folder.)</Notice></div>}
                <div className="mt-8 flex justify-end"><Button variant="primary" onClick={() => next()}>Let's begin <ArrowRight className="size-4" /></Button></div>
              </div>
            )}
            {step === 2 && <WorkspaceStep busy={busy} existing={workspace?.name} onNext={(name) => run(async () => {
              if (!workspace) {
                const r = await post("/workspaces", { name });
                setWorkspaceId(r.id);
                await refresh();
              }
              await next({ workspaceName: name });
            })} onBack={back} />}
            {step === 3 && <GithubStep busy={busy} onNext={(token) => run(async () => { if (token) await put("/integrations/github", { secret: token, config: {} }); await next({ github: !!token }); })} onBack={back} />}
            {step === 4 && <RepoStep data={data} onNext={(d) => next(d)} onBack={back} />}
            {step === 5 && (
              <div>
                <h2 className="text-[22px] font-semibold tracking-[-0.02em] text-ink">Configure analysis</h2>
                <p className="mt-2 text-[14px] text-muted">You can run any analysis later from the repository page.</p>
                <div className="mt-6 grid gap-3 md:grid-cols-2">
                  {PRESETS.map((p) => (
                    <button key={p.id} onClick={() => setData({ ...data, preset: p.id })} className={cx("rounded-2xl border bg-white p-4 text-left transition", (data.preset ?? "full") === p.id ? "border-amber ring-4 ring-amber-soft/60" : "border-line hover:border-silver")}>
                      <p.icon className="size-5 text-amber-deep" />
                      <div className="mt-3 text-[14px] font-semibold text-ink">{p.label}</div>
                      <div className="mt-1 text-[12.5px] leading-relaxed text-muted">{p.desc}</div>
                    </button>
                  ))}
                </div>
                <Nav onBack={back} onNext={() => next({ preset: data.preset ?? "full" })} />
              </div>
            )}
            {step === 6 && <AIStep busy={busy} canManage={!!workspace?.permissions.includes("settings.manage")} onBack={back} onNext={(cfg) => run(async () => {
              if (workspace?.permissions.includes("settings.manage")) await patch("/settings", { ai: { model: cfg.model, effort: cfg.effort, allowCodeSnippetsToAI: cfg.allow } });
              if (cfg.key) await put("/integrations/anthropic", { secret: cfg.key, config: {} });
              await next({ ai: { model: cfg.model, effort: cfg.effort } });
            })} />}
            {step === 7 && (
              <div>
                <h2 className="text-[22px] font-semibold tracking-[-0.02em] text-ink">Ready to index</h2>
                <div className="mt-5 space-y-2 text-[14px] text-ink-2">
                  <Row k="Workspace" v={workspace?.name ?? data.workspaceName} />
                  <Row k="Repository" v={data.repoUrl} />
                  <Row k="Analysis" v={PRESETS.find((p) => p.id === (data.preset ?? "full"))?.label} />
                </div>
                <Notice tone="info" icon={<Lock className="size-4 text-info" />}><span className="mt-4 block">The repository is cloned into DevForge's storage with git hooks disabled. Nothing in it is executed during analysis.</span></Notice>
                <Nav onBack={back} nextLabel="Start indexing" busy={busy} onNext={() => run(async () => {
                  const r = await post("/repositories", { source: data.source ?? "git", url: data.repoUrl, preset: data.preset ?? "full" });
                  localStorage.setItem("df.repo", r.id);
                  await next({ repositoryId: r.id, jobId: r.jobId });
                })} />
              </div>
            )}
            {step === 8 && <ProgressStep jobId={data.jobId} onDone={() => next()} onBack={() => save(4)} />}
            {step === 9 && (
              <div className="text-center">
                <div className="mx-auto grid size-14 place-items-center rounded-full bg-success-soft"><Check className="size-7 text-success" /></div>
                <h2 className="mt-5 text-[26px] font-semibold tracking-[-0.03em] text-ink">Your workspace is ready.</h2>
                <p className="mt-2 text-[14px] text-muted">Findings, architecture and agents are waiting in the Command Center.</p>
                <Button variant="primary" size="lg" className="mt-8" loading={busy} onClick={() => run(async () => { await save(9, data, true); await refresh(); nav("/app"); })}>Enter DevForge <ArrowRight className="size-4" /></Button>
              </div>
            )}
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}

const Row = ({ k, v }: { k: string; v?: string }) => <div className="flex justify-between border-b border-line-2 py-2"><span className="text-muted">{k}</span><span className="max-w-[60%] truncate font-medium text-ink">{v ?? "—"}</span></div>;
function Nav({ onBack, onNext, nextLabel = "Continue", busy, disabled }: { onBack: () => void; onNext: () => void; nextLabel?: string; busy?: boolean; disabled?: boolean }) {
  return (
    <div className="mt-8 flex justify-between">
      <Button variant="ghost" onClick={onBack}><ArrowLeft className="size-4" /> Back</Button>
      <Button variant="primary" onClick={onNext} loading={busy} disabled={disabled}>{nextLabel} <ArrowRight className="size-4" /></Button>
    </div>
  );
}

function WorkspaceStep({ busy, existing, onNext, onBack }: { busy: boolean; existing?: string; onNext: (n: string) => void; onBack: () => void }) {
  const [name, setName] = useState(existing ?? "");
  return (
    <div>
      <h2 className="text-[22px] font-semibold tracking-[-0.02em] text-ink">{existing ? "Your workspace" : "Create a workspace"}</h2>
      <p className="mt-2 text-[14px] text-muted">Workspaces hold repositories, findings and team members. Access is isolated per workspace.</p>
      <div className="mt-6"><Field label="Workspace name"><Input value={name} onChange={(e) => setName(e.target.value)} disabled={!!existing} placeholder="Acme Engineering" autoFocus /></Field></div>
      <Nav onBack={onBack} onNext={() => onNext(name)} busy={busy} disabled={name.trim().length < 2} />
    </div>
  );
}

function GithubStep({ busy, onNext, onBack }: { busy: boolean; onNext: (t: string | null) => void; onBack: () => void }) {
  const [token, setToken] = useState("");
  return (
    <div>
      <h2 className="flex items-center gap-2 text-[22px] font-semibold tracking-[-0.02em] text-ink"><Github className="size-5" /> Connect GitHub <Badge>Optional</Badge></h2>
      <p className="mt-2 text-[14px] text-muted">Needed for private repositories and pull-request intelligence. Public repositories work without it.</p>
      <div className="mt-6"><Field label="Personal access token" hint="Fine-grained token with Contents and Pull requests read access. Stored encrypted; never shown again."><Input type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="github_pat_…" autoComplete="off" /></Field></div>
      <div className="mt-8 flex justify-between">
        <Button variant="ghost" onClick={onBack}><ArrowLeft className="size-4" /> Back</Button>
        <div className="flex gap-2"><Button onClick={() => onNext(null)}>Skip</Button><Button variant="primary" loading={busy} disabled={token.length < 10} onClick={() => onNext(token)}>Verify & connect</Button></div>
      </div>
    </div>
  );
}

function RepoStep({ data, onNext, onBack }: { data: any; onNext: (d: any) => void; onBack: () => void }) {
  const [url, setUrl] = useState(data.repoUrl ?? "");
  const gh = useQuery({ queryKey: ["gh-repos"], queryFn: () => get("/github/repos"), retry: false });
  return (
    <div>
      <h2 className="text-[22px] font-semibold tracking-[-0.02em] text-ink">Select a repository</h2>
      <p className="mt-2 text-[14px] text-muted">Paste an https Git URL, or pick from your GitHub repositories.</p>
      <div className="mt-6"><Field label="Repository URL"><Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://github.com/owner/repo" /></Field></div>
      {gh.data?.connected && (
        <div className="scroll-thin mt-4 max-h-56 overflow-y-auto rounded-xl border border-line bg-white">
          {gh.data.items.map((r: any) => (
            <button key={r.full_name} onClick={() => setUrl(r.url)} className={cx("flex w-full items-center justify-between border-b border-line-2 px-3 py-2 text-left text-[13px] hover:bg-ivory", url === r.url && "bg-amber-soft/40")}>
              <span className="font-medium text-ink">{r.full_name}</span><span className="flex gap-2">{r.private && <Badge>private</Badge>}{r.language && <Badge>{r.language}</Badge>}</span>
            </button>
          ))}
        </div>
      )}
      <div className="mt-3 flex flex-wrap gap-2 text-[12px] text-muted">Try:{["https://github.com/expressjs/cors", "https://github.com/pallets/itsdangerous"].map((u) => <button key={u} className="rounded-full bg-white px-2.5 py-0.5 ring-1 ring-line hover:ring-silver" onClick={() => setUrl(u)}>{u.replace("https://github.com/", "")}</button>)}</div>
      <Nav onBack={onBack} onNext={() => onNext({ repoUrl: url.trim(), source: /github\.com/.test(url) && gh.data?.connected ? "github" : "git" })} disabled={!/^https:\/\/.+\/.+/.test(url.trim())} />
    </div>
  );
}

function AIStep({ busy, canManage, onNext, onBack }: { busy: boolean; canManage: boolean; onNext: (c: { model: string; effort: string; key: string; allow: boolean }) => void; onBack: () => void }) {
  const st = useQuery({ queryKey: ["settings"], queryFn: () => get("/settings") });
  const [model, setModel] = useState("claude-opus-5-5");
  const [effort, setEffort] = useState("medium");
  const [allow, setAllow] = useState(true);
  const [key, setKey] = useState("");
  useEffect(() => {
    if (st.data) { setModel(st.data.settings.ai.model); setEffort(st.data.settings.ai.effort); setAllow(st.data.settings.ai.allowCodeSnippetsToAI); }
  }, [st.data]);
  return (
    <div>
      <h2 className="flex items-center gap-2 text-[22px] font-semibold tracking-[-0.02em] text-ink"><Sparkles className="size-5 text-amber-deep" /> AI preferences</h2>
      <p className="mt-2 text-[14px] text-muted">An AI provider (Anthropic Claude or Groq) powers hypotheses, reviews, test generation, agents and Q&A. Connect one in Integrations; all static analysis works without it.</p>
      <div className="mt-4 flex items-center gap-2">{st.data?.ai.configured ? <><StatusBadge status="connected" /><span className="text-[12.5px] text-muted">{st.data.ai.provider === "groq" ? "Groq" : "Claude"} · {st.data.ai.model}</span></> : <Badge>Not configured</Badge>}</div>
      <div className="mt-5 grid gap-4 md:grid-cols-2">
        <Field label="Claude model"><Select className="w-full" value={model} onChange={(e) => setModel(e.target.value)} disabled={!canManage}>{(st.data?.models ?? ["claude-opus-5-5"]).map((m: string) => <option key={m}>{m}</option>)}</Select></Field>
        <Field label="Reasoning effort"><Select className="w-full" value={effort} onChange={(e) => setEffort(e.target.value)} disabled={!canManage}>{["low", "medium", "high", "xhigh", "max"].map((m) => <option key={m}>{m}</option>)}</Select></Field>
      </div>
      {!st.data?.ai.configured && canManage && <div className="mt-4"><Field label="Anthropic API key (optional)" hint="Verified, then encrypted at rest. Never displayed again."><Input type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder="sk-ant-…" autoComplete="off" /></Field></div>}
      <div className="mt-5"><Toggle checked={allow} onChange={setAllow} disabled={!canManage} label="Allow relevant code snippets to be sent to the AI provider" /></div>
      <Nav onBack={onBack} busy={busy} onNext={() => onNext({ model, effort, key, allow })} />
    </div>
  );
}

function ProgressStep({ jobId, onDone, onBack }: { jobId: string; onDone: () => void; onBack: () => void }) {
  const q = useQuery({ queryKey: ["job", jobId], queryFn: () => get(`/jobs/${jobId}`), enabled: !!jobId, refetchInterval: (qq) => (["completed", "failed", "cancelled"].includes((qq.state.data as any)?.status) ? false : 1200) });
  const j = q.data;
  return (
    <div>
      <h2 className="text-[22px] font-semibold tracking-[-0.02em] text-ink">Analysing your repository</h2>
      <div className="mt-5 flex items-center justify-between text-[13px]"><span className="text-muted">{j?.message ?? "Queued"}</span>{j && <StatusBadge status={j.status} />}</div>
      <ProgressBar value={j?.progress ?? 0} className="mt-3" />
      <div className="scroll-thin mt-5 h-56 overflow-y-auto rounded-xl border border-line bg-[#FCFBF8] p-3 font-mono text-[11.5px] leading-relaxed text-ink-2">
        {(j?.logs ?? []).map((l: any, i: number) => <div key={i} className={l.level === "error" ? "text-danger" : l.level === "warn" ? "text-amber-deep" : ""}>{l.message}</div>)}
      </div>
      {j?.status === "failed" && <div className="mt-4"><Notice tone="danger">{j.error}</Notice></div>}
      <div className="mt-8 flex justify-between">
        <Button variant="ghost" onClick={onBack}><ArrowLeft className="size-4" /> Change repository</Button>
        <Button variant="primary" disabled={j?.status !== "completed"} onClick={onDone}>Continue <ArrowRight className="size-4" /></Button>
      </div>
    </div>
  );
}
