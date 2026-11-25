import { useState, type ReactNode } from "react";
import { Link, NavLink, Outlet, useLocation } from "react-router-dom";
import { motion } from "framer-motion";
import { ArrowRight, Bug, Search, ShieldCheck, GitPullRequest, FlaskConical, Network, Workflow, Bot, Boxes, Gauge, Layers, Lock, Server, KeyRound, FileSearch, Sparkles, Check, Menu, X, GitBranch, Eye, Cpu, ScrollText, Database, Terminal, BookOpen, ChevronRight } from "lucide-react";
import { Github } from "../../components/icons";
import { HeroScene } from "../../components/three/Scene";
import { Button, Badge, SeverityBadge, CodeBlock, cx } from "../../components/ui";
import { useAuth } from "../../lib/auth";

const fade = { initial: { opacity: 0, y: 18 }, whileInView: { opacity: 1, y: 0 }, viewport: { once: true, margin: "-80px" }, transition: { duration: 0.6, ease: [0.22, 1, 0.36, 1] } } as const;

export function Logo({ className }: { className?: string }) {
  return (
    <Link to="/" className={cx("flex items-center gap-2.5", className)} aria-label="DevForge AI home">
      <span className="relative grid size-8 place-items-center">
        <span className="absolute inset-0 rounded-full bg-[radial-gradient(circle_at_32%_28%,#fff_0%,#e9e6de_40%,#b5b0a4_100%)] shadow-[0_6px_14px_-6px_rgba(60,50,30,.5)]" />
        <span className="absolute inset-[-4px] rounded-full border-[1.5px] border-amber/80" style={{ transform: "rotateX(65deg) rotateZ(-25deg)" }} />
      </span>
      <span className="text-[16px] font-semibold tracking-[-0.02em] text-ink">DevForge<span className="text-amber-deep"> AI</span></span>
    </Link>
  );
}

const NAV = [
  { to: "/features", label: "Platform" },
  { to: "/agents", label: "Agents" },
  { to: "/how-it-works", label: "How it works" },
  { to: "/security", label: "Security" },
  { to: "/documentation", label: "Docs" },
  { to: "/pricing", label: "Pricing" },
];

export function SiteLayout() {
  const [open, setOpen] = useState(false);
  const { me } = useAuth();
  const loc = useLocation();
  return (
    <div className="pearl-canvas min-h-full">
      <header className="sticky top-0 z-40">
        <div className="mx-auto mt-3 flex max-w-6xl items-center justify-between rounded-2xl px-4 py-2.5 glass md:mx-auto md:px-5" style={{ marginInline: "max(12px, calc((100vw - 72rem)/2))" }}>
          <Logo />
          <nav className="hidden items-center gap-1 md:flex">
            {NAV.map((n) => (
              <NavLink key={n.to} to={n.to} className={({ isActive }) => cx("rounded-lg px-3 py-1.5 text-[13.5px] transition", isActive ? "text-ink bg-white/70" : "text-muted hover:text-ink")}>{n.label}</NavLink>
            ))}
          </nav>
          <div className="hidden items-center gap-2 md:flex">
            {me ? (
              <Link to="/app"><Button variant="primary" size="sm">Open workspace <ArrowRight className="size-3.5" /></Button></Link>
            ) : (
              <>
                <Link to="/login" className="px-2 text-[13.5px] text-ink-2 hover:text-ink">Sign in</Link>
                <Link to="/signup"><Button variant="primary" size="sm">Get started</Button></Link>
              </>
            )}
          </div>
          <button className="rounded-lg p-2 md:hidden" onClick={() => setOpen(!open)} aria-label="Menu">{open ? <X className="size-5" /> : <Menu className="size-5" />}</button>
        </div>
        {open && (
          <div className="glass-strong mx-3 mt-2 rounded-2xl p-3 md:hidden">
            {NAV.map((n) => <Link key={n.to} to={n.to} onClick={() => setOpen(false)} className="block rounded-lg px-3 py-2 text-[14px] text-ink-2 hover:bg-white">{n.label}</Link>)}
            <div className="mt-2 flex gap-2 border-t border-line pt-3">
              <Link to="/login" className="flex-1"><Button className="w-full">Sign in</Button></Link>
              <Link to="/signup" className="flex-1"><Button variant="primary" className="w-full">Get started</Button></Link>
            </div>
          </div>
        )}
      </header>
      <main key={loc.pathname}>
        <Outlet />
      </main>
      <Footer />
    </div>
  );
}

