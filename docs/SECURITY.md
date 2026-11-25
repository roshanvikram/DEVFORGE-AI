# Security

## Threat model

DevForge ingests **untrusted repositories**, stores **credentials** (AI keys, GitHub tokens, webhook secrets), accepts **inbound webhooks**, and serves **multiple tenants**. The main risks: code execution from a repository, SSRF through repository/webhook URLs, credential disclosure, cross-tenant access, CSRF, and prompt-injection through repository content.

## Controls

### Authentication and sessions
- Passwords hashed with scrypt; minimum 10 characters with letters and digits.
- Session tokens are random; only their sha256 hash is stored. Cookie `df_session` is `httpOnly`, `SameSite=Lax`, `Secure` in production.
- Login rate limits per IP and per email; account lockout after repeated failures.
- Email verification and password-reset tokens are hashed and expire.

### Authorization and tenancy
- Every workspace route passes `requireWorkspace` (membership check) and `requirePerm` (role → permission map in `auth/rbac.ts`). The UI only mirrors these checks.
- All domain queries filter by `workspace_id`; tests prove a forged `X-Workspace-Id` is rejected.
- WebSocket connections require a valid session and workspace membership.

### Request integrity
- CSRF: state-changing requests must send `X-Requested-With: devforge` and, if present, an allowed `Origin`.
- Webhooks are the only cookie-less write endpoint and authenticate by HMAC-SHA256 over the raw body (constant-time compare); unknown or unconfigured repositories return the same 404.
- Global API rate limit, per-feature limits (registration, AI, webhooks, remote checks), body size limit.
- Security headers: `nosniff`, `X-Frame-Options: DENY`, strict referrer policy, permissions policy, HSTS in production.

### Repository ingestion (SSRF and git hardening)
- https only, allow-listed hosts, no credentials in URLs, no custom ports, IP-literal hosts rejected, DNS resolved and private/loopback/link-local/CGNAT ranges blocked.
- git runs with hooks disabled, `protocol.file/ext` disabled, symlinks off, no submodules, depth-limited clones, size and file-count limits.
- Local imports only from explicit `LOCAL_IMPORT_ROOTS` (realpath-checked).

### Executing repository code
- Never in the API process and never with the server's environment.
- **Docker:** `--network none` (network only for the optional install step), `--cap-drop ALL`, `no-new-privileges`, memory/CPU/PID limits, workdir mount only.
- **macOS:** `sandbox-exec` profile — no network, writes only inside a throwaway workdir, reads of `~/.ssh`, `~/.aws`, keychains, `.env` files and DevForge's data directory denied (metadata only, so paths resolve).
- Minimal environment (`PATH`, `HOME`/`TMPDIR` inside the workdir, `CI=1`); timeout with process-group kill; workdir deleted afterwards.
- Without Docker or `sandbox-exec`, execution is refused (`SANDBOX_MODE=disabled`).
- Verified by `server/test/sandbox.test.ts`: network blocked, writes outside blocked, data-dir reads blocked, env not leaked.

### Secrets
- Stored with AES-256-GCM using a key derived from `APP_SECRET` (required in production; auto-generated with mode 0600 in development).
- Never returned by the API (only `last4`/"configured"); webhook secrets are shown exactly once on creation.
- Logs and job output pass through a redactor for common token formats; AI usage errors are redacted.
- Detected secrets in scanned repositories are masked in findings.

### AI-specific
- Only retrieved, budget-limited code excerpts are sent; workspace setting can forbid sending code.
- Repository content is treated as data in prompts; agent tools are read-only (no writes to the repository, no patch application, no network tools).
- AI output is labelled (`ai_hypothesis`), cited files are verified to exist, and fixes require human action.
- Monthly budget and per-minute rate limit per workspace.

## Reporting

Report vulnerabilities privately to the repository owner rather than in public issues.
