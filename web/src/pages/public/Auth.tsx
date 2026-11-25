import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { Mail, CheckCircle2, AlertTriangle } from "lucide-react";
import { Github } from "../../components/icons";
import { Button, Input, Field, Notice, Spinner } from "../../components/ui";
import { get, post, ApiError } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { Logo } from "./Site";
import { PearlFallback } from "../../components/three/Scene";

function AuthShell({ title, subtitle, children }: { title: string; subtitle?: ReactNode; children: ReactNode }) {
  return (
    <div className="pearl-canvas grid min-h-full md:grid-cols-[1fr_1.05fr]">
      <div className="flex flex-col px-6 py-8 md:px-14">
        <Logo />
        <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="mx-auto my-auto w-full max-w-sm py-10">
          <h1 className="text-[28px] font-semibold tracking-[-0.03em] text-ink">{title}</h1>
          {subtitle && <p className="mt-2 text-[14px] text-muted">{subtitle}</p>}
          <div className="mt-8">{children}</div>
        </motion.div>
      </div>
      <div className="relative hidden overflow-hidden border-l border-line bg-gradient-to-br from-white via-ivory to-amber-soft/30 md:block">
        <div className="absolute inset-0 opacity-90"><PearlFallback /></div>
        <div className="absolute bottom-10 left-10 right-10">
          <p className="font-display text-[34px] italic leading-tight text-ink">"Evidence on every finding."</p>
          <p className="mt-2 text-[13px] text-muted">DevForge never reports a scan, bug or passing test that didn't actually happen.</p>
        </div>
      </div>
    </div>
  );
}

function OAuthButtons() {
  const q = useQuery({ queryKey: ["providers"], queryFn: () => get<{ github: boolean; google: boolean }>("/auth/providers") });
  if (!q.data || (!q.data.github && !q.data.google)) return null;
  return (
    <div className="mb-6 space-y-2">
      {q.data.github && <a href="/api/auth/oauth/github/start"><Button className="w-full" icon={<Github className="size-4" />}>Continue with GitHub</Button></a>}
      {q.data.google && <a href="/api/auth/oauth/google/start"><Button className="mt-2 w-full" icon={<Mail className="size-4" />}>Continue with Google</Button></a>}
      <div className="flex items-center gap-3 py-2 text-[12px] text-faint"><span className="h-px flex-1 bg-line" />or<span className="h-px flex-1 bg-line" /></div>
    </div>
  );
}

const OAUTH_ERRORS: Record<string, string> = {
  github_not_configured: "GitHub sign-in is not configured on this server.",
  google_not_configured: "Google sign-in is not configured on this server.",
  oauth_state: "Sign-in session expired. Please try again.",
  oauth_failed: "Sign-in with the provider failed.",
};

export function LoginPage() {
  const nav = useNavigate();
  const [params] = useSearchParams();
  const { refresh } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState<string | null>(params.get("error") ? OAUTH_ERRORS[params.get("error")!] ?? "Sign-in failed" : null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await post("/auth/login", { email, password });
      await refresh();
      nav(params.get("next") ?? "/app");
    } catch (e: any) {
      setErr(e instanceof ApiError ? e.message : "Sign-in failed");
    } finally {
      setBusy(false);
    }
  };
  return (
    <AuthShell title="Welcome back" subtitle={<>New to DevForge? <Link to="/signup" className="font-medium text-amber-deep">Create an account</Link></>}>
      <OAuthButtons />
      <form onSubmit={submit} className="space-y-4">
        {err && <Notice tone="danger" icon={<AlertTriangle className="size-4 text-danger" />}>{err}</Notice>}
        <Field label="Email"><Input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" /></Field>
        <Field label="Password"><Input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
        <div className="flex justify-end"><Link to="/forgot-password" className="text-[12.5px] text-muted hover:text-ink">Forgot password?</Link></div>
        <Button variant="primary" className="w-full" size="lg" loading={busy} type="submit">Sign in</Button>
      </form>
    </AuthShell>
  );
}

export function SignupPage() {
  const nav = useNavigate();
  const [params] = useSearchParams();
  const { refresh } = useAuth();
  const [f, setF] = useState({ name: "", email: "", password: "" });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const strength = [/.{10,}/, /[a-zA-Z]/, /\d/, /[^a-zA-Z0-9]/, /.{14,}/].filter((r) => r.test(f.password)).length;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await post("/auth/register", { ...f, inviteToken: params.get("invite") ?? undefined });
      await refresh();
      nav("/onboarding");
    } catch (e: any) {
      setErr(e instanceof ApiError ? e.message : "Sign-up failed");
    } finally {
      setBusy(false);
    }
  };
  return (
    <AuthShell title="Create your account" subtitle={<>Already have one? <Link to="/login" className="font-medium text-amber-deep">Sign in</Link></>}>
      <OAuthButtons />
      <form onSubmit={submit} className="space-y-4">
        {err && <Notice tone="danger" icon={<AlertTriangle className="size-4 text-danger" />}>{err}</Notice>}
        <Field label="Full name"><Input required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} autoComplete="name" /></Field>
        <Field label="Work email"><Input type="email" required value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} autoComplete="email" /></Field>
        <Field label="Password" hint="At least 10 characters, with letters and numbers.">
          <Input type="password" required minLength={10} value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} autoComplete="new-password" />
          <div className="mt-2 flex gap-1">{[0, 1, 2, 3, 4].map((i) => <span key={i} className={`h-1 flex-1 rounded-full ${i < strength ? (strength >= 4 ? "bg-success" : "bg-amber") : "bg-line"}`} />)}</div>
        </Field>
        <Button variant="primary" className="w-full" size="lg" loading={busy} type="submit">Create account</Button>
        <p className="text-center text-[12px] text-faint">You'll verify your email after signing up.</p>
      </form>
    </AuthShell>
  );
}