function Footer() {
  return (
    <footer className="mt-24 border-t border-line bg-white/40">
      <div className="mx-auto grid max-w-6xl gap-10 px-6 py-14 md:grid-cols-5">
        <div className="md:col-span-2">
          <Logo />
          <p className="mt-3 max-w-xs text-[13px] leading-relaxed text-muted">An autonomous engineering intelligence platform: repository analysis, security scanning, investigations, reviews, tests and agents — grounded in your code.</p>
        </div>
        {[
          ["Platform", [["Features", "/features"], ["AI agents", "/agents"], ["How it works", "/how-it-works"], ["Pricing", "/pricing"]]],
          ["Trust", [["Security", "/security"], ["Documentation", "/documentation"]]],
          ["Account", [["Sign in", "/login"], ["Create account", "/signup"], ["Reset password", "/forgot-password"]]],
        ].map(([h, links]: any) => (
          <div key={h}>
            <div className="mb-3 text-[12px] font-semibold uppercase tracking-[0.12em] text-ink-2">{h}</div>
            <ul className="space-y-2">{links.map(([l, to]: string[]) => <li key={to}><Link to={to} className="text-[13px] text-muted hover:text-ink">{l}</Link></li>)}</ul>
          </div>
        ))}
      </div>
      <div className="border-t border-line-2 py-5 text-center text-[12px] text-faint">© {new Date().getFullYear()} DevForge AI. Built for engineering teams.</div>
    </footer>
  );
}

function Section({ eyebrow, title, description, children, className, id }: { eyebrow?: string; title: ReactNode; description?: ReactNode; children?: ReactNode; className?: string; id?: string }) {
  return (
    <section id={id} className={cx("mx-auto max-w-6xl px-6 py-20", className)}>
      <motion.div {...fade} className="mb-10 max-w-2xl">
        {eyebrow && <div className="mb-3 text-[11.5px] font-semibold uppercase tracking-[0.16em] text-amber-deep">{eyebrow}</div>}
        <h2 className="text-[34px] font-semibold leading-[1.1] tracking-[-0.03em] text-ink md:text-[40px]">{title}</h2>
        {description && <p className="mt-4 text-[16px] leading-relaxed text-muted">{description}</p>}
      </motion.div>
      {children}
    </section>
  );
}

function Feature({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <motion.div {...fade} className="group panel p-6 transition hover:-translate-y-0.5 hover:shadow-[var(--shadow-float)]">
      <div className="mb-4 grid size-10 place-items-center rounded-xl bg-gradient-to-b from-white to-ivory text-amber-deep ring-1 ring-line">{icon}</div>
      <h3 className="text-[15px] font-semibold text-ink">{title}</h3>
      <p className="mt-2 text-[13.5px] leading-relaxed text-muted">{children}</p>
    </motion.div>
  );
}

