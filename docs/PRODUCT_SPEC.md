# Product specification

## Purpose

DevForge AI gives an engineering team an always-on "AI engineering team" for its codebase: it understands the repository, detects defects and risks with evidence, investigates failures, reviews changes, generates and runs tests in isolation, and automates recurring engineering work through agents and workflows.

## Users and roles

| Role | Can |
| --- | --- |
| Owner | Everything, including deleting the workspace |
| Admin | Manage members, settings, integrations, secrets, agent configuration |
| Engineer | Connect repositories, run analyses, investigations, reviews, tests, agents, edit workflows |
| Security | Run analyses, triage findings, decide approvals |
| Viewer | Read-only |

Permissions are enforced in the API (`server/src/auth/rbac.ts`); the UI only hides actions a role cannot perform.

## Non-negotiable behaviour rules

1. **No fabricated data.** Every metric is derived from recorded scans, runs, findings or live measurements. Missing data renders as "—" or an explicit empty state.
2. **No fake success.** Operations report the real outcome (completed / failed / skipped with reason). Tools that are not installed are reported as `not_installed`, never as clean.
3. **Findings carry evidence** (tool, rule, file, line, snippet) and an `origin`: `detected` (by a tool) or `ai_hypothesis`. They are displayed differently.
4. **AI output is never applied automatically.** Patches are proposals; applying requires an explicit user action.
5. **Repository code never runs in the API process.** Tests run only inside the sandbox (Docker or macOS `sandbox-exec`); without one, execution is refused.
6. **Secrets are write-only.** API keys, tokens and webhook secrets are encrypted at rest and never returned by the API or logged.
7. **Only relevant code goes to the LLM.** Context is retrieved (FTS + symbols + graph), bounded by a character budget; sending code to AI can be disabled per workspace.

## Modules

| Module | What it does |
| --- | --- |
| Landing & public site | Product pages with an interactive 3D hero |
| Auth | Email/password, email verification, password reset, sessions, OAuth (GitHub/Google when configured), invitations |
| Onboarding | 9-step resumable wizard: workspace → repository → first analysis |
| Command Center | Live health score (grade A–F, weighted dimensions, history), findings trend, severity mix, recent scans, gate status |
| Projects | Connect (git URL, GitHub, allowed local path), refresh, delete repositories |
| Repository Intelligence | File tree, code viewer, symbols, references, full-text search, commits, AI Q&A with citations |
| Architecture | Module graph (2D/3D), import cycles, hotspots, high-risk files, shortest dependency path |
| Dependency Intelligence | Manifests, versions vs latest, OSV advisories, license data |
| Bug / Security / Performance / Debt | Findings by source with triage workflow, comments, assignment, export |
| Investigations | Stack trace/log parsing → affected code → evidence → ranked hypotheses → proposed fix → verification plan |
| Code Review & Pull Requests | Commit/range/PR/snippet review with risk score; optional AI review |
| Test Forge & Regressions | Branch/edge-case extraction, AI test generation, sandboxed execution, regression comparison |
| AI Agents | 10 specialised agents with tool access, run history, step logs, hand-offs |
| Workflow Studio | Visual DAG editor with scans, agents, conditions, approvals, notifications |
| Quality Gates | Workspace release policy evaluated after every analysis; live notifications on failure/recovery |
| Auto-Sync & Webhooks | Remote polling via `git ls-remote`; HMAC-verified GitHub push webhooks |
| Live Ops | Measured queue, throughput, latency, event-loop lag, memory, DB size, live event stream, presence |
| Analytics, Knowledge Base, Reports, Activity | Trends from recorded data, team docs with search, generated reports, audit log |
| Team, Integrations, Settings, Help | Members & invites, encrypted credentials, AI model/budget/effort, retention |

## Health score

Per repository, from **open detected findings only**, severity-weighted (critical 25, high 10, medium 4, low 1) and normalised per KLOC, capped per dimension:

`score = 0.35·security + 0.30·reliability + 0.25·maintainability + 0.10·performance`

Grades: A ≥ 90, B ≥ 80, C ≥ 65, D ≥ 45, F < 45. A history point is stored after every analysis.
