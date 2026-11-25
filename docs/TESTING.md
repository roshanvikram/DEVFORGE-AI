# Testing

## Automated suite

```bash
npm test --workspace server
```

`server/test/platform.test.ts` runs against the real stack. Nothing is mocked:

- the Express app is exercised over HTTP with supertest;
- a throwaway SQLite database lives in `data/test-<pid>` and is deleted afterwards;
- the job queue and full analysis pipeline run on repositories generated into the OS temp directory (the only allowed `LOCAL_IMPORT_ROOTS` during tests);
- presence is tested over a live WebSocket server.

The secret values in the fixtures are built at runtime, so the source never contains a literal credential pattern.

**Latest run: 39 / 39 passed** (about 3 s). The run used `OSV_ENABLED=false` and `SANDBOX_MODE=disabled`, so it needs no network and executes no repository code.

| Area | Tests | What is proven |
| --- | --- | --- |
| Auth | 7 | CSRF header and origin checks, password policy, duplicate signup, login success/failure, hashed session storage, auth required |
| Tenancy & RBAC | 2 | Another workspace's repository is not reachable even with a forged `X-Workspace-Id`; role permissions enforced server-side |
| Ingestion safety | 3 | Private/loopback IP detection (SSRF), git URL validation, local import root restriction |
| Analysis engine | 7 | Full analysis job, SQL injection / eval / unsafe deserialization detection, secret detection with masking, zero security findings on a clean repo, FTS search, path traversal blocked, architecture graph |
| Findings | 2 | Status update with audit event, invalid status rejected |
| Health history (new) | 2 | A history point is recorded per analysis; delta on re-scan |
| Quality gates (new) | 4 | Failing and passing evaluations, failure notification, threshold validation |
| Auto-sync & webhooks (new) | 4 | Local repos cannot be watched, constant-time HMAC verification, signed vs forged deliveries, secret stored encrypted and never returned, 404 for unconfigured hooks |
| Presence & Live Ops (new) | 3 | Presence broadcast over WebSocket, unauthenticated sockets rejected, measured ops metrics |
| Secrets | 3 | AES-GCM round trip and tamper detection, log redaction, integrations API never returns keys |
| Dashboard | 2 | Counts match the findings table; empty state for a new workspace |

Both packages also pass type checking (`npm run typecheck`), and `web` builds for production (`npm run build --workspace web`).

## Recorded walkthrough

[`docs/media/devforge-testing-walkthrough.mp4`](media/devforge-testing-walkthrough.mp4) is a 55 s, 1280×800 H.264 video of a manual test pass in the browser. Every frame is a screenshot of the running local build:

1. Sign in.
2. Command Center: health score with grade, weighted dimensions and live presence.
3. Quality gate: a strict policy is saved and evaluated. It fails on a score of 99 against a limit of 100, and a notification arrives.
4. Live Ops: a refresh is triggered, and the job, scan, health, gate and notification events stream in as they happen.
5. Auto-sync: `git ls-remote` runs against github.com and finds the remote head equal to the analysed commit.
6. Signed webhooks: a ping returns 200 and a forged signature 401. A push to a feature branch is ignored; a push to master queues an analysis.
7. Health history and gate status on the Command Center.
8. Automated test results.

The machine did not allow screen recording (macOS permission), so the video is a sequence of captioned screenshots, not a continuous capture.

## Not covered yet

- AI-dependent paths (agent tool loops, AI review, test generation, Q&A). They need a Claude API key and have not been run against the live API.
- Running a repository's own tests inside the sandbox (`sandbox-exec` / Docker). This is disabled in the automated suite.
- Frontend component tests. The UI is verified manually, as in the walkthrough.