// =============================================================== Landing
export function Landing() {
  return (
    <>
      {/* 1. Hero */}
      <section className="relative mx-auto grid max-w-6xl items-center gap-8 px-6 pb-10 pt-14 md:grid-cols-[1.05fr_1fr] md:pt-20">
        <motion.div initial={{ opacity: 0, y: 24 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.8, ease: [0.22, 1, 0.36, 1] }} className="relative z-10">
          <Badge tone="amber" className="mb-6"><Sparkles className="size-3" /> Autonomous software engineering intelligence</Badge>
          <h1 className="text-[44px] font-semibold leading-[1.02] tracking-[-0.04em] text-ink md:text-[62px]">
            Your AI Engineering Team.<br />
            <span className="font-display text-[50px] font-normal italic tracking-[-0.01em] text-amber-deep md:text-[70px]">Built Into Your Codebase.</span>
          </h1>
          <p className="mt-6 max-w-xl text-[16.5px] leading-relaxed text-muted">
            Understand your software deeply. Detect hidden bugs. Investigate root causes. Identify vulnerabilities. Generate tests. Verify fixes. DevForge AI brings an intelligent engineering team directly into your workflow.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link to="/signup"><Button variant="primary" size="lg">Analyze Your Repository <ArrowRight className="size-4" /></Button></Link>
            <Link to="/features"><Button size="lg">Explore the Platform</Button></Link>
          </div>
          <div className="mt-8 flex flex-wrap items-center gap-x-5 gap-y-2 text-[12.5px] text-muted">
            {["Real static analysis", "Sandboxed test execution", "Evidence on every finding"].map((t) => <span key={t} className="flex items-center gap-1.5"><Check className="size-3.5 text-success" />{t}</span>)}
          </div>
        </motion.div>
        <motion.div initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: 1.1, delay: 0.1 }} className="relative h-[420px] md:h-[560px]">
          <div className="absolute inset-[8%] rounded-full bg-[radial-gradient(circle,rgba(246,230,200,.7),transparent_65%)] blur-2xl" />
          <HeroScene />
        </motion.div>
      </section>

      {/* 2. Capabilities */}
      <Section eyebrow="Platform capabilities" title="One platform. The whole engineering loop." description="From the first look at an unfamiliar repository to a verified fix, every capability runs on real analysis of your code.">
        <div className="grid gap-4 md:grid-cols-3">
          <Feature icon={<Network className="size-5" />} title="Repository intelligence">AST parsing, symbol and route discovery, import and call graphs, frameworks and data models — indexed and searchable.</Feature>
          <Feature icon={<Bug className="size-5" />} title="Bug intelligence">Type checking, async misuse, dead code, broken imports, swallowed exceptions — each finding with evidence and a fix.</Feature>
          <Feature icon={<ShieldCheck className="size-5" />} title="Security center">Injection, XSS, secrets, insecure config and vulnerable dependencies via OSV.dev, npm audit and optional Semgrep, Gitleaks, Trivy.</Feature>
          <Feature icon={<FileSearch className="size-5" />} title="Root cause lab">Paste a stack trace. DevForge maps frames to code, walks call chains, gathers evidence and ranks hypotheses.</Feature>
          <Feature icon={<FlaskConical className="size-5" />} title="Test Forge">Branch and edge-case analysis, AI-generated tests, and execution inside an isolated sandbox — results are never assumed.</Feature>
          <Feature icon={<Bot className="size-5" />} title="Specialist agents">Ten agents with scoped tools, step limits and full execution logs — from Repository Analyst to Security Auditor.</Feature>
        </div>
      </Section>

      {/* 3. Repository intelligence */}
      <SplitSection
        eyebrow="Repository intelligence" title="Understand any codebase in minutes."
        points={["Language & framework detection", "Functions, classes, API routes and data models", "Import graph, call graph and circular dependency detection", "BM25 code search and repository Q&A with file:line citations"]}
        visual={
          <div className="panel overflow-hidden">
            <div className="flex items-center gap-2 border-b border-line-2 px-4 py-2.5 text-[12px] text-muted"><GitBranch className="size-3.5" /> src/api/orders.ts <Badge className="ml-auto">Illustrative</Badge></div>
            <CodeBlock language="typescript" startLine={18} highlightLines={[21]} code={`export async function listOrders(req, res) {\n  const user = await users.findById(req.userId);\n  const orders = await db.query(\n    \`SELECT * FROM orders WHERE owner = '\${user.id}'\`\n  );\n  res.json(orders);\n}`} />
            <div className="flex flex-wrap gap-2 border-t border-line-2 p-3 text-[12px]">
              <Badge tone="info">route GET /orders</Badge><Badge>called by 3 modules</Badge><Badge tone="danger">1 security finding</Badge>
            </div>
          </div>
        }
      />

      {/* 4. Bug investigation */}
      <SplitSection reverse
        eyebrow="AI bug investigation" title="From stack trace to root cause — with evidence."
        points={["Parses JS, Python and Go stack traces", "Maps frames to repository files and functions", "Correlates recent commits and existing findings", "Ranks hypotheses; AI conclusions are clearly labelled"]}
        visual={
          <div className="panel space-y-3 p-5">
            <div className="text-[12px] font-medium text-muted">Hypotheses · illustrative</div>
            {[["Null dereference in resolveCustomer", 0.78, "rule"], ["Missing await on cache.get()", 0.46, "ai"], ["Stale session payload", 0.21, "ai"]].map(([t, c, o]: any) => (
              <div key={t} className="rounded-xl border border-line p-3">
                <div className="flex items-center justify-between gap-2 text-[13px] font-medium text-ink">{t}<Badge tone={o === "ai" ? "info" : "success"}>{o === "ai" ? "AI hypothesis" : "Evidence-based"}</Badge></div>
                <div className="mt-2 h-1.5 rounded-full bg-ivory"><div className="h-full rounded-full bg-amber" style={{ width: `${c * 100}%` }} /></div>
              </div>
            ))}
          </div>
        }
      />

      {/* 5. Security */}
      <SplitSection
        eyebrow="Security intelligence" title="Real scanners. Real results. No theatre."
        points={["Built-in rules for injection, XSS, SSRF, path traversal, weak crypto", "Secret detection with values masked in every view", "Dependency vulnerabilities from OSV.dev and npm audit", "Scanners that aren't installed are shown as such — never faked"]}
        visual={
          <div className="panel divide-y divide-line-2">
            {[["critical", "AWS access key committed to repository", "config/deploy.ts:12"], ["high", "SQL built with string interpolation", "src/api/orders.ts:21"], ["medium", "TLS certificate verification disabled", "lib/http.py:44"], ["low", "Weak hash algorithm (MD5/SHA-1)", "utils/cache.js:9"]].map(([s, t, f]) => (
              <div key={t} className="flex items-center gap-3 px-4 py-3"><SeverityBadge severity={s} /><div className="min-w-0 flex-1"><div className="truncate text-[13px] font-medium text-ink">{t}</div><div className="font-mono text-[11.5px] text-muted">{f}</div></div></div>
            ))}
            <div className="px-4 py-2 text-[11px] text-faint">Illustrative example</div>
          </div>
        }
      />

      {/* 6/7. Code review + tests */}
      <Section eyebrow="Review & verification" title="Every change reviewed. Every fix verified.">
        <div className="grid gap-4 md:grid-cols-2">
          <motion.div {...fade} className="panel p-6">
            <GitPullRequest className="mb-4 size-6 text-amber-deep" />
            <h3 className="text-[18px] font-semibold text-ink">AI code review</h3>
            <p className="mt-2 text-[14px] leading-relaxed text-muted">Review commits, ranges, pull requests or snippets. Rule-based checks run on the changed lines; breaking-change and blast-radius analysis uses your dependency graph; Claude adds contextual review with suggested patches.</p>
          </motion.div>
          <motion.div {...fade} className="panel p-6">
            <FlaskConical className="mb-4 size-6 text-amber-deep" />
            <h3 className="text-[18px] font-semibold text-ink">Test generation & execution</h3>
            <p className="mt-2 text-[14px] leading-relaxed text-muted">Branches and edge cases are extracted statically; tests are generated for Vitest, Jest, Mocha or Pytest and executed in an isolated sandbox with no network and confined writes. Results are parsed, never assumed.</p>
          </motion.div>
        </div>
      </Section>

      {/* 8. Agent network */}
      <AgentNetworkSection />

      {/* 9. Workflow automation */}
      <SplitSection reverse
        eyebrow="Workflow automation" title="Compose your engineering process visually."
        points={["Drag-and-drop studio for scans, agents, tests, reviews", "Conditions over real results (e.g. security.critical > 0)", "Human approval gates and notifications", "Retries, error handling and full execution logs"]}
        visual={
          <div className="panel p-5">
            <div className="flex flex-wrap items-center gap-2 text-[12.5px]">
              {["Trigger", "Security scan", "Critical?", "Approval", "Notify", "Report"].map((s, i) => (
                <span key={s} className="flex items-center gap-2"><span className={cx("rounded-lg border px-3 py-1.5", i === 2 ? "border-amber/50 bg-amber-soft/50" : "border-line bg-white")}>{s}</span>{i < 5 && <ChevronRight className="size-3.5 text-faint" />}</span>
              ))}
            </div>
          </div>
        }
      />

      {/* 10. Interactive preview */}
      <PlatformPreview />

      {/* 11. Integrations */}
      <Section eyebrow="Integrations" title="Works with the tools you already trust." description="Use what's configured; everything else shows a clear disconnected state.">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {[[Github, "GitHub", "Repos, PRs, comments"], [Sparkles, "Claude", "Primary AI provider"], [Database, "OSV.dev", "Vulnerability data"], [Boxes, "npm audit", "Lockfile audit"], [ShieldCheck, "Semgrep", "Optional SAST"], [KeyRound, "Gitleaks", "Optional history scan"], [Layers, "Trivy", "Optional IaC scan"], [Terminal, "Docker / sandbox-exec", "Isolated execution"]].map(([I, n, d]: any) => (
            <motion.div {...fade} key={n} className="panel flex items-center gap-3 p-4"><I className="size-5 text-ink-2" /><div><div className="text-[13.5px] font-semibold text-ink">{n}</div><div className="text-[12px] text-muted">{d}</div></div></motion.div>
          ))}
        </div>
      </Section>

      {/* 12. Security & privacy */}
      <Section eyebrow="Security & privacy" title="Your code stays under your control.">
        <div className="grid gap-4 md:grid-cols-4">
          <Feature icon={<Lock className="size-5" />} title="Encrypted secrets">API keys and tokens are AES-256-GCM encrypted at rest and never shown after saving.</Feature>
          <Feature icon={<Server className="size-5" />} title="Sandboxed execution">Repository code never runs in the API process. Tests run with no network and confined writes.</Feature>
          <Feature icon={<Eye className="size-5" />} title="Scoped AI context">Only relevant snippets are sent to the model — never the whole repository.</Feature>
          <Feature icon={<ScrollText className="size-5" />} title="Full audit trail">Every scan, agent run, approval and setting change is recorded.</Feature>
        </div>
      </Section>

      {/* 13. CTA */}
      <section className="mx-auto max-w-6xl px-6 py-16">
        <motion.div {...fade} className="relative overflow-hidden rounded-[28px] border border-line bg-gradient-to-br from-white via-[#fbfaf6] to-amber-soft/40 p-10 text-center shadow-[var(--shadow-float)] md:p-16">
          <div className="amber-rule absolute inset-x-0 top-0" />
          <h2 className="text-[36px] font-semibold tracking-[-0.03em] text-ink md:text-[46px]">Meet your engineering team.</h2>
          <p className="mx-auto mt-3 max-w-xl text-[16px] text-muted">Connect a repository and get a real analysis in minutes.</p>
          <div className="mt-8 flex justify-center gap-3">
            <Link to="/signup"><Button variant="primary" size="lg">Analyze your repository <ArrowRight className="size-4" /></Button></Link>
            <Link to="/how-it-works"><Button size="lg">See how it works</Button></Link>
          </div>
        </motion.div>
      </section>
    </>
  );
}

