# Database schema

SQLite (better-sqlite3) in WAL mode with foreign keys on. Migrations live in `server/src/db/migrations` and run automatically at start-up (`_migrations` records applied files). Timestamps are ISO-8601 UTC strings. JSON columns are stored as TEXT.

## Identity and tenancy

| Table | Purpose | Key columns |
| --- | --- | --- |
| `users` | Accounts | `email` (unique), `password_hash` (scrypt), `failed_logins`, `locked_until`, `email_verified_at` |
| `oauth_accounts` | Linked GitHub/Google identities | `provider`, `provider_user_id`, encrypted token |
| `sessions` | Login sessions | `token_hash` (sha256 — raw token only in the cookie), `expires_at`, `active_workspace_id` |
| `auth_tokens` | Email verification / password reset | hashed token, purpose, expiry |
| `organizations` → `workspaces` | Tenancy | every domain row carries `workspace_id` |
| `memberships` | User ↔ workspace with `role` | unique (workspace, user) |
| `invitations` | Pending invites | hashed token, role, expiry |
| `onboarding`, `user_preferences` | Wizard progress, UI preferences | |

## Code and analysis

| Table | Purpose |
| --- | --- |
| `repositories` | Source (`git`/`github`/`local`), status, languages, frameworks, `current_snapshot_id`; auto-sync (`watch_*`) and webhook (`webhook_secret` encrypted) columns |
| `snapshots` | One per indexed commit (last 5 kept): commit, file count, LOC, stats |
| `files`, `symbols`, `edges` | Indexed files, declarations, import/call edges (graph) |
| `code_fts` | FTS5 index of file contents per snapshot |
| `dependencies` | Parsed manifests: versions, latest, licence, OSV advisories |
| `scans` | One per scan kind run: tool statuses, summary, timings |
| `findings` | Unique per (repository, review, fingerprint): source, origin (`detected`/`ai_hypothesis`), tool, rule, severity, confidence, location, evidence, recommendation, status, assignee |
| `finding_events`, `comments` | Triage history and discussion |
| `health_history` | Score + four dimensions + counts recorded after each analysis |
| `quality_gates`, `gate_results` | Workspace policy and each evaluation (checks JSON, trigger) |
| `webhook_deliveries` | Every webhook request: event, status (`ok`/`queued`/`ignored`/`deduplicated`/`rejected`), detail |

## Work and automation

| Table | Purpose |
| --- | --- |
| `jobs`, `job_logs` | Persistent queue: type, payload, status, progress, attempts, result/error; redacted logs |
| `investigations` | Input, parsed error, affected code, evidence, hypotheses, proposed fix, verification, timeline |
| `reviews`, `pull_requests` | Review runs (commit/range/PR/snippet) with risk score; tracked PRs |
| `test_runs` | Generated or suite runs: framework, command, files, counts, failures, output, analysis |
| `agent_configs`, `agent_runs`, `agent_steps` | Per-workspace agent settings, runs (tokens, cost, output), step log (plan, tool calls, results) |
| `workflows`, `workflow_executions`, `approvals` | DAG definitions, executions with node states, pending/decided approvals |

## Platform

| Table | Purpose |
| --- | --- |
| `integrations` | Encrypted credentials per workspace/provider (`anthropic`, `github`, `slack`, `webhook`) + last4 |
| `workspace_settings` | AI model/effort/budget, analysis defaults, notifications, retention |
| `api_keys` | Hashed API keys with role |
| `notifications` | Per-user in-app notifications |
| `activity_logs` | Audit trail (actor, action, entity, data, IP) |
| `reports`, `knowledge_docs`, `kb_fts` | Generated reports, knowledge base with FTS |
| `ai_usage` | Every AI call: feature, model, tokens, cost, ok/error, duration |
| `chat_messages` | Repository Q&A history with citations |

## Indexes worth knowing

Repository-scoped queries (health, dashboard, trends) use `idx_findings_repo_status (repository_id, review_id, status, source, severity)`, `idx_findings_repo_first_seen`, `idx_findings_repo_resolved`; jobs use `idx_jobs_status`, `idx_jobs_ws_status`; history tables are indexed by `(repository_id, created_at)`.
