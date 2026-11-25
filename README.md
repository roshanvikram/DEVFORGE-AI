# DevForge AI

An autonomous software-engineering platform: connect a repository and DevForge indexes it, finds bugs, security issues, vulnerable dependencies, performance problems and technical debt, investigates incidents, reviews commits, runs and generates tests in a sandbox, and lets AI agents and workflows act on the results. Every number in the UI comes from a real scan, run or measurement — nothing is simulated.

▶ **[Watch the testing walkthrough](docs/media/devforge-testing-walkthrough.mp4)** (55 s): health score, quality gates, Live Ops streaming, auto-sync, signed webhooks and the automated test results.

## Quick start

Requirements: **Node 22+**, **git**, **Python 3** (for Python analysis). Optional: Docker (sandbox on Linux), `ruff`, `semgrep`, `gitleaks`, `trivy`, `pip-audit` (extra scanners are used when installed).

```bash
npm install
cp server/.env.example server/.env   # optional — sensible defaults work for local use
npm run dev                          # API on :4000, web app on :5173
```

Open http://localhost:5173, create an account, and follow onboarding to connect a repository (any public GitHub/GitLab/Bitbucket/Codeberg URL).

### Enable AI features

Connect an AI provider: **Anthropic Claude** (API key starting `sk-ant-api…`) or **Groq** (key starting `gsk_…`). Add it in **Integrations** (verified with the provider, stored encrypted per workspace) or as `ANTHROPIC_API_KEY` / `GROQ_API_KEY` in `server/.env`. Choose the provider and model in **Settings → AI & models** (Auto uses Claude when connected, otherwise Groq). Without a key, static analysis, scans, quality gates, sandboxed tests and deterministic agent playbooks still work; AI-only features say so explicitly instead of faking output.

### Production

```bash
APP_SECRET=$(openssl rand -base64 48) NODE_ENV=production npm run build
NODE_ENV=production APP_SECRET=... node server/dist/index.js   # serves web/dist too
```

## Highlights

- **RAG Copilot** — grounded answers about your code with hybrid retrieval and verified citations.
- **Fix Optimizer** — quantum-inspired (simulated quantum annealing on classical hardware) fix planning within a time budget.
- **Live advisory watch, quality gates, auto-sync, signed webhooks, presence and Live Ops** — everything updates in real time over WebSockets.

## Tests

```bash
npm test                                  # server (75) + web (13) suites
npm run test:live --workspace server      # optional live Claude / Groq smoke tests (need ANTHROPIC_API_KEY / GROQ_API_KEY)
npm run typecheck
```

See [docs/TESTING.md](docs/TESTING.md) for what each suite proves.

## Documentation

| Doc | Contents |
| --- | --- |
| [PRODUCT_SPEC](docs/PRODUCT_SPEC.md) | Modules, users, behaviour rules |
| [ARCHITECTURE](docs/ARCHITECTURE.md) | Components, data flow, realtime, jobs |
| [DATABASE_SCHEMA](docs/DATABASE_SCHEMA.md) | Tables and relationships |
| [AGENT_SYSTEM](docs/AGENT_SYSTEM.md) | Agents, tools, workflows, guardrails |
| [SECURITY](docs/SECURITY.md) | Threat model and controls |
| [TESTING](docs/TESTING.md) | Automated suites, manual walkthrough |
| [IMPLEMENTATION_PLAN](docs/IMPLEMENTATION_PLAN.md) | What was built, in what order, and what's next |

## Repository layout

```
server/   Express 5 + SQLite API, analysis engine, job queue, agents, workflows, sandbox
web/      React 19 + Vite app (Tailwind v4, React Three Fiber, Framer Motion)
docs/     Specifications and testing evidence
data/     Runtime data (database, cloned repos, secrets) — git-ignored
```