function SplitSection({ eyebrow, title, points, visual, reverse }: { eyebrow: string; title: string; points: string[]; visual: ReactNode; reverse?: boolean }) {
  return (
    <section className="mx-auto grid max-w-6xl items-center gap-12 px-6 py-16 md:grid-cols-2">
      <motion.div {...fade} className={cx(reverse && "md:order-2")}>
        <div className="mb-3 text-[11.5px] font-semibold uppercase tracking-[0.16em] text-amber-deep">{eyebrow}</div>
        <h2 className="text-[32px] font-semibold leading-[1.12] tracking-[-0.03em] text-ink">{title}</h2>
        <ul className="mt-6 space-y-3">{points.map((p) => <li key={p} className="flex gap-3 text-[14.5px] text-ink-2"><span className="mt-1 grid size-4 shrink-0 place-items-center rounded-full bg-amber-soft"><Check className="size-3 text-amber-deep" /></span>{p}</li>)}</ul>
      </motion.div>
      <motion.div {...fade} className={cx(reverse && "md:order-1")}>{visual}</motion.div>
    </section>
  );
}

const AGENT_LIST = [
  ["Repository Analyst", Network], ["Bug Investigator", Bug], ["Root Cause Engineer", FileSearch], ["Security Auditor", ShieldCheck], ["Code Reviewer", GitPullRequest],
  ["Test Engineer", FlaskConical], ["Performance Engineer", Gauge], ["Architecture Analyst", Layers], ["Dependency Analyst", Boxes], ["Documentation Agent", BookOpen],
] as const;

