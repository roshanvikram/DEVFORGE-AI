# Architecture

```
 Browser (React 19 SPA)                      DevForge API (Node 22, Express 5)                 Isolated execution
 ───────────────────────                     ───────────────────────────────────              ──────────────────
 Pages ── TanStack Query ── fetch /api ───▶  auth · CSRF · rate limit · RBAC                 Docker --network none
          (X-Requested-With, X-Workspace-Id) routes ──▶ services ──▶ engine (analysis)        or macOS sandbox-exec
 RealtimeProvider ◀── WebSocket /api/events  job queue (SQLite) ──▶ handlers ─────────────▶  (repo tests only)
   presence, invalidation, toasts            event hub (publish/presence)
                                             agents · workflows · AI provider ──▶ Claude API
 GitHub ── signed push ──▶ /api/hooks/github/:repo (HMAC, before CSRF guard)
                                             SQLite (WAL, FTS5) · data/repos · data/sandbox
```

## Server (`server/src`)

| Layer | Files | Notes |
| --- | --- | --- |
| Entry | `index.ts`, `app.ts`, `config.ts` | Security headers, JSON body (raw body kept for signatures), session loading, CSRF guard, rate limit, routers, error mapping |
| Auth | `auth/` | scrypt passwords, sha256-hashed session tokens in an httpOnly cookie, lockout, OAuth, RBAC |
| Routes | `routes/*.ts` | `workspaces`, `repositories`, `findings`, `jobs` (+ dashboard, capabilities), `platform` (investigations, reviews, tests, agents, workflows, KB, reports, settings, integrations…), `realtime` (health, gates, watch, webhooks, presence, live ops) |
| Engine | `engine/` | Ingestion (SSRF-guarded clone, safe git flags), indexer (files, symbols, edges, FTS), TS/JS AST + Python AST analyzers, pattern & secret rules, debt metrics, graph algorithms, dependency parsing + OSV, optional external tools |
| Services | `services/` | Analysis pipeline, findings persistence/fingerprints, metrics, search/retrieval, investigations, reviews, Test Forge, integrations, realtime (health history, gates, auto-sync, webhooks) |
| Jobs | `jobs/queue.ts` | SQLite-persisted queue, concurrency `JOB_CONCURRENCY`, progress (throttled), logs, cancel/retry, restart recovery, `runInline` for workflows |
| AI | `ai/provider.ts` | Provider interface with Claude (`@anthropic-ai/sdk`, streaming) and Groq (OpenAI-compatible chat completions; tools and JSON mode translated) — chosen per workspace (auto / anthropic / groq); structured outputs; usage & cost accounting; per-workspace rate limit and monthly budget; error mapping |
| Agents | `agents/` | Definitions, tool registry, runner (AI tool loop or deterministic playbook) |
| Workflows | `workflows/engine.ts` | DAG validation, node execution, conditions, approvals (pause/resume), retries |
| Sandbox | `sandbox/runner.ts` | Mode detection, workdir copy without `.git`, Docker or `sandbox-exec` profile |
| Realtime | `lib/events.ts` | Workspace-scoped WebSocket hub, presence, counters |

### Analysis pipeline (`repo.import` job)

1. Fetch — clone/pull (allow-listed https host, public DNS only, hooks disabled, no submodules) or copy an allowed local path.
2. Index — walk files (size/count limits), language detection, symbols and import edges, FTS5 content index; snapshots keep the last 5.
3. Analyse — per selected scan kind: AST rules, regex security/secret rules, debt metrics + duplicates + cycles, typecheck, dependency manifests → OSV/registry, optional external tools (each reports `ok`/`not_installed`/`failed`).
4. Persist — fingerprinted findings (new / still open / auto-resolved only when the tool ran `ok`), scan summaries.
5. Post-analysis — health history point, quality-gate evaluation, notifications, realtime events.

### Realtime

`publish(workspaceId, event)` fans out JSON events to every socket of that workspace. Event types: `job`, `job.log`, `scan`, `repository`, `health`, `gate`, `watch`, `webhook`, `presence`, `agent_run`, `agent_step`, `test_run`, `review`, `investigation`, `workflow_execution`, `notification`, `activity`. The client invalidates the matching queries, so screens update without polling. Clients report their current in-app path for presence (validated against `^/app[\w\-/]*$`).

### Auto-sync and webhooks

A 30 s watcher picks up to 5 due repositories (`watch_enabled`, interval elapsed), runs `git ls-remote` and enqueues a refresh only when the remote head differs from the analysed commit. Webhook deliveries are verified with HMAC-SHA256 in constant time, filtered to the tracked branch, de-duplicated against running analyses, and logged.

## Web (`web/src`)

| Area | Files |
| --- | --- |
| Shell | `App.tsx` (lazy routes, auth gate), `components/AppShell.tsx` (sidebar, ⌘K palette, notifications, presence) |
| Data | `lib/api.ts` (fetch wrapper), `lib/auth.tsx`, `lib/repo.tsx`, `lib/realtime.tsx` |
| UI kit | `components/ui.tsx` (Panel, Stat, HealthRing, Tabs, Modal, CodeBlock…), `components/health.tsx`, `components/jobs.tsx` |
| 3D | `components/three/` (hero, repository graph) — lazy loaded with a static fallback |
| Pages | `pages/public/*`, `pages/Onboarding.tsx`, `pages/app/*` |

Design tokens live in `styles.css` (`@theme`): pearl/ivory surfaces, silver lines, amber accent.

## Deployment

`npm run build` compiles the server to `server/dist` and the SPA to `web/dist`; in production the API also serves the SPA. Run one API process per data directory (SQLite + in-process queue). Put it behind TLS with `TRUST_PROXY=1`, set `APP_SECRET`, `APP_URL`, and choose `SANDBOX_MODE=docker` on Linux.