export function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <AuthShell title="Reset your password" subtitle="We'll email you a reset link.">
      {sent ? (
        <Notice tone="success" icon={<CheckCircle2 className="size-4 text-success" />}>If an account exists for <b>{email}</b>, a reset link has been sent. It expires in one hour.</Notice>
      ) : (
        <form className="space-y-4" onSubmit={async (e) => { e.preventDefault(); setBusy(true); setErr(null); try { await post("/auth/forgot-password", { email }); setSent(true); } catch (e: any) { setErr(e.message); } finally { setBusy(false); } }}>
          {err && <Notice tone="danger">{err}</Notice>}
          <Field label="Email"><Input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
          <Button variant="primary" className="w-full" size="lg" loading={busy} type="submit">Send reset link</Button>
        </form>
      )}
      <p className="mt-6 text-center text-[13px]"><Link to="/login" className="text-muted hover:text-ink">Back to sign in</Link></p>
    </AuthShell>
  );
}

export function ResetPasswordPage() {
  const [params] = useSearchParams();
  const nav = useNavigate();
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const token = params.get("token") ?? "";
  return (
    <AuthShell title="Choose a new password">
      {!token ? <Notice tone="danger">This reset link is missing its token.</Notice> : done ? (
        <div className="space-y-4"><Notice tone="success">Password updated. All other sessions were signed out.</Notice><Button variant="primary" className="w-full" onClick={() => nav("/login")}>Sign in</Button></div>
      ) : (
        <form className="space-y-4" onSubmit={async (e) => { e.preventDefault(); setBusy(true); setErr(null); try { await post("/auth/reset-password", { token, password: pw }); setDone(true); } catch (e: any) { setErr(e.message); } finally { setBusy(false); } }}>
          {err && <Notice tone="danger">{err}</Notice>}
          <Field label="New password" hint="At least 10 characters, with letters and numbers."><Input type="password" required minLength={10} value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" /></Field>
          <Button variant="primary" className="w-full" size="lg" loading={busy} type="submit">Update password</Button>
        </form>
      )}
    </AuthShell>
  );
}

export function VerifyEmailPage() {
  const [params] = useSearchParams();
  const { refresh } = useAuth();
  const [state, setState] = useState<"working" | "ok" | "error">("working");
  const [msg, setMsg] = useState("");
  useEffect(() => {
    const token = params.get("token");
    if (!token) { setState("error"); setMsg("Missing verification token."); return; }
    post("/auth/verify-email/confirm", { token }).then(() => { setState("ok"); refresh(); }).catch((e) => { setState("error"); setMsg(e.message); });
  }, []);
  return (
    <AuthShell title="Email verification">
      {state === "working" && <div className="flex items-center gap-2 text-[14px] text-muted"><Spinner /> Verifying…</div>}
      {state === "ok" && <div className="space-y-4"><Notice tone="success" icon={<CheckCircle2 className="size-4 text-success" />}>Your email is verified.</Notice><Link to="/app"><Button variant="primary" className="w-full">Continue</Button></Link></div>}
      {state === "error" && <Notice tone="danger">{msg}</Notice>}
    </AuthShell>
  );
}

export function AcceptInvitePage() {
  const [params] = useSearchParams();
  const { me, refresh, switchWorkspace } = useAuth();
  const nav = useNavigate();
  const [err, setErr] = useState<string | null>(null);
  const token = params.get("token") ?? "";
  if (me === undefined) return <AuthShell title="Joining workspace"><Spinner /></AuthShell>;
  if (!me) return (
    <AuthShell title="You've been invited" subtitle="Create an account or sign in with the invited email address.">
      <div className="space-y-2"><Link to={`/signup?invite=${token}`}><Button variant="primary" className="w-full">Create account</Button></Link><Link to={`/login?next=${encodeURIComponent(`/accept-invite?token=${token}`)}`}><Button className="mt-2 w-full">Sign in</Button></Link></div>
    </AuthShell>
  );
  return (
    <AuthShell title="Join workspace" subtitle={`Signed in as ${me.user.email}`}>
      {err && <Notice tone="danger">{err}</Notice>}
      <Button variant="primary" className="mt-4 w-full" onClick={async () => { try { const r = await post("/auth/invitations/accept", { token }); await refresh(); await switchWorkspace(r.workspaceId); nav("/app"); } catch (e: any) { setErr(e.message); } }}>Accept invitation</Button>
    </AuthShell>
  );
}