function AgentNetworkSection() {
  return (
    <Section eyebrow="Agent network" title="Ten specialists. One coordinated team." description="Each agent has defined responsibilities, a tool allowlist, execution limits and complete logs. Agents hand off to each other when a task crosses specialities.">
      <div className="relative">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
          {AGENT_LIST.map(([n, I], i) => (
            <motion.div key={n} {...fade} transition={{ ...fade.transition, delay: i * 0.04 }} className="panel flex flex-col items-center gap-3 p-5 text-center">
              <div className="grid size-11 place-items-center rounded-full bg-[radial-gradient(circle_at_32%_28%,#fff,#ebe8e0_55%,#cfcabf)] ring-1 ring-line"><I className="size-5 text-ink-2" /></div>
              <div className="text-[13px] font-semibold text-ink">{n}</div>
            </motion.div>
          ))}
        </div>
      </div>
    </Section>
  );
}

function PlatformPreview() {
  const tabs = ["Command Center", "Findings", "Architecture"] as const;
  const [t, setT] = useState<(typeof tabs)[number]>("Command Center");
  return (
    <Section eyebrow="Platform preview" title="Designed for focus." description="A calm interface for serious engineering work. (Illustrative content.)">
      <div className="mb-4 flex gap-2">{tabs.map((x) => <button key={x} onClick={() => setT(x)} className={cx("rounded-full px-4 py-1.5 text-[13px] transition", t === x ? "bg-ink text-white" : "bg-white text-ink-2 ring-1 ring-line hover:ring-silver")}>{x}</button>)}</div>
      <motion.div key={t} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="glass-strong overflow-hidden rounded-[22px] p-2">
        <div className="grid min-h-[340px] grid-cols-[180px_1fr] overflow-hidden rounded-[16px] bg-pearl">
          <div className="hidden border-r border-line bg-white/60 p-3 md:block">
            {["Command Center", "Repository", "Architecture", "Bug Intelligence", "Security", "Agents", "Workflows"].map((n, i) => <div key={n} className={cx("mb-1 rounded-lg px-2.5 py-1.5 text-[12px]", (i === 0 && t === "Command Center") || (i === 3 && t === "Findings") || (i === 2 && t === "Architecture") ? "bg-white text-ink shadow-sm" : "text-muted")}>{n}</div>)}
          </div>
          <div className="col-span-2 p-5 md:col-span-1">
            {t === "Command Center" && (
              <div className="grid gap-3 md:grid-cols-3">
                {[["Repository health", "Computed from findings per KLOC"], ["Security posture", "Open security & dependency risk"], ["Agent activity", "Runs, handoffs, outcomes"]].map(([a, b]) => <div key={a} className="panel p-4"><div className="text-[12px] text-muted">{a}</div><div className="mt-3 h-2 w-2/3 rounded-full bg-ivory" /><div className="mt-2 text-[11.5px] text-faint">{b}</div></div>)}
                <div className="panel col-span-full h-32 p-4"><div className="text-[12px] text-muted">Findings opened vs resolved</div><svg viewBox="0 0 300 60" className="mt-3 h-16 w-full"><path d="M0 45 C40 40 60 20 100 25 S170 50 210 30 260 12 300 18" fill="none" stroke="#D99A28" strokeWidth="2" /><path d="M0 52 C50 50 90 44 130 40 S220 38 300 30" fill="none" stroke="#6B7F96" strokeWidth="2" /></svg></div>
              </div>
            )}
            {t === "Findings" && <div className="space-y-2">{[["high", "Async callback passed to forEach"], ["medium", "Exception silently swallowed"], ["medium", "Database call inside a loop (possible N+1)"], ["low", "Circular dependency between 3 modules"]].map(([s, x]) => <div key={x} className="panel flex items-center gap-3 px-4 py-3"><SeverityBadge severity={s} /><span className="text-[13px] text-ink">{x}</span></div>)}</div>}
            {t === "Architecture" && (
              <svg viewBox="0 0 400 220" className="h-full w-full">
                {[[60, 60, 200, 40], [60, 60, 200, 120], [200, 40, 330, 70], [200, 120, 330, 70], [200, 120, 300, 180], [60, 160, 200, 120]].map(([a, b, c, d], i) => <line key={i} x1={a} y1={b} x2={c} y2={d} stroke="#C9C6BD" />)}
                {[[60, 60, "api"], [200, 40, "services"], [200, 120, "db"], [330, 70, "models"], [300, 180, "cache"], [60, 160, "jobs"]].map(([x, y, l]: any) => <g key={l}><circle cx={x} cy={y} r="16" fill="white" stroke={l === "db" ? "#D99A28" : "#C9C6BD"} strokeWidth="1.5" /><text x={x} y={y + 32} textAnchor="middle" fontSize="11" fill="#77766F">{l}</text></g>)}
              </svg>
            )}
          </div>
        </div>
      </motion.div>
    </Section>
  );
}

// =============================================================== Sub-pages
function PageHero({ eyebrow, title, description }: { eyebrow: string; title: ReactNode; description: string }) {
  return (
    <section className="mx-auto max-w-4xl px-6 pb-4 pt-20 text-center">
      <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }}>
        <div className="mb-3 text-[11.5px] font-semibold uppercase tracking-[0.16em] text-amber-deep">{eyebrow}</div>
        <h1 className="text-[40px] font-semibold leading-[1.08] tracking-[-0.035em] text-ink md:text-[52px]">{title}</h1>
        <p className="mx-auto mt-5 max-w-2xl text-[16px] leading-relaxed text-muted">{description}</p>
      </motion.div>
    </section>
  );
}

export function FeaturesPage() {
  const groups: [string, ReactNode, string[]][] = [
    ["Repository Intelligence", <Network key="a" className="size-5" />, ["Git URL, GitHub and local import", "TypeScript/JavaScript AST via the TypeScript compiler", "Python AST via the standard library parser", "Symbols, routes (Express, Next.js, FastAPI, Flask), models (Prisma, SQL, ORMs)", "Import & call graphs; code search; repository Q&A"]],
    ["Bug Intelligence", <Bug key="b" className="size-5" />, ["TypeScript type checking", "Async misuse, swallowed exceptions, unreachable code", "Broken imports, unused imports/functions, duplicate keys", "Optional Ruff integration for Python", "Triage workflow: status, assignment, comments, history"]],
    ["Security Center", <ShieldCheck key="c" className="size-5" />, ["Injection, XSS, SSRF, path traversal, unsafe deserialization", "Secret detection (masked)", "OSV.dev + npm audit + optional pip-audit", "Optional Semgrep, Gitleaks and Trivy", "Per-scan tool status — nothing is faked"]],
    ["Investigation Lab", <FileSearch key="d" className="size-5" />, ["Stack trace parsing (JS, Python, Go…)", "Frame-to-file mapping and call chains", "Evidence: findings, commits, dependency paths", "Rule-based + AI hypotheses, ranked", "Proposed patch preview, never auto-applied"]],
    ["Code Review", <GitPullRequest key="e" className="size-5" />, ["Commits, ranges, pull requests, snippets", "Rules on changed lines only", "Breaking-change & blast-radius detection", "Suggested reviewers from git history", "Markdown export; optional PR comment"]],
    ["Test Forge", <FlaskConical key="f" className="size-5" />, ["Branch & edge-case extraction", "Vitest, Jest, Mocha, Playwright, Pytest", "Sandboxed execution (sandbox-exec / Docker)", "Result parsing & failure analysis", "History of every run"]],
    ["Agents & Workflows", <Workflow key="g" className="size-5" />, ["10 specialist agents with tool allowlists", "Execution limits, logs, handoffs", "Visual workflow studio with conditions & approvals", "Notifications (in-app, Slack, webhook)", "Reports generated from real data"]],
    ["Analytics & Governance", <Gauge key="h" className="size-5" />, ["Health, security and debt trends", "Agent and AI usage/cost tracking", "Activity & audit log with filters", "Roles: Owner, Admin, Engineer, Security, Viewer", "Workspace isolation enforced server-side"]],
  ];
  return (
    <>
      <PageHero eyebrow="Platform" title="Everything an engineering team needs to understand, secure and improve software." description="Each module runs on real analysis of your repository. Where a capability depends on credentials or an optional tool, DevForge tells you exactly what's missing." />
      <section className="mx-auto grid max-w-6xl gap-4 px-6 py-12 md:grid-cols-2">
        {groups.map(([t, i, items]) => (
          <motion.div {...fade} key={t} className="panel p-6">
            <div className="flex items-center gap-3"><span className="grid size-9 place-items-center rounded-xl bg-amber-soft/60 text-amber-deep">{i}</span><h3 className="text-[16px] font-semibold text-ink">{t}</h3></div>
            <ul className="mt-4 space-y-2">{items.map((x) => <li key={x} className="flex gap-2.5 text-[13.5px] text-ink-2"><Check className="mt-0.5 size-3.5 shrink-0 text-success" />{x}</li>)}</ul>
          </motion.div>
        ))}
      </section>
    </>
  );
}

export function AgentsPage() {
  const roles: Record<string, string> = {
    "Repository Analyst": "Maps entry points, modules, APIs and data models for fast onboarding.",
    "Bug Investigator": "Runs bug analysis, confirms defects by reading code, records labelled hypotheses.",
    "Root Cause Engineer": "Traces callers and dependencies to rank root-cause hypotheses.",
    "Security Auditor": "Runs security and dependency scans; prioritises by exploitability.",
    "Code Reviewer": "Reviews complex modules for correctness, security and maintainability.",
    "Test Engineer": "Finds risky untested code and queues Test Forge runs.",
    "Performance Engineer": "Finds N+1 queries, blocking I/O and quadratic loops — no invented benchmarks.",
    "Architecture Analyst": "Evaluates coupling, cycles and hotspots; proposes refactors.",
    "Dependency Analyst": "Inventories packages; flags vulnerable, outdated and license-risky ones.",
    "Documentation Agent": "Writes architecture docs from code and saves them to the Knowledge Base.",
  };
  return (
    <>
      <PageHero eyebrow="AI agents" title="A virtual engineering team with real tools." description="Agents call DevForge's analysis tools — search, symbol lookup, call graph, scanners, Test Forge — within explicit permissions and limits. Without an AI provider they still execute a deterministic playbook and report exact tool output." />
      <section className="mx-auto grid max-w-6xl gap-4 px-6 py-12 md:grid-cols-2">
        {AGENT_LIST.map(([n, I]) => (
          <motion.div {...fade} key={n} className="panel flex gap-4 p-5">
            <div className="grid size-11 shrink-0 place-items-center rounded-full bg-[radial-gradient(circle_at_32%_28%,#fff,#ebe8e0_55%,#cfcabf)] ring-1 ring-line"><I className="size-5 text-ink-2" /></div>
            <div><h3 className="text-[15px] font-semibold text-ink">{n}</h3><p className="mt-1 text-[13.5px] leading-relaxed text-muted">{roles[n]}</p></div>
          </motion.div>
        ))}
      </section>
    </>
  );
}

export function HowItWorksPage() {
  const steps = [
    ["Connect", "Import from a Git URL or GitHub. Clones are validated (https, allow-listed hosts, no private addresses) and hooks are disabled.", GitBranch],
    ["Index", "Files are parsed into ASTs; symbols, routes, models, imports and calls are stored and full-text indexed.", Cpu],
    ["Analyse", "Bug, security, dependency, performance and debt analyzers run. Each finding records tool, rule, evidence and fix.", Search],
    ["Investigate & review", "Investigations map incidents to code; reviews analyse diffs; Claude adds hypotheses that are always labelled.", FileSearch],
    ["Verify", "Tests are generated and executed in an isolated sandbox; results are parsed from the runner's own report.", FlaskConical],
    ["Automate", "Agents and workflows chain the steps with conditions, approvals, notifications and reports.", Workflow],
  ] as const;
  return (
    <>
      <PageHero eyebrow="How it works" title="From repository to verified insight." description="A transparent pipeline. Every step is logged and every result is traceable to its source." />
      <section className="mx-auto max-w-3xl px-6 py-12">
        {steps.map(([t, d, I], i) => (
          <motion.div {...fade} key={t} className="relative flex gap-5 pb-10">
            <div className="flex flex-col items-center"><div className="grid size-11 place-items-center rounded-full bg-white ring-1 ring-line shadow-[var(--shadow-pearl)]"><I className="size-5 text-amber-deep" /></div>{i < steps.length - 1 && <div className="mt-2 w-px flex-1 bg-line" />}</div>
            <div className="pt-2"><div className="text-[12px] font-semibold text-faint">Step {i + 1}</div><h3 className="text-[18px] font-semibold text-ink">{t}</h3><p className="mt-1.5 text-[14px] leading-relaxed text-muted">{d}</p></div>
          </motion.div>
        ))}
      </section>
    </>
  );
}

export function SecurityPage() {
  const items = [
    ["Authentication", "scrypt password hashing, httpOnly SameSite cookies, session expiry, login throttling and temporary lockout, email verification, password reset with single-use tokens."],
    ["Authorization", "Five roles enforced on every API route; workspace isolation is checked server-side on every request."],
    ["Secrets", "Integration keys are encrypted with AES-256-GCM; only the last four characters are ever displayed; logs redact secret patterns."],
    ["Repository safety", "https-only clones, host allowlist, DNS checks against private ranges (SSRF), disabled git hooks, no symlink following, size limits."],
    ["Code execution", "Never in the API process. Tests run in macOS sandbox-exec or Docker with no network, confined writes and stripped environment."],
    ["AI usage", "Token-bounded context of relevant snippets only; per-workspace rate limits and monthly budget; AI output is labelled and patches are never auto-applied."],
    ["Web protections", "CSRF header requirement and origin checks, security headers, JSON size limits, CSV formula-injection neutralisation."],
    ["Audit", "Logins, scans, agent runs, approvals, exports and settings changes are recorded in the activity log."],
  ];
  return (
    <>
      <PageHero eyebrow="Security" title="Built like the security tool it is." description="DevForge handles source code and credentials. These are the controls it enforces." />
      <section className="mx-auto grid max-w-5xl gap-4 px-6 py-12 md:grid-cols-2">
        {items.map(([t, d]) => <motion.div {...fade} key={t} className="panel p-6"><div className="flex items-center gap-2"><Lock className="size-4 text-amber-deep" /><h3 className="text-[15px] font-semibold text-ink">{t}</h3></div><p className="mt-2 text-[13.5px] leading-relaxed text-muted">{d}</p></motion.div>)}
      </section>
    </>
  );
}

export function DocsPage() {
  const sections: [string, string][] = [
    ["Quick start", "1. Create an account and a workspace.\n2. Connect a repository by Git URL (or GitHub after connecting a token).\n3. Choose an analysis preset: Quick, Full, Security or Architecture.\n4. Watch indexing and scans progress live, then explore findings."],
    ["AI provider", "Add an Anthropic API key in Settings → AI Providers, or set ANTHROPIC_API_KEY on the server. Without a key, all static analysis, scanning, agents (deterministic playbooks) and workflows still work; AI hypotheses, AI review, test code generation and Q&A answers are disabled."],
    ["Optional scanners", "Install semgrep, gitleaks, trivy, ruff or pip-audit on the server to enable them. Each scan reports per-tool status (ok, not installed, failed)."],
    ["Sandbox", "Test execution uses Docker when available, otherwise macOS sandbox-exec. Set SANDBOX_MODE=disabled to turn execution off. Generated tests are never reported as passing unless they ran."],
    ["GitHub", "Connect a personal access token in Integrations (or configure GitHub OAuth) to import private repositories, sync pull requests and post review comments."],
    ["Roles", "Owner and Admin manage the workspace, members, settings and integrations. Engineers import repositories and run analyses/tests. Security can run scans and decide approvals. Viewers have read-only access."],
  ];
  return (
    <>
      <PageHero eyebrow="Documentation" title="Get productive quickly." description="The essentials for running DevForge AI. Full engineering docs live in the repository's docs/ directory." />
      <section className="mx-auto max-w-4xl space-y-4 px-6 py-12">
        {sections.map(([t, d]) => <motion.div {...fade} key={t} className="panel p-6"><h3 className="text-[16px] font-semibold text-ink">{t}</h3><p className="mt-2 whitespace-pre-line text-[14px] leading-relaxed text-muted">{d}</p></motion.div>)}
      </section>
    </>
  );
}

export function PricingPage() {
  const plans = [
    { name: "Self-hosted", price: "Free", note: "Run DevForge on your own infrastructure", features: ["All analysis modules", "Unlimited repositories", "Bring your own Claude API key", "Community support"], cta: "Get started", to: "/signup", featured: false },
    { name: "Team", price: "Contact us", note: "Managed deployment for engineering teams", features: ["Everything in Self-hosted", "Managed sandbox runners", "SSO via GitHub / Google OAuth", "Priority support"], cta: "Talk to us", to: "/signup", featured: true },
    { name: "Enterprise", price: "Custom", note: "For regulated environments", features: ["Dedicated deployment", "Custom retention policies", "Audit exports", "Security review support"], cta: "Contact sales", to: "/signup", featured: false },
  ];
  return (
    <>
      <PageHero eyebrow="Pricing" title="Start free. Scale with your team." description="AI usage is billed by your AI provider directly through your own API key; DevForge tracks token usage and cost per workspace." />
      <section className="mx-auto grid max-w-5xl gap-4 px-6 py-12 md:grid-cols-3">
        {plans.map((p) => (
          <motion.div {...fade} key={p.name} className={cx("panel relative flex flex-col p-6", p.featured && "ring-2 ring-amber/50")}>
            {p.featured && <Badge tone="amber" className="absolute -top-2.5 left-6">Most popular</Badge>}
            <h3 className="text-[15px] font-semibold text-ink">{p.name}</h3>
            <div className="mt-3 text-[30px] font-semibold tracking-[-0.03em] text-ink">{p.price}</div>
            <p className="mt-1 text-[13px] text-muted">{p.note}</p>
            <ul className="mt-5 flex-1 space-y-2">{p.features.map((f) => <li key={f} className="flex gap-2 text-[13.5px] text-ink-2"><Check className="mt-0.5 size-3.5 text-success" />{f}</li>)}</ul>
            <Link to={p.to} className="mt-6"><Button variant={p.featured ? "primary" : "secondary"} className="w-full">{p.cta}</Button></Link>
          </motion.div>
        ))}
      </section>
    </>
  );
}
